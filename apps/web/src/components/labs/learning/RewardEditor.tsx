import { useRef, useState } from "react";
import { learningRef, rewardFixtureFromRating, TaskRatingSchema, type TaskEvidence, type TaskFeedback, type AuthoringDraftFor } from "openpond-sdk/learning";
import { useAuthoringDraft } from "./useAuthoringDraft";
import {
  compileRewardAuthoring, compileRewardFixtures, rewardAuthoringFields, RewardCheckRunSchema, RewardReleaseSchema,
  type LearningTextAsset, type OpenPondLearningClient, type RewardRelease,
} from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { useDraftNavigation } from "../useDraftNavigation";
import { LearningActions, LearningError, LearningJsonField } from "./LearningFields";
import { useLearningMutation, useLearningResource } from "./useLearningResources";
import { RewardFixturesEditor } from "./RewardFixturesEditor";
import { RewardCheckHistory } from "./RewardCheckHistory";

type Kind = RewardRelease["implementation"]["kind"];
const KINDS: Array<{ value: Kind; label: string }> = [
  { value: "custom_verifier", label: "Code verifier · JavaScript" },
  { value: "state", label: "Code verifier · Exact fields" },
  { value: "content", label: "Code verifier · Text answer" },
  { value: "schema", label: "Code verifier · Output schema" },
  { value: "artifact", label: "Code verifier · Artifact reference" },
  { value: "runtime_event", label: "Code verifier · Runtime events" },
  { value: "model_judge", label: "LLM judge" },
  { value: "learned_model", label: "Learned reward model" },
  { value: "human", label: "Human review rubric" },
];

export function RewardEditor(props: { fromLabel?: { evidence: TaskEvidence; feedback: TaskFeedback }; authoringDraft?: AuthoringDraftFor<"reward">; client: OpenPondLearningClient | null; reward: RewardRelease | null; onSaved: (reward: RewardRelease) => void; onClose: () => void }) {
  const implementation = props.reward?.implementation;
  const assetId = implementation && "verifierRef" in implementation ? implementation.verifierRef.id
    : implementation && "rubricRef" in implementation ? implementation.rubricRef.id
    : implementation && "inputContract" in implementation ? implementation.inputContract.id : null;
  const asset = useLearningResource(props.client, "asset", assetId, 1);
  const fixtures = useLearningResource(props.client, "asset", props.reward?.fixtureSetRef?.id ?? null, 1);
  if ((assetId && !asset.resource) || (props.reward?.fixtureSetRef && !fixtures.resource)) return <div className="labs-flat-body labs-resource-page learning-workspace"><LearningError error={asset.error ?? fixtures.error} /><p role="status">{asset.error || fixtures.error ? "Reward source is unavailable. Reload its exact release to edit it." : "Loading Reward source…"}</p><button type="button" className="training-button secondary" onClick={props.onClose}>Back</button></div>;
  return <RewardEditorForm {...props} sourceAsset={asset.resource} fixtureAsset={fixtures.resource} />;
}

