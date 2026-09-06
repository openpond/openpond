import { useState } from "react";
import { createRewardBinding, learningRef, LearningSourceContentSchema, sealLearningContent, TaskDefinitionSchema, TaskDefinitionContentSchema, type OpenPondLearningClient, type TaskDefinition } from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { useDraftNavigation } from "../useDraftNavigation";
import { LearningActions, LearningError, LearningJsonField, LearningPager, LearningValue, parseLearningObject } from "./LearningFields";
import { useLearningMutation, useLearningResource, useLearningResources } from "./useLearningResources";
import { LearningIntake } from "./LearningIntake";

export function LearningTaskFormatsPage({ client, selectedId, after, onSelect, onPage, onReview }: { client: OpenPondLearningClient | null; selectedId: string | null; after: string | null; onSelect: (id: string | null) => void; onPage: (after: string | null) => void; onReview: (id: string) => void }) {
  const definitions = useLearningResources(client, "definition", { limit: 30, ...(after ? { afterId: after } : {}) });
  const [editing, setEditing] = useState(false);
  const selected = useLearningResource(client, "definition", selectedId);
  const definition = selected.resource ?? definitions.page?.items.find((item) => item.id === selectedId) ?? null;
  if (editing) return <TaskFormatEditor client={client} onClose={() => setEditing(false)} onSaved={(definition) => { setEditing(false); definitions.refresh(); selected.refresh(); onSelect(definition.id); }} />;
  return <div className="labs-flat-body labs-resource-page learning-workspace">
    <ModelProjectPageHeader title={definition?.name ?? "Task formats"} description="Define input, output and grading once, then submit examples through JSON or the SDK. Formats are shared across models in this workspace." actions={<button type="button" className="training-button" onClick={() => setEditing(true)}>New task format</button>} />
    <LearningError error={definitions.error ?? selected.error} />
    {definition ? <>
      <button type="button" className="training-button secondary" onClick={() => onSelect(null)}>All task formats</button>
      <p>{definition.instructions}</p><p>Release {definition.revision} · {definition.contentHash}</p>
      <details><summary>Input and output contracts</summary><LearningValue label="Input schema" value={definition.inputSchema} /><LearningValue label="Output schema" value={definition.outputSchema} /><LearningValue label="Reward binding" value={definition.rewardBinding} /></details>
      <LearningIntake key={`${definition.id}:${definition.revision}`} client={client} definition={definition} onReview={onReview} />
    </> : selectedId ? <><p role="status">{selected.error ? "This task format is unavailable." : "Loading task format…"}</p><button type="button" className="training-button secondary" onClick={() => onSelect(null)}>All task formats</button></> : <>
      <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Task format</th><th>Category</th><th>Release</th></tr></thead><tbody>{definitions.page?.items.map((definition) => <tr key={definition.id}><td><button type="button" className="labs-version-row-button" onClick={() => onSelect(definition.id)}><strong>{definition.name}</strong><small>{definition.description}</small></button></td><td>{definition.category}</td><td>{definition.revision}</td></tr>)}</tbody></table></div>
      {definitions.loading ? <p role="status">Loading task formats…</p> : !definitions.page?.items.length ? <p>Create a task format to accept structured examples and human corrections.</p> : null}<LearningPager after={after} next={definitions.page?.nextCursor} onPage={onPage} />
    </>}
  </div>;
}

const INPUT_SCHEMA = { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false };
const OUTPUT_SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };

