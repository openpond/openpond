import { useState } from "react";
import type { AuthoringDraftFor } from "openpond-sdk/learning";
import { useAuthoringDraft } from "./useAuthoringDraft";
import { learningRef, LearningSourceContentSchema, RewardBindingContentSchema, sealLearningContent, TaskDefinitionContentSchema, TaskDefinitionSchema, type OpenPondLearningClient, type RewardBinding, type RewardBindingSource, type TaskDefinition } from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { useDraftNavigation } from "../useDraftNavigation";
import { LearningActions, LearningError, LearningJsonField, LearningPager, parseLearningObject } from "./LearningFields";
import { RewardBindingFields } from "./RewardBindingFields";
import { useLearningMutation, useLearningResource, useLearningResources } from "./useLearningResources";

const INPUT_SCHEMA = { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false };
const OUTPUT_SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };

export function TaskFormatEditor(props: { authoringDraft?: AuthoringDraftFor<"definition">; client: OpenPondLearningClient | null; definition: TaskDefinition | null; onClose: () => void; onSaved: (definition: TaskDefinition) => void }) {
  const binding = useLearningResource(props.client, "binding", props.definition?.rewardBinding.id ?? null, props.definition?.rewardBinding.revision);
  if (props.definition && !binding.resource) return <div className="labs-flat-body labs-resource-page learning-workspace"><LearningError error={binding.error} /><p role="status">{binding.error ? "The format’s Reward binding is unavailable." : "Loading exact Reward binding…"}</p><button type="button" className="training-button secondary" onClick={props.onClose}>Back</button></div>;
  return <TaskFormatEditorForm {...props} binding={binding.resource} />;
}