function RewardEditorForm({ client, reward, sourceAsset, fixtureAsset, authoringDraft, fromLabel, onSaved, onClose }: {
  fromLabel?: { evidence: TaskEvidence; feedback: TaskFeedback };
  authoringDraft?: AuthoringDraftFor<"reward">;
  client: OpenPondLearningClient | null; reward: RewardRelease | null; sourceAsset: LearningTextAsset | null; fixtureAsset: LearningTextAsset | null;
  onSaved: (reward: RewardRelease) => void; onClose: () => void;
}) {
  const [id] = useState(() => authoringDraft?.targetId ?? reward?.id ?? `reward-${crypto.randomUUID()}`);
  const [initial] = useState(() => {
    const fields = rewardAuthoringFields(reward, sourceAsset, fixtureAsset);
    if (!fromLabel) return fields;
    const fixture = rewardFixtureFromRating(fromLabel.evidence, fromLabel.feedback, reward?.rawScore);
    const rating = TaskRatingSchema.parse(fromLabel.feedback.submission.value);
    return { ...fields, ...(!reward ? { name: `Reward for ${fromLabel.evidence.submission.exampleId}`, kind: "model_judge" as const, rubric: rating.criteria } : {}), fixtures: [...(fields.fixtures ?? []).filter(item => item.id !== fixture.id), fixture] };
  });
  const [draft, setDraft] = useState(authoringDraft?.fields ?? initial);
  const [saved, setSaved] = useState(JSON.stringify(authoringDraft?.fields ?? initial));
  const [revision, setRevision] = useState(reward?.revision ?? 0);
  const mutation = useLearningMutation(client);
  const [pendingAction, setPendingAction] = useState<"save" | "check" | "publish" | null>(null);
  function runAction<T>(action: "save" | "check" | "publish", execute: (api: OpenPondLearningClient) => Promise<T>) {
    return mutation.run(async api => {
      setPendingAction(action);
      try { return await execute(api); } finally { setPendingAction(null); }
    });
  }
  const persistence = useAuthoringDraft(authoringDraft);
  const checkRequest = useRef<{ draftHash: string; operationId: string } | null>(null);
  const draftInput = () => ({ targetKind: "reward" as const, targetId: id, baseRelease: reward ? learningRef(reward) : null, fields: draft });
  async function saveDraft() {
    const result = await runAction("save", api => persistence.save(api, draftInput()));
    if (result) setSaved(JSON.stringify(draft));
    return Boolean(result);
  }
  const patch = (update: Partial<typeof draft>) => setDraft((value) => ({ ...value, ...update }));

  async function save() {
    const result = await runAction("publish", async (api) => {
      if (draft.fixtures?.length) compileRewardFixtures(draft.fixtures);
      const { reward: release, assets } = compileRewardAuthoring({ id, fields: draft, base: reward });
      const { contentHash: _hash, ...content } = release;
      const storedDraft = await persistence.save(api, draftInput());
      const finalizeDraft = persistence.finalization(storedDraft, release);
      const operationId = `reward:${release.contentHash}`;
      const response = await api.command({ action: "publish_resources", operationId, finalizeDraft, resources: [
        ...assets.map(({ contentHash: _assetHash, ...content }) => ({ kind: "asset" as const, expectedRevision: 0, content })),
        { kind: "reward", expectedRevision: revision, content },
      ] });
      return RewardReleaseSchema.parse(response.resources.find((resource) => resource.schemaVersion === "openpond.rewardRelease.v1"));
    });
    if (!result) return null;
    setRevision(result.revision); setSaved(JSON.stringify(draft)); return result;
  }
  async function checkFixtures() {
    return runAction("check", async api => {
      compileRewardFixtures(draft.fixtures ?? []);
      compileRewardAuthoring({ id, fields: draft, base: reward });
      const record = await persistence.save(api, draftInput());
      setSaved(JSON.stringify(draft));
      const request = checkRequest.current?.draftHash === record.contentHash ? checkRequest.current : { draftHash: record.contentHash, operationId: crypto.randomUUID() };
      checkRequest.current = request;
      const response = await api.command({ action: "queue_reward_check", operationId: request.operationId, draft: learningRef(record), timeoutMs: 300_000, maximumSpendUsd: 0 });
      const result = RewardCheckRunSchema.parse(response.resources[0]);
      checkRequest.current = null;
      return result;
    });
  }
  const guard = useDraftNavigation({ name: "Reward", dirty: JSON.stringify(draft) !== saved, busy: mutation.busy, save: saveDraft });
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title={reward ? "Edit Reward" : "New Reward"} description="Save the grader and its source as an immutable release. Task formats keep the release they selected." />
    <LearningError error={mutation.error} />
    {persistence.record ? <p role="status">{saved === JSON.stringify(draft) ? `Draft saved · revision ${persistence.record.revision}` : "Unsaved changes"}</p> : null}
    <label>Name<input maxLength={500} value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></label>
    <label>Description (optional)<textarea maxLength={10_000} value={draft.description} onChange={(event) => patch({ description: event.target.value })} /></label>
    <label>Reward type<select value={draft.kind} onChange={(event) => patch({ kind: event.target.value as Kind })}>{KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select></label>
    {draft.kind === "custom_verifier" ? <>
      <LearningJsonField label="JavaScript source" value={draft.code} onChange={(code) => patch({ code })} hint="Export a function returning score (0–1), passed, and feedback. It receives input, output, expectedOutput and evaluatorContext. Files, network and imports are unavailable." />
      <label>Function export<input value={draft.exportName} onChange={(event) => patch({ exportName: event.target.value })} /></label>
      <label>Time limit (milliseconds)<input type="number" min={1} max={300_000} value={draft.timeout} onChange={(event) => patch({ timeout: event.target.value })} /></label>
    </> : null}
    {draft.kind === "state" ? <label>Fields to compare<input value={draft.fields} onChange={(event) => patch({ fields: event.target.value })} /><small>Enter JSON field names, separated by commas. For example, answer compares the model’s output.answer with the example’s expectedOutput.answer. Every selected field must match exactly.</small></label> : null}
    {draft.kind === "content" ? <><label>Output field<input value={draft.outputField} onChange={(event) => patch({ outputField: event.target.value })} /></label><label>Expected field<input value={draft.expectedField} onChange={(event) => patch({ expectedField: event.target.value })} /></label><label>Fixed expected text (optional)<input value={draft.expectedValue} onChange={(event) => patch({ expectedValue: event.target.value })} /></label></> : null}
    {draft.kind === "schema" ? <LearningJsonField label="Output JSON Schema" value={draft.schema} onChange={(schema) => patch({ schema })} /> : null}
    {draft.kind === "artifact" ? <label>Required artifact reference<input value={draft.reference} onChange={(event) => patch({ reference: event.target.value })} /></label> : null}
    {draft.kind === "runtime_event" ? <label>Required events<input value={draft.events} onChange={(event) => patch({ events: event.target.value })} /><small>Separate event references with commas.</small></label> : null}
    {draft.kind === "model_judge" || draft.kind === "human" ? <label>Rubric<textarea rows={10} value={draft.rubric} onChange={(event) => patch({ rubric: event.target.value })} /></label> : null}
    {draft.kind === "model_judge" ? <><label>Model provider<input value={draft.providerId} onChange={(event) => patch({ providerId: event.target.value })} /></label><label>Judge model<input value={draft.modelId} onChange={(event) => patch({ modelId: event.target.value })} /></label><label>Model revision (optional)<input value={draft.modelRevision} onChange={(event) => patch({ modelRevision: event.target.value })} /></label><label>Temperature<input type="number" min={0} max={2} step={0.1} value={draft.temperature} onChange={(event) => patch({ temperature: event.target.value })} /></label><p>Changing the rubric or model requires calibration before this judge can grade examples.</p></> : null}
    {draft.kind === "human" ? <label>Reviewer role<input value={draft.reviewerRole} onChange={(event) => patch({ reviewerRole: event.target.value })} /></label> : null}
    {draft.kind === "learned_model" ? <><label>Model version<input value={draft.learnedId} onChange={(event) => patch({ learnedId: event.target.value })} /></label><label>Model version content hash<input value={draft.learnedHash} onChange={(event) => patch({ learnedHash: event.target.value })} /></label><LearningJsonField label="Model input contract" value={draft.inputContract} onChange={(inputContract) => patch({ inputContract })} /><label>Raw score minimum<input type="number" value={draft.minimum} onChange={(event) => patch({ minimum: event.target.value })} /></label><label>Raw score maximum<input type="number" value={draft.maximum} onChange={(event) => patch({ maximum: event.target.value })} /></label></> : null}
    <RewardFixturesEditor fixtures={draft.fixtures ?? []} onChange={fixtures => patch({ fixtures })} />
    <RewardCheckHistory client={client} targetId={id} draft={persistence.record?.targetKind === "reward" ? persistence.record : null} unchanged={JSON.stringify(draft) === JSON.stringify(persistence.record?.fields)} busy={mutation.busy || !draft.fixtures?.length} onCheck={checkFixtures} checking={pendingAction === "check"} />
    <LearningActions><button type="button" className="training-button secondary" disabled={mutation.busy} onClick={() => { void guard.requestLeave(onClose); }}>Cancel</button><button type="button" className="training-button secondary" disabled={mutation.busy} onClick={() => { void saveDraft(); }}>{pendingAction === "save" ? "Saving draft…" : "Save draft"}</button><button type="button" className="training-button" disabled={mutation.busy || !draft.name.trim()} onClick={async () => { const result = await save(); if (result) { guard.allowNextNavigation(); onSaved(result); } }}>{pendingAction === "publish" ? "Publishing…" : `Publish release ${revision + 1}`}</button></LearningActions>
    {guard.dialog}
  </div>;
}
