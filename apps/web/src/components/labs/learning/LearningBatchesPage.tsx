import { useState } from "react";
import { learningRef, sameLearningRef, TaskBatchSchema, type OpenPondLearningClient, type TaskAdmissionDecision, type TaskBatch, type TaskEvidence } from "openpond-sdk/learning";
import { ModelProjectPageHeader } from "../ModelProjectPageHeader";
import { LearningActions, LearningError, LearningPager, LearningValue } from "./LearningFields";
import { useLearningMutation, useLearningResource, useLearningResources } from "./useLearningResources";

export function LearningBatchesPage({ client, selectedId, after, onSelect, onPage, onTrain }: { client: OpenPondLearningClient | null; selectedId: string | null; after: string | null; onSelect: (id: string | null) => void; onPage: (cursor: string | null) => void; onTrain: (batch: TaskBatch) => Promise<void> }) {
  const batches = useLearningResources(client, "batch", { limit: 30, ...(after ? { afterId: after } : {}) });
  const [composing, setComposing] = useState(false);
  if (selectedId) return <BatchDetail client={client} id={selectedId} onBack={() => onSelect(null)} onTrain={onTrain} />;
  return <div className="labs-flat-body labs-resource-page learning-workspace"><ModelProjectPageHeader title="Approved batches" description="Seal exact evidence and review revisions for supervised training, reward training, or held-out evaluation." actions={<button type="button" className="training-button" onClick={() => setComposing(true)}>Seal a batch</button>} />
    <LearningError error={batches.error} />
    {composing ? <BatchComposer client={client} onClose={() => setComposing(false)} onSealed={(batch) => { setComposing(false); batches.refresh(); onSelect(batch.id); }} /> : <>
      <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Batch</th><th>Purpose</th><th>Examples</th><th>Sealed</th></tr></thead><tbody>{batches.page?.items.map((batch) => <tr key={batch.id}><td><button type="button" className="labs-version-row-button" onClick={() => onSelect(batch.id)}>{batch.id}</button></td><td>{batch.purpose.replaceAll("_", " ")}</td><td>{batch.examples.length}</td><td>{new Date(batch.sealedAt).toLocaleString()}</td></tr>)}</tbody></table></div><LearningPager after={after} next={batches.page?.nextCursor} onPage={onPage} />
      {batches.loading ? <p role="status">Loading batches…</p> : !batches.page?.items.length ? <p>No approved batches have been sealed.</p> : null}
    </>}
  </div>;
}

function BatchComposer({ client, onClose, onSealed }: { client: OpenPondLearningClient | null; onClose: () => void; onSealed: (batch: TaskBatch) => void }) {
  const [after, setAfter] = useState<string | null>(null);
  const decisions = useLearningResources(client, "decision", { status: "approved", limit: 30, ...(after ? { afterId: after } : {}) });
  const [selection, setSelection] = useState<Map<string, TaskAdmissionDecision>>(new Map());
  const [purpose, setPurpose] = useState<TaskBatch["purpose"]>("supervised_training");
  const [batchId] = useState(() => `batch-${crypto.randomUUID()}`);
  const mutation = useLearningMutation(client);
  return <section><h2>Choose reviewed examples</h2><p>All selected examples must reference one task format release. Supervised batches require approved targets; evaluation batches require held-out examples. Stale reviews and split conflicts are checked again when sealing.</p>
    <LearningError error={decisions.error ?? mutation.error} /><label>Purpose<select value={purpose} disabled={mutation.busy} onChange={(event) => setPurpose(event.target.value as TaskBatch["purpose"])}><option value="supervised_training">Supervised training</option><option value="reward_training">Reward training</option><option value="evaluation">Held-out evaluation</option></select></label>
    <div className="training-table-wrap"><table className="training-data-table"><thead><tr><th>Select</th><th>Evidence</th><th>Observed quality</th><th>Target</th><th>Reviewer</th></tr></thead><tbody>{decisions.page?.items.map((decision) => <tr key={decision.id}><td><input type="checkbox" aria-label={`Select ${decision.evidence.id}`} disabled={mutation.busy || (purpose === "supervised_training" && decision.targetApproval !== "approved")} checked={selection.has(decision.id)} onChange={(event) => setSelection((previous) => { const next = new Map(previous); if (event.target.checked) next.set(decision.id, decision); else next.delete(decision.id); return next; })} /></td><td>{decision.evidence.id} · r{decision.evidence.revision}</td><td>{decision.observedQuality}</td><td>{decision.targetApproval}</td><td>{decision.actor.id}</td></tr>)}</tbody></table></div>
    <LearningPager after={after} next={decisions.page?.nextCursor} onPage={setAfter} />
    <LearningActions><button type="button" className="training-button secondary" disabled={mutation.busy} onClick={onClose}>Cancel</button><button type="button" className="training-button" disabled={mutation.busy || !selection.size} onClick={async () => {
      const result = await mutation.run(async (api) => {
        const reviews = [...selection.values()];
        const evidence: TaskEvidence[] = [];
        for (const review of reviews) {
          const item = await api.get("evidence", review.evidence.id);
          if (!sameLearningRef(review.evidence, learningRef(item))) throw new Error(`Review ${review.id} is stale. Review the latest evidence revision.`);
          evidence.push(item);
        }
        const definition = evidence[0]!.submission.taskDefinition;
        if (evidence.some((item) => !sameLearningRef(item.submission.taskDefinition, definition))) throw new Error("Choose examples from the same task format release.");
        return TaskBatchSchema.parse((await api.command({ action: "seal_batch", operationId: `${batchId}-seal`, batchId, taskDefinition: definition, purpose, evidence: evidence.map(learningRef), decisions: reviews.map(learningRef) })).resources[0]);
      });
      if (result) onSealed(result);
    }}>{mutation.busy ? "Sealing…" : `Seal ${selection.size} examples`}</button></LearningActions>
  </section>;
}

function BatchDetail({ client, id, onBack, onTrain }: { client: OpenPondLearningClient | null; id: string; onBack: () => void; onTrain: (batch: TaskBatch) => Promise<void> }) {
  const batch = useLearningResource(client, "batch", id);
  const packages = useLearningResources(client, "package", { parentId: id, limit: 1 });
  const mutation = useLearningMutation(client);
  return <div className="labs-flat-body labs-resource-page learning-workspace"><ModelProjectPageHeader title="Sealed task batch" description={id} actions={<button type="button" className="training-button secondary" onClick={onBack}>All batches</button>} /><LearningError error={batch.error ?? packages.error ?? mutation.error} />
    {batch.resource ? <><p>{batch.resource.examples.length} examples · {batch.resource.purpose.replaceAll("_", " ")} · sealed by {batch.resource.sealedBy}</p><details><summary>Inspect exact batch provenance</summary><LearningValue label="Exact batch provenance" value={batch.resource} /></details>
      <LearningActions>{batch.resource.purpose !== "evaluation" ? <button type="button" className="training-button" disabled={mutation.busy} onClick={() => { void mutation.run(async () => { await onTrain(batch.resource!); return true; }); }}>Prepare training run</button> : null}{packages.page?.items[0] ? <button type="button" className="training-button secondary" onClick={() => {
        const release = packages.page!.items[0]!;
        const url = URL.createObjectURL(new Blob([JSON.stringify(release, null, 2)], { type: "application/json" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${release.id}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }}>Export Taskset package</button> : null}</LearningActions>
    </> : !batch.error ? <p role="status">Loading batch…</p> : null}
  </div>;
}