function TaskFormatEditor({ client, onClose, onSaved }: { client: OpenPondLearningClient | null; onClose: () => void; onSaved: (definition: TaskDefinition) => void }) {
  const rewards = useLearningResources(client, "reward", { limit: 100 });
  const [id] = useState(() => `format-${crypto.randomUUID()}`);
  const initial = { name: "", instructions: "Return the answer as JSON.", input: JSON.stringify(INPUT_SCHEMA, null, 2), output: JSON.stringify(OUTPUT_SCHEMA, null, 2), rewardId: "", familyNamespace: id };
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const mutation = useLearningMutation(client);
  const patch = (update: Partial<typeof draft>) => setDraft((value) => ({ ...value, ...update }));
  async function save() {
    const result = await mutation.run(async (api) => {
      const reward = rewards.page?.items.find((reward) => reward.id === draft.rewardId);
      if (!reward) throw new Error("Choose a published Reward before saving the format.");
      const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: `${id}-binding`, revision: 1, sources: [{ graderId: reward.id, reward: learningRef(reward), role: "training", normalization: reward.rawScore.minimum === 0 && reward.rawScore.maximum === 1 ? { kind: "identity" } : { kind: "linear", ...reward.rawScore, direction: "higher" }, weight: 1, required: true, hardGate: true, privileged: true, fixtureRefs: [] }], aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }, [reward]);
      const content = TaskDefinitionContentSchema.parse({ schemaVersion: "openpond.taskDefinition.v1", id, revision: 1, name: draft.name, description: "", instructions: draft.instructions, category: "structured", familyNamespace: draft.familyNamespace, inputSchema: parseLearningObject(draft.input), outputSchema: parseLearningObject(draft.output), rewardBinding: learningRef(binding), harness: null, execution: { policy: { policyVisibleFields: ["input", "policyVisibleContext"], privilegedFields: ["expectedOutput"], hiddenGraderRefs: [reward.id], connectedAppScopes: [] }, environment: { protocolVersion: "openpond.environment.v1", kind: "text", entrypoint: "openpond.text.v1", stateful: false, deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 30_000 }, tools: [], capabilities: [] } });
      const { contentHash: _hash, ...bindingContent } = binding;
      const definition = TaskDefinitionSchema.parse(sealLearningContent(content));
      const source = LearningSourceContentSchema.parse({ schemaVersion: "openpond.learningSource.v1", id: `${id}-direct`, revision: 1, name: `${draft.name} direct examples`, kind: "direct", taskDefinition: learningRef(definition), enabled: true, allowedSplits: ["train", "frozen_eval", "validation", "test"], mapping: null, adapterVersion: null });
      const result = await api.command({ action: "publish_resources", operationId: `${id}-publish-format`, resources: [{ kind: "binding", expectedRevision: 0, content: bindingContent }, { kind: "definition", expectedRevision: 0, content }, { kind: "source", expectedRevision: 0, content: source }] });
      return TaskDefinitionSchema.parse(result.resources[1]);
    });
    if (result) setSaved(JSON.stringify(draft));
    return result;
  }
  const guard = useDraftNavigation({ name: "task format", dirty: saved !== JSON.stringify(draft), busy: mutation.busy, save: async () => Boolean(await save()) });
  return <div className="labs-flat-body labs-resource-page learning-workspace"><ModelProjectPageHeader title="New task format" description="Start with a structured text task. The input and output use bounded JSON Schema 2020-12 object envelopes." />
    <LearningError error={mutation.error ?? rewards.error} />
    <label>Name<input value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></label><label>Instructions<textarea value={draft.instructions} onChange={(event) => patch({ instructions: event.target.value })} /></label>
    <LearningJsonField label="Input schema" value={draft.input} onChange={(input) => patch({ input })} /><LearningJsonField label="Output schema" value={draft.output} onChange={(output) => patch({ output })} />
    <label>Task-family namespace<input value={draft.familyNamespace} onChange={(event) => patch({ familyNamespace: event.target.value })} /><small>Formats sharing task families must share this namespace to prevent training and held-out data overlap.</small></label>
    <label>Required training Reward<select value={draft.rewardId} onChange={(event) => patch({ rewardId: event.target.value })}><option value="">Choose a published Reward</option>{rewards.page?.items.map((reward) => <option key={reward.id} value={reward.id}>{reward.name} · release {reward.revision}</option>)}</select></label>
    {!rewards.page?.items.length && !rewards.loading ? <p>Publish a reusable Reward on the Rewards page first.</p> : null}
    <LearningActions><button type="button" className="training-button secondary" disabled={mutation.busy} onClick={() => { void guard.requestLeave(onClose); }}>Cancel</button><button type="button" className="training-button" disabled={mutation.busy || !draft.name.trim() || !draft.rewardId} onClick={async () => { const definition = await save(); if (definition) { guard.allowNextNavigation(); onSaved(definition); } }}>{mutation.busy ? "Publishing…" : "Publish task format"}</button></LearningActions>{guard.dialog}
  </div>;
}
