import { useQuery } from "@tanstack/react-query";
import { parseAndVerifyTrainingResult, type TrainingResult } from "openpond-sdk/training";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { ErrorToast } from "../common/ErrorToast";
import { useState } from "react";
import { SaveTrainingModelDialog } from "./SaveTrainingModelDialog";
import type { TrainingResultSaveReceipt } from "openpond-sdk/training";
import type { WorkspaceApi } from "./workspace/workspace-api";

const candidateLabels: Record<TrainingResult["candidateState"], string> = {
  not_finished: "Training has not produced a completed result yet.",
  request_unavailable: "The original training request is unavailable for this run.",
  qualification_only: "This run collected qualification evidence without training weights.",
  not_model_training: "This run has no policy-model checkpoint.",
  cleanup_pending: "Waiting for terminal cleanup evidence.",
  artifact_pending: "Waiting for the final checkpoint publication.",
  retained: "Final checkpoint retained.",
};
const compositionLabels = {
  base: "Standalone adapter", residual_append: "Stacked adapter", shared: "Shared adapter", sequential_merge: "Sequential merge",
};

/** Independent of run diagnostics: result-read latency never hides live status. */
export function TrainingResultDetails({ connection, teamId, actorId, jobId, version, api, onOpenModel }: {
  connection: ClientConnection; teamId: string; actorId: string; jobId: string; version: number;
  api: WorkspaceApi; onOpenModel?(id: string): Promise<void>;
}) {
  const [saving, setSaving] = useState(false), [opening, setOpening] = useState(false);
  const [saved, setSaved] = useState<TrainingResultSaveReceipt | null>(null), [actionError, setActionError] = useState<unknown>(null);
  const query = useQuery({
    queryKey: ["hosted-training-result", api.key, connectionQueryScope(connection), teamId, actorId, jobId, version],
    queryFn: async ({ signal }) => parseAndVerifyTrainingResult(await apiFetch(connection,
      `/v1/training/hosted-jobs/${encodeURIComponent(jobId)}/result?teamId=${encodeURIComponent(teamId)}`, { signal }), { teamId, jobId }),
    staleTime: 30_000, gcTime: 300_000,
  });
  const result = query.data;
  const source = result?.request;
  const candidate = result?.candidate;
  const receipt = result?.outputs.receipt;
  const savedModelName = result?.model && (!saved || result.model.revision >= saved.model.revision)
    ? result.model.name : saved?.model.name ?? "Model";
  return <section className="training-result-details" aria-label="Model result">
    <div className="training-result-heading"><h3>Model result</h3>
      <button type="button" className="training-button secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh result</button>
    </div>
    <ErrorToast error={actionError ?? query.error} />
    {query.isPending ? <p role="status">Loading model result…</p> : null}
    {result ? <>
      <p>{candidateLabels[result.candidateState]}</p>
      {saved || result.savedVersion ? <div className="model-build-actions"><span>Saved to {savedModelName}.</span>
        {onOpenModel ? <button type="button" className="training-button secondary" disabled={opening} onClick={() => {
          const id = saved?.model.id ?? result.model?.id;
          if (!id || !onOpenModel) return;
          setOpening(true); setActionError(null);
          void onOpenModel(id).catch(setActionError).finally(() => setOpening(false));
        }}>{opening ? "Opening…" : "View model"}</button> : null}
        <button type="button" className="training-button secondary" onClick={() => setSaving(true)}>Review save</button>
      </div> : candidate && result.model ? <button type="button" className="training-button" onClick={() => setSaving(true)}>Save model</button> : null}
      {source ? <dl className="model-project-page-metrics">
        <div><dt>Base model</dt><dd title={source.baseModel.modelId}>{source.baseModel.modelId}</dd><small title={source.baseModel.revision ?? undefined}>{source.baseModel.revision}</small></div>
        <div><dt>Method</dt><dd>{String(source.recipe.method ?? "Training")}</dd></div>
        <div><dt>Configuration revision</dt><dd>{source.source.modelProject.revision}</dd></div>
        <div><dt>Dataset</dt><dd title={source.source.taskset.id}>{source.source.taskset.id}</dd><small>Revision {source.source.taskset.revision}</small></div>
        {candidate ? <div><dt>Composition</dt><dd>{compositionLabels[candidate.composition]}</dd></div> : null}
        {receipt ? <div><dt>Cleanup</dt><dd>{receipt.cleanupComplete ? "Complete" : "Pending"}</dd></div> : null}
      </dl> : null}
      {candidate ? <p>Checkpoint <code>{candidate.checkpointId}</code>
        {candidate.parent ? <> · Parent run <code>{candidate.parent.jobId}</code></> : null}
      </p> : null}
      <details><summary>Exact settings and references</summary>
        <pre>{JSON.stringify({ request: source, candidate, executionReceipt: receipt
          ? { id: receipt.id, runtimeRelease: receipt.runtimeRelease, spendUsd: receipt.spendUsd, durationSeconds: receipt.durationSeconds } : null }, null, 2)}</pre>
      </details>
    </> : null}
    {saving && result ? <SaveTrainingModelDialog api={api} result={result} onClose={() => setSaving(false)} onSaved={(receipt, acknowledgementError) => {
      setSaved(receipt); setActionError(acknowledgementError); setSaving(false); void query.refetch();
    }} /> : null}
  </section>;
}
