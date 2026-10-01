import { useState } from "react";
import { verifyConnectedRecordedExecution, type ConnectedRecordedExecution } from "openpond-sdk/connected-evidence";
import type { DatasetWorkspaceReceipt } from "openpond-sdk/dataset-workspaces";
import { learningRef, type RewardRelease } from "openpond-sdk/learning";
import { ExperimentFieldMappingsSchema, type ExperimentFieldMapping, type ExperimentScoringPass } from "openpond-sdk/experiments";
import type { WorkspaceApi } from "../workspace-api";
import { WorkspacePanel } from "../WorkspacePanel";
import { GraderReleasePicker } from "../GraderReleasePicker";
import { GraderFieldMappings } from "../GraderFieldMappings";

export function RecordedGrading({ api, execution, onStarted }: { api: WorkspaceApi; execution: ConnectedRecordedExecution; onStarted(pass: ExperimentScoringPass): void }) {
  const [grader, setGrader] = useState<RewardRelease | null>(null), [mappings, setMappings] = useState<ExperimentFieldMapping[]>([]), [budget, setBudget] = useState(1), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [pending, setPending] = useState(false);
  async function score() {
    if (!grader) return; setBusy(true); setError(null); setPending(true);
    try {
      const pinned = verifyConnectedRecordedExecution(execution);
      const request = { executionKind: "recorded_evidence" as const, execution: { id: pinned.id, contentHash: pinned.manifest.contentHash }, graders: [learningRef(grader)], mappings: [{ graderId: grader.id, fields: ExperimentFieldMappingsSchema.parse(mappings) }], maximumCostUsd: budget };
      const operation = await api.operation("score", request), pass = await api.request<ExperimentScoringPass>("score", { ...request, operationId: operation.id });
      if (pass.request.executionKind !== "recorded_evidence" || pass.request.execution.id !== pinned.id || pass.request.execution.contentHash !== pinned.manifest.contentHash) throw new Error("Scoring admission differs from the exact recorded source.");
      await operation.acknowledge(); onStarted(pass);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Scoring admission interrupted. Retry the same operation."); } finally { setBusy(false); }
  }
  return <section><h3>Score recorded outputs</h3><p>{execution.sources.length} frozen cases. This applies the selected grader to retained evidence and dispatches no target model. A model judge may incur grading cost within the admitted ceiling.</p>
    <fieldset disabled={busy || pending}><GraderReleasePicker api={api} value={grader} onChange={setGrader} /><GraderFieldMappings value={mappings} onChange={setMappings} />
      <label>Maximum grading cost (USD)<input type="number" min={0.01} max={1000} step={0.01} value={budget} onChange={event => setBudget(Number(event.target.value))} /></label></fieldset>
    {error ? <p role="alert">{error}</p> : null}<button className="training-button" disabled={busy || !grader || !Number.isFinite(budget) || budget <= 0 || !ExperimentFieldMappingsSchema.safeParse(mappings).success} onClick={() => void score()}>{busy ? "Applying grader…" : pending ? "Retry same scoring operation" : "Apply grader"}</button>
  </section>;
}

export function ConnectedRecordedSetup({ api, dataset, caseIds, onClose, onStarted }: {
  api: WorkspaceApi; dataset: DatasetWorkspaceReceipt; caseIds: string[]; onClose(): void; onStarted(execution: ConnectedRecordedExecution, pass: ExperimentScoringPass): void;
}) {
  const [execution, setExecution] = useState<ConnectedRecordedExecution | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  async function prepare() {
    setBusy(true); setError(null);
    try {
      if (!dataset.publication || dataset.workspace.draft.status !== "published" || !dataset.originProjectId) throw new Error("Publish the selected recorded Dataset in a personal Project first.");
      const request = { name: `${dataset.workspace.draft.name} recorded outputs`, projectId: dataset.originProjectId, dataset: dataset.publication.release, caseIds };
      const operation = await api.operation("connectedPrepareRecorded", request), source = verifyConnectedRecordedExecution(await api.request("connectedPrepareRecorded", { ...request, operationId: operation.id }));
      if (source.request.dataset.contentHash !== request.dataset.contentHash || JSON.stringify(source.request.caseIds) !== JSON.stringify(caseIds)) throw new Error("Recorded admission differs from its pinned Dataset and selected population.");
      await operation.acknowledge(); setExecution(source);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Recorded admission failed."); } finally { setBusy(false); }
  }
  return <WorkspacePanel action="recorded-score" label="Score recorded outputs" onRequestClose={() => { if (!busy) onClose(); }}><h2>Score recorded outputs</h2>
    {!execution ? <><p>{caseIds.length} exact published cases. Freeze the selected source evidence before choosing the grader. Preparing this manifest starts no model, evaluation or training job.</p><button className="training-button secondary" disabled={busy || !caseIds.length} onClick={() => void prepare()}>{busy ? "Preparing…" : "Prepare retained evidence"}</button></> : <RecordedGrading api={api} execution={execution} onStarted={pass => onStarted(execution, pass)} />}
    {error ? <p role="alert">{error}</p> : null}
  </WorkspacePanel>;
}
