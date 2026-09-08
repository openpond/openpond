import { useState } from "react";
import type { ModelProject } from "@openpond/contracts";
import { learningRef, type OpenPondLearningClient, type RewardBinding } from "openpond-sdk/learning";
import { ModelBatchReviewRequestSchema, type ModelBatchReviewReceipt, type ModelBatchReviewRequest, type ModelBatchReviewInspection } from "openpond-sdk/model-batch-review";
import { AppDialog } from "../../dialogs/AppDialog";
import { LearningError, LearningJsonField, LearningPager, parseLearningObject } from "./LearningFields";
import { useLearningResources } from "./useLearningResources";
import { useDraftNavigation } from "../useDraftNavigation";

type ExampleFields = { input: string; expected: string; evaluatorContext: string; proposedTarget: string };
const json = (value: unknown) => JSON.stringify(value, null, 2);
const nullableObject = (value: string) => value.trim() === "null" ? null : parseLearningObject(value);

export function ModelBatchReviewDialog({ model, value, client, onSave, onClose, onReview }: {
  model: ModelProject; value: ModelBatchReviewInspection; client: OpenPondLearningClient | null;
  onSave: (request: ModelBatchReviewRequest) => Promise<ModelBatchReviewReceipt | null>;
  onClose: () => void; onReview: (evidenceId: string) => void;
}) {
  const metadata = value;
  const resources = value;
  const [operationId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(metadata.definition.name);
  const [instructions, setInstructions] = useState(metadata.definition.instructions);
  const [inputSchema, setInputSchema] = useState(() => json(metadata.definition.inputSchema));
  const [outputSchema, setOutputSchema] = useState(() => json(metadata.definition.outputSchema));
  const [binding, setBinding] = useState<RewardBinding | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const bindings = useLearningResources(client, "binding", { limit: 100, ...(after ? { afterId: after } : {}) });
  const [selected, setSelected] = useState(resources.evidence[0]!.id);
  const [edits, setEdits] = useState<Map<string, ExampleFields>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = edits.size > 0 || binding !== null || name !== metadata.definition.name || instructions !== metadata.definition.instructions
    || inputSchema !== json(metadata.definition.inputSchema) || outputSchema !== json(metadata.definition.outputSchema);
  const guard = useDraftNavigation({ name: "batch edits", dirty, busy });
  const evidence = resources.evidence.find(item => item.id === selected)!;
  const initialFields = (id: string): ExampleFields => {
    const item = resources.evidence.find(item => item.id === id)!;
    const decision = resources.decisions.find(decision => decision.evidence.id === id)!;
    return { input: json(item.submission.input), expected: json(item.submission.expected),
      evaluatorContext: json(item.submission.evaluatorContext), proposedTarget: json(decision.approvedTarget) };
  };
  const fields = edits.get(selected) ?? initialFields(selected);
  const change = (field: keyof ExampleFields, value: string) => setEdits(previous => new Map(previous).set(selected, { ...(previous.get(selected) ?? initialFields(selected)), [field]: value }));
  const choices = [...(bindings.page?.items ?? [])];
  if (binding && !choices.some(item => item.contentHash === binding.contentHash)) choices.push(binding);
  async function save() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const request = ModelBatchReviewRequestSchema.parse({ schemaVersion: "openpond.modelBatchReviewRequest.v1", operationId, modelId: model.id,
        expectedModelRevision: model.revision, tasksetRef: model.trainingSetup.tasksetRef, rewardBindingRef: binding ? learningRef(binding) : null,
        definition: { name, instructions, inputSchema: parseLearningObject(inputSchema), outputSchema: parseLearningObject(outputSchema) },
        examples: [...edits].map(([id, fields]) => ({ evidence: learningRef(resources.evidence.find(item => item.id === id)!),
          input: parseLearningObject(fields.input), expected: nullableObject(fields.expected), evaluatorContext: nullableObject(fields.evaluatorContext), proposedTarget: nullableObject(fields.proposedTarget) })),
      });
      const receipt = await onSave(request);
      if (!receipt) throw new Error("The review could not be saved. Your edits are still here.");
      guard.allowNextNavigation(); onClose(); onReview(receipt.evidence[0]!.id);
    } catch (error) { setError(error instanceof Error ? error.message : "The review could not be saved."); }
    finally { setBusy(false); }
  }
  return <><AppDialog ariaLabel="Revise reviewed batch" backdropClassName="labs-rename-backdrop" className="labs-rename-dialog labs-model-create-dialog learning-workspace model-batch-review-dialog"
    dismissDisabled={busy} onClose={() => { void guard.requestLeave(onClose); }}>
    <header><div><h2>Revise reviewed batch</h2><p>Edit the task or Reward, then grade and review the new examples before selecting the new batch for {model.name}.</p></div></header>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <LearningError error={error ?? bindings.error} />
      <label>Task name<input value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label>Instructions<textarea value={instructions} disabled={busy} onChange={event => setInstructions(event.target.value)} /></label>
      <label>Reward<select disabled={busy} value={binding?.contentHash ?? ""} onChange={event => setBinding(choices.find(item => item.contentHash === event.target.value) ?? null)}>
        <option value="">Current batch Reward</option>{choices.map(item => <option key={item.contentHash} value={item.contentHash}>{item.name ?? item.id} · revision {item.revision}</option>)}
      </select></label>
      <LearningPager after={after} next={bindings.page?.nextCursor} onPage={setAfter} />
      <details><summary>Task format</summary><LearningJsonField label="Input schema" value={inputSchema} onChange={setInputSchema} disabled={busy} /><LearningJsonField label="Output schema" value={outputSchema} onChange={setOutputSchema} disabled={busy} /></details>
      <label>Example<select value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>{resources.evidence.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {item.submission.exampleId}</option>)}</select></label>
      <p>{evidence.submission.split} · {evidence.submission.familyKey}. The recorded response remains in its original provenance.</p>
      <LearningJsonField label="Task input" value={fields.input} onChange={value => change("input", value)} disabled={busy} />
      <LearningJsonField label="Proposed target" hint="Use null for no supervised target. Every target requires a new grade and approval." value={fields.proposedTarget} onChange={value => change("proposedTarget", value)} disabled={busy} />
      <details><summary>Evaluator-only answers and context</summary><LearningJsonField label="Expected answer" value={fields.expected} onChange={value => change("expected", value)} disabled={busy} /><LearningJsonField label="Private context" value={fields.evaluatorContext} onChange={value => change("evaluatorContext", value)} disabled={busy} /></details>
      <div className="model-build-actions"><button type="button" className="training-button secondary" disabled={busy} onClick={() => { void guard.requestLeave(onClose); }}>Cancel</button><button className="training-button" disabled={busy}>{busy ? "Saving…" : "Save for review"}</button></div>
    </form>
  </AppDialog>{guard.dialog}</>;
}