function TaskFormatEditorForm({ client, definition, binding, authoringDraft, onClose, onSaved }: { authoringDraft?: AuthoringDraftFor<"definition">; client: OpenPondLearningClient | null; definition: TaskDefinition | null; binding: RewardBinding | null; onClose: () => void; onSaved: (definition: TaskDefinition) => void }) {
  const [id] = useState(() => authoringDraft?.targetId ?? definition?.id ?? `format-${crypto.randomUUID()}`);
  const initial = { name: definition?.name ?? "", description: definition?.description ?? "", instructions: definition?.instructions ?? "Return the answer as JSON.", input: JSON.stringify(definition?.inputSchema ?? INPUT_SCHEMA, null, 2), output: JSON.stringify(definition?.outputSchema ?? OUTPUT_SCHEMA, null, 2), familyNamespace: definition?.familyNamespace ?? id, sources: binding?.sources ?? [] as RewardBindingSource[], recipeRef: binding?.recipeRef };
  const [draft, setDraft] = useState(authoringDraft?.fields ?? initial);
  const [saved, setSaved] = useState(JSON.stringify(authoringDraft?.fields ?? initial));
  const [revision, setRevision] = useState(definition?.revision ?? 0);
  const [recipePage, setRecipePage] = useState<string | null>(null);
  const recipes = useLearningResources(client, "binding", { limit: 30, ...(recipePage ? { afterId: recipePage } : {}) });
  const mutation = useLearningMutation(client);
  const persistence = useAuthoringDraft(authoringDraft);
  const draftInput = () => ({ targetKind: "definition" as const, targetId: id, baseRelease: definition ? learningRef(definition) : null, fields: draft });
  async function saveDraft() {
    const result = await mutation.run(api => persistence.save(api, draftInput()));
    if (result) setSaved(JSON.stringify(draft));
    return Boolean(result);
  }
  const patch = (update: Partial<typeof draft>) => setDraft((value) => ({ ...value, ...update }));
  async function save() {
    const result = await mutation.run(async (api) => {
      const nextRevision = revision + 1;
      const bindingContent = RewardBindingContentSchema.parse({ schemaVersion: "openpond.rewardBinding.v1", id: `${id}-r${nextRevision}-binding`, revision: 1, sources: draft.sources, ...(draft.recipeRef ? { recipeRef: draft.recipeRef } : {}), aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" });
      const bound = sealLearningContent(bindingContent);
      const execution = definition?.execution ?? { policy: { policyVisibleFields: ["input", "policyVisibleContext"], privilegedFields: ["expectedOutput", "evaluatorContext"], hiddenGraderRefs: [], connectedAppScopes: [] }, environment: { protocolVersion: "openpond.environment.v1", kind: "text", entrypoint: "openpond.text.v1", stateful: false, deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 30_000 }, tools: [], capabilities: [] };
      const content = TaskDefinitionContentSchema.parse({ schemaVersion: "openpond.taskDefinition.v1", id, revision: nextRevision, name: draft.name, description: draft.description, instructions: draft.instructions, category: definition?.category ?? "structured", familyNamespace: draft.familyNamespace, inputSchema: parseLearningObject(draft.input), outputSchema: parseLearningObject(draft.output), rewardBinding: learningRef(bound), harness: definition?.harness ?? null, execution: { ...execution, policy: { ...execution.policy, hiddenGraderRefs: draft.sources.filter((source) => source.privileged).map((source) => source.graderId) } } });
      const release = TaskDefinitionSchema.parse(sealLearningContent(content));
      // Each format release owns its direct source. Existing producers keep their
      // exact contract and can continue retrying old submissions after an edit.
      const source = LearningSourceContentSchema.parse({ schemaVersion: "openpond.learningSource.v1", id: nextRevision === 1 ? `${id}-direct` : `${id}-r${nextRevision}-direct`, revision: 1, name: `${draft.name} direct examples · r${nextRevision}`, kind: "direct", taskDefinition: learningRef(release), enabled: true, allowedSplits: ["train", "frozen_eval", "validation", "test"], mapping: null, adapterVersion: null });
      const storedDraft = await persistence.save(api, draftInput());
      const response = await api.command({ action: "publish_resources", operationId: `format:${release.contentHash}`, finalizeDraft: persistence.finalization(storedDraft, release), resources: [{ kind: "binding", expectedRevision: 0, content: bindingContent }, { kind: "definition", expectedRevision: revision, content }, { kind: "source", expectedRevision: 0, content: source }] });
      return TaskDefinitionSchema.parse(response.resources[1]);
    });
    if (result) { setRevision(result.revision); setSaved(JSON.stringify(draft)); }
    return result;
  }
  const guard = useDraftNavigation({ name: "task format", dirty: saved !== JSON.stringify(draft), busy: mutation.busy, save: saveDraft });
  return <div className="labs-flat-body labs-resource-page learning-workspace"><ModelProjectPageHeader title={definition ? "Edit task format" : "New task format"} description="Define the task and bind its exact Reward releases. Publishing a new format release preserves previous examples, sources and grading." />
    <LearningError error={mutation.error ?? recipes.error} />
    {persistence.record ? <p role="status">{saved === JSON.stringify(draft) ? `Draft saved · revision ${persistence.record.revision}` : "Unsaved changes"}</p> : null}
    <label>Name<input value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></label>
    <label>Description<textarea value={draft.description} onChange={(event) => patch({ description: event.target.value })} /></label>
    <label>Instructions<textarea value={draft.instructions} onChange={(event) => patch({ instructions: event.target.value })} /></label>
    <LearningJsonField label="Input schema" value={draft.input} onChange={(input) => patch({ input })} /><LearningJsonField label="Output schema" value={draft.output} onChange={(output) => patch({ output })} />
    <label>Task-family namespace<input value={draft.familyNamespace} onChange={(event) => patch({ familyNamespace: event.target.value })} /><small>Formats sharing task families must share this namespace to prevent training and held-out data overlap.</small></label>
    <details><summary>Start from a combined Reward</summary><p>Selecting a combination replaces the sources below. Customize the copied settings before publishing.</p><div className="learning-actions">{recipes.page?.items.filter((recipe) => recipe.name).map((recipe) => <button type="button" className="training-button secondary" key={recipe.id} onClick={() => patch({ sources: recipe.sources.map((source) => ({ ...source })), recipeRef: learningRef(recipe) })}>{recipe.name} · release {recipe.revision}</button>)}</div><LearningPager after={recipePage} next={recipes.page?.nextCursor} onPage={setRecipePage} /></details>
    {draft.recipeRef ? <p>Initialized from combination release {draft.recipeRef.revision}. This task format saves its own settings.</p> : null}
    <RewardBindingFields client={client} sources={draft.sources} onChange={(sources) => patch({ sources })} />
    <LearningActions><button type="button" className="training-button secondary" disabled={mutation.busy} onClick={() => { void guard.requestLeave(onClose); }}>Cancel</button><button type="button" className="training-button secondary" disabled={mutation.busy} onClick={() => { void saveDraft(); }}>Save draft</button><button type="button" className="training-button" disabled={mutation.busy || !draft.name.trim() || !draft.sources.length} onClick={async () => { const result = await save(); if (result) { guard.allowNextNavigation(); onSaved(result); } }}>{mutation.busy ? "Publishing…" : `Publish task format release ${revision + 1}`}</button></LearningActions>{guard.dialog}
  </div>;
}
