import { useState } from "react";
import {
  createLearningTextAsset, RewardReleaseContentSchema, RewardReleaseSchema, sealLearningContent,
  type LearningTextAsset, type OpenPondLearningClient, type RewardRelease,
} from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { useDraftNavigation } from "../useDraftNavigation";
import { LearningActions, LearningError, LearningJsonField, parseLearningObject } from "./LearningFields";
import { useLearningMutation, useLearningResource } from "./useLearningResources";

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
const DEFAULT_CODE = `export function verify({ output, expectedOutput }) {
  if (!expectedOutput || !Object.hasOwn(expectedOutput, "answer")) {
    throw new Error("An expected answer is required.");
  }
  const passed = output.answer === expectedOutput.answer;
  return { score: passed ? 1 : 0, passed, feedback: passed ? "Answer matched" : "Answer differed" };
}`;

export function RewardEditor(props: { client: OpenPondLearningClient | null; reward: RewardRelease | null; onSaved: (reward: RewardRelease) => void; onClose: () => void }) {
  const implementation = props.reward?.implementation;
  const assetId = implementation && "verifierRef" in implementation ? implementation.verifierRef.id
    : implementation && "rubricRef" in implementation ? implementation.rubricRef.id
    : implementation && "inputContract" in implementation ? implementation.inputContract.id : null;
  const asset = useLearningResource(props.client, "asset", assetId, 1);
  if (assetId && !asset.resource) return <div className="labs-flat-body labs-resource-page learning-workspace"><LearningError error={asset.error} /><p role="status">{asset.error ? "Reward source is unavailable. Reload its exact release to edit it." : "Loading Reward source…"}</p><button type="button" className="training-button secondary" onClick={props.onClose}>Back</button></div>;
  return <RewardEditorForm {...props} sourceAsset={asset.resource} />;
}

