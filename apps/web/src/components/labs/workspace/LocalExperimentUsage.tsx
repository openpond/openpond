import type { LocalExperimentPublicExecution } from "@openpond/contracts";
import { EvaluationCard } from "./EvaluationPresentation";
export function LocalExperimentUsage({
  execution,
}: {
  execution: Pick<
    LocalExperimentPublicExecution,
    "kind" | "usage" | "maximumCostUsd" | "cleanupComplete"
  >;
}) {
  return (
    <EvaluationCard
      title={execution.kind === "scoring" ? "Scoring pass usage" : "Experiment usage"}
    >
      <p>
        {execution.usage.costUsd === null
          ? "Total spend unknown"
          : `$${execution.usage.costUsd.toFixed(6)} measured spend`}{" "}
        · ${execution.usage.knownCostUsd.toFixed(6)} known subtotal
      </p>
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
