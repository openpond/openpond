import type { LocalExperimentPublicExecution } from "@openpond/contracts";
import { EvaluationCard } from "./EvaluationPresentation";
import { ExperimentCost } from "./ExperimentCost";
import { aggregateExperimentUsage, experimentTokenDetails, experimentTokenLabel } from "./experiment-usage";
export function LocalExperimentUsage({
  execution,
  evidence,
}: {
  execution: Pick<
    LocalExperimentPublicExecution,
    "kind" | "usage" | "maximumCostUsd" | "cleanupComplete" | "counts"
  >;
  evidence?: Parameters<typeof aggregateExperimentUsage>[0];
}) {
  const tokens = evidence ? aggregateExperimentUsage(evidence, Object.values(execution.counts).reduce((sum, count) => sum + count, 0)) : null;
  return (
    <EvaluationCard
      title={execution.kind === "scoring" ? "Scoring pass usage" : "Experiment usage"}
    >
      <p>
        <ExperimentCost costUsd={execution.usage.costUsd} />{" "}
        · ${execution.usage.knownCostUsd.toFixed(6)} known subtotal
      </p>
      {tokens ? <p title={experimentTokenDetails(tokens)}>{experimentTokenLabel(tokens)} · {tokens.inputTokens?.toLocaleString("en-US") ?? "unknown"} input · {tokens.outputTokens?.toLocaleString("en-US") ?? "unknown"} output</p> : null}
      {execution.usage.costUsd === null ? <p>A billed dollar or credit amount was not reported. The held amount is a budget reservation, not a measured charge.</p> : null}
      <p>
        ${execution.usage.heldUsd.toFixed(6)} held · {execution.usage.uncertainRequests} uncertain
        requests · ${execution.maximumCostUsd} ceiling
      </p>
      <p>{execution.cleanupComplete ? "Cleanup confirmed" : "Cleanup not confirmed"}</p>
      {execution.usage.uncertainRequests ? (
        <p>
          Uncertain target calls are retained for recovery and are never replayed automatically.
        </p>
      ) : null}
    </EvaluationCard>
  );
}