function RewardEditorForm({ client, reward, sourceAsset, onSaved, onClose }: {
  client: OpenPondLearningClient | null; reward: RewardRelease | null; sourceAsset: LearningTextAsset | null;
  onSaved: (reward: RewardRelease) => void; onClose: () => void;
}) {
  const [id] = useState(() => reward?.id ?? `reward-${crypto.randomUUID()}`);
  const implementation = reward?.implementation;
  const config = implementation && "config" in implementation ? implementation.config : {};
  const initial = {
    name: reward?.name ?? "", description: reward?.description ?? "", kind: implementation?.kind ?? "state" as Kind,
    fields: strings(config.fields).join(", ") || "answer", outputField: text(config.outputField) || "text", expectedField: text(config.expectedField) || "text", expectedValue: text(config.expectedValue),
    schema: JSON.stringify(config.jsonSchema ?? { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }, null, 2),
    reference: text(config.refIncludes), events: strings(config.requiredEvents).join(", "),
    code: implementation?.kind === "custom_verifier" ? sourceAsset?.text ?? "" : DEFAULT_CODE,
    exportName: implementation?.kind === "custom_verifier" ? implementation.exportName ?? "verify" : "verify",
    timeout: String(implementation?.kind === "custom_verifier" ? implementation.timeoutMs : 5_000),
    rubric: implementation?.kind === "model_judge" || implementation?.kind === "human" ? sourceAsset?.text ?? "" : "",
    providerId: implementation?.kind === "model_judge" ? implementation.model?.providerId ?? "" : "",
    modelId: implementation?.kind === "model_judge" ? implementation.model?.modelId ?? "" : "",
    modelRevision: implementation?.kind === "model_judge" ? implementation.model?.revision ?? "" : "",
    temperature: String(implementation?.kind === "model_judge" ? implementation.temperature ?? 0 : 0),
    reviewerRole: implementation?.kind === "human" ? implementation.reviewerRole : "Subject matter reviewer",
    learnedId: implementation?.kind === "learned_model" ? implementation.modelVersion.id : "",
    learnedHash: implementation?.kind === "learned_model" ? implementation.modelVersion.contentHash : "",
    inputContract: implementation?.kind === "learned_model" ? sourceAsset?.text ?? "{}" : "{}",
    minimum: String(reward?.rawScore.minimum ?? 0), maximum: String(reward?.rawScore.maximum ?? 1),
  };
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [revision, setRevision] = useState(reward?.revision ?? 0);
  const mutation = useLearningMutation(client);
  const patch = (update: Partial<typeof draft>) => setDraft((value) => ({ ...value, ...update }));

  async function save() {
    const result = await mutation.run(async (api) => {
      let asset: LearningTextAsset | null = null;
      let grader: RewardRelease["implementation"];
      if (draft.kind === "custom_verifier") {
        asset = createLearningTextAsset({ text: draft.code, path: "verifier.mjs", mediaType: "application/javascript", visibility: "verifier" });
        grader = { kind: draft.kind, verifierRef: asset.asset, exportName: draft.exportName, timeoutMs: Number(draft.timeout), networkPolicy: "none" };
      } else if (draft.kind === "model_judge" || draft.kind === "human") {
        if (!draft.rubric.trim()) throw new Error("Write the rubric before publishing this Reward.");
        asset = createLearningTextAsset({ text: draft.rubric, path: "rubric.md", mediaType: "text/markdown", visibility: "verifier" });
        if (draft.kind === "human") grader = { kind: draft.kind, rubricRef: asset.asset, reviewerRole: draft.reviewerRole };
        else {
          const model = { providerId: draft.providerId, modelId: draft.modelId, revision: draft.modelRevision.trim() || null };
          const unchanged = implementation?.kind === "model_judge" && implementation.rubricRef.contentHash === asset.asset.contentHash && JSON.stringify(implementation.model) === JSON.stringify(model) && (implementation.temperature ?? 0) === Number(draft.temperature);
          grader = { kind: draft.kind, rubricRef: asset.asset, model, temperature: Number(draft.temperature), calibrationStatus: unchanged ? implementation.calibrationStatus : "pending" };
        }
      } else if (draft.kind === "learned_model") {
        parseLearningObject(draft.inputContract);
        asset = createLearningTextAsset({ text: draft.inputContract, path: "input-contract.json", mediaType: "application/json", visibility: "verifier" });
        grader = { kind: draft.kind, modelVersion: { id: draft.learnedId, contentHash: draft.learnedHash }, inputContract: asset.asset };
      } else if (draft.kind === "state") grader = { kind: draft.kind, config: { fields: split(draft.fields) } };
      else if (draft.kind === "content") grader = { kind: draft.kind, config: { outputField: draft.outputField, expectedField: draft.expectedField, ...(draft.expectedValue ? { expectedValue: draft.expectedValue } : {}) } };
      else if (draft.kind === "schema") grader = { kind: draft.kind, config: { jsonSchema: parseLearningObject(draft.schema) } };
      else if (draft.kind === "artifact") grader = { kind: draft.kind, config: { refIncludes: draft.reference } };
      else grader = { kind: draft.kind, config: { requiredEvents: split(draft.events) } };
      const content = RewardReleaseContentSchema.parse({ schemaVersion: "openpond.rewardRelease.v1", id, revision: revision + 1, name: draft.name, description: draft.description, implementation: grader, rawScore: draft.kind === "learned_model" ? { minimum: Number(draft.minimum), maximum: Number(draft.maximum) } : { minimum: 0, maximum: 1 }, assets: asset ? [asset.asset] : [] });
      const operationId = `reward:${sealLearningContent(content).contentHash}`;
      const response = asset
        ? await api.command({ action: "publish_resources", operationId, resources: [{ kind: "asset", expectedRevision: 0, content: { schemaVersion: asset.schemaVersion, id: asset.id, revision: asset.revision, asset: asset.asset, text: asset.text } }, { kind: "reward", expectedRevision: revision, content }] })
        : await api.command({ action: "publish", operationId, kind: "reward", expectedRevision: revision, content });
      return RewardReleaseSchema.parse(response.resources.find((resource) => resource.schemaVersion === "openpond.rewardRelease.v1"));
    });
    if (!result) return null;
    setRevision(result.revision); setSaved(JSON.stringify(draft)); return result;
  }
  const guard = useDraftNavigation({ name: "Reward", dirty: JSON.stringify(draft) !== saved, busy: mutation.busy, save: async () => Boolean(await save()) });
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title={reward ? "Edit Reward" : "New Reward"} description="Save the grader and its source as an immutable release. Task formats keep the release they selected." />
    <LearningError error={mutation.error} />
    <label>Name<input maxLength={500} value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></label>
    <label>Description<textarea maxLength={10_000} value={draft.description} onChange={(event) => patch({ description: event.target.value })} /></label>
    <label>Reward type<select value={draft.kind} onChange={(event) => patch({ kind: event.target.value as Kind })}>{KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select></label>
    {draft.kind === "custom_verifier" ? <>
      <LearningJsonField label="JavaScript source" value={draft.code} onChange={(code) => patch({ code })} hint="Export a function returning score (0–1), passed, and feedback. It receives input, output, expectedOutput and evaluatorContext. Files, network and imports are unavailable." />
      <label>Function export<input value={draft.exportName} onChange={(event) => patch({ exportName: event.target.value })} /></label>
      <label>Time limit (milliseconds)<input type="number" min={1} max={300_000} value={draft.timeout} onChange={(event) => patch({ timeout: event.target.value })} /></label>
    </> : null}
    {draft.kind === "state" ? <label>Fields to compare<input value={draft.fields} onChange={(event) => patch({ fields: event.target.value })} /><small>Separate field names with commas. Values are compared against each example’s expected output.</small></label> : null}
    {draft.kind === "content" ? <><label>Output field<input value={draft.outputField} onChange={(event) => patch({ outputField: event.target.value })} /></label><label>Expected field<input value={draft.expectedField} onChange={(event) => patch({ expectedField: event.target.value })} /></label><label>Fixed expected text (optional)<input value={draft.expectedValue} onChange={(event) => patch({ expectedValue: event.target.value })} /></label></> : null}
    {draft.kind === "schema" ? <LearningJsonField label="Output JSON Schema" value={draft.schema} onChange={(schema) => patch({ schema })} /> : null}
    {draft.kind === "artifact" ? <label>Required artifact reference<input value={draft.reference} onChange={(event) => patch({ reference: event.target.value })} /></label> : null}
    {draft.kind === "runtime_event" ? <label>Required events<input value={draft.events} onChange={(event) => patch({ events: event.target.value })} /><small>Separate event references with commas.</small></label> : null}
    {draft.kind === "model_judge" || draft.kind === "human" ? <label>Rubric<textarea rows={10} value={draft.rubric} onChange={(event) => patch({ rubric: event.target.value })} /></label> : null}
    {draft.kind === "model_judge" ? <><label>Model provider<input value={draft.providerId} onChange={(event) => patch({ providerId: event.target.value })} /></label><label>Judge model<input value={draft.modelId} onChange={(event) => patch({ modelId: event.target.value })} /></label><label>Model revision (optional)<input value={draft.modelRevision} onChange={(event) => patch({ modelRevision: event.target.value })} /></label><label>Temperature<input type="number" min={0} max={2} step={0.1} value={draft.temperature} onChange={(event) => patch({ temperature: event.target.value })} /></label><p>Changing the rubric or model requires calibration before this judge can grade examples.</p></> : null}
    {draft.kind === "human" ? <label>Reviewer role<input value={draft.reviewerRole} onChange={(event) => patch({ reviewerRole: event.target.value })} /></label> : null}
    {draft.kind === "learned_model" ? <><label>Model version<input value={draft.learnedId} onChange={(event) => patch({ learnedId: event.target.value })} /></label><label>Model version content hash<input value={draft.learnedHash} onChange={(event) => patch({ learnedHash: event.target.value })} /></label><LearningJsonField label="Model input contract" value={draft.inputContract} onChange={(inputContract) => patch({ inputContract })} /><label>Raw score minimum<input type="number" value={draft.minimum} onChange={(event) => patch({ minimum: event.target.value })} /></label><label>Raw score maximum<input type="number" value={draft.maximum} onChange={(event) => patch({ maximum: event.target.value })} /></label></> : null}
    <LearningActions><button type="button" className="training-button secondary" disabled={mutation.busy} onClick={() => { void guard.requestLeave(onClose); }}>Cancel</button><button type="button" className="training-button" disabled={mutation.busy || !draft.name.trim()} onClick={async () => { const result = await save(); if (result) { guard.allowNextNavigation(); onSaved(result); } }}>{mutation.busy ? "Publishing…" : `Publish release ${revision + 1}`}</button></LearningActions>
    {guard.dialog}
  </div>;
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function split(value: string): string[] { return value.split(",").map((part) => part.trim()).filter(Boolean); }
