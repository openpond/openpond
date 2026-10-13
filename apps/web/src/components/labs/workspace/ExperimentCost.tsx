import { useQuery } from "@tanstack/react-query";
import type { ExperimentRunDetails } from "openpond-sdk/experiments";
import type { ExperimentEvidence, WorkspaceApi } from "./workspace-api";
import { LocalExperimentComparisonSchema, type LocalExperimentRecord } from "@openpond/contracts";
import { localRequest } from "./local-workspace-api";
import { aggregateExperimentUsage, experimentTokenLabel, experimentTokenDetails } from "./experiment-usage";

export function ExperimentCost({ costUsd, subscription = false }: { costUsd: number | null; subscription?: boolean }) {
  return costUsd === null
    ? <span title={subscription ? "Codex did not report a billed dollar or credit amount for this run. Recorded token usage appears below." : "Dollar cost is unavailable or incomplete."}>USD unavailable</span>
    : <span title={`$${costUsd} reported cost`}>{costUsd > 0 && costUsd < 0.000001 ? "<$0.000001" : `$${costUsd.toFixed(costUsd > 0 && costUsd < 0.0001 ? 6 : costUsd > 0 && costUsd < 0.01 ? 4 : 2)}`}</span>;
}

export function LocalExperimentCost({ api, run }: { api: WorkspaceApi; run: LocalExperimentRecord }) {
  const evidence = useQuery({
    queryKey: ["local-experiments", api.key, "portable-evidence", run.id],
    enabled: Boolean(run.completedAt),
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      const value = (await localRequest(api, LocalExperimentComparisonSchema, "compare", { baselineId: run.id, candidateId: run.id }, signal)).baseline;
      if (value.execution.id !== run.id || value.execution.executionHash !== run.executionHash)
        throw new Error("Usage evidence belongs to another Experiment.");
      return value;
    },
  });
  const expected = Object.values(run.counts).reduce((sum, count) => sum + count, 0);
  const usage = evidence.data ? aggregateExperimentUsage(evidence.data.result.cases, expected) : null;
  return <span className="evaluation-cost-usage">
    <ExperimentCost costUsd={run.usage.costUsd} subscription={run.model.providerId === "codex"} />
    {!run.completedAt ? <small className="evaluation-muted">Usage pending</small>
      : evidence.isPending ? <small className="evaluation-muted" role="status">Loading usage…</small>
      : evidence.error ? <button className="evaluation-link-button" title={evidence.error.message} onClick={event => { event.stopPropagation(); void evidence.refetch(); }}>Retry usage</button>
      : usage ? <small className="evaluation-muted" title={experimentTokenDetails(usage)}>{experimentTokenLabel(usage)}</small> : null}
  </span>;
}

export function HostedExperimentCost({ api, run }: { api: WorkspaceApi; run: ExperimentRunDetails }) {
  const evidence = useQuery({
    queryKey: ["evaluation-workspace", api.key, "result", run.summary.id, null],
    enabled: run.summary.resultAvailable,
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      const value = await api.request<ExperimentEvidence>("result", { id: run.summary.id }, signal);
      if (value.executionId !== run.summary.id || value.manifest.lineage?.execution.id !== run.summary.id
        || value.manifest.lineage.execution.contentHash !== run.summary.manifestHash)
        throw new Error("Cost evidence belongs to another Experiment manifest.");
      return value;
    },
  });
  if (!run.summary.resultAvailable) return ["queued", "running", "cancelling"].includes(run.summary.status)
    ? <span title="Reported cost will appear when the result is retained.">Pending</span>
    : <ExperimentCost costUsd={null} />;
  if (evidence.isPending) return <span role="status" className="evaluation-score-skeleton" aria-label="Loading retained cost" />;
  if (evidence.error) return <button className="training-text-button" title={evidence.error.message} onClick={event => { event.stopPropagation(); void evidence.refetch(); }}>Retry cost</button>;
  const cases = evidence.data.result.cases;
  const usage = aggregateExperimentUsage(cases, run.summary.totalCount);
  return <span className="evaluation-cost-usage"><ExperimentCost costUsd={usage.costUsd} /><small className="evaluation-muted" title={experimentTokenDetails(usage)}>{experimentTokenLabel(usage)}</small></span>;
}
