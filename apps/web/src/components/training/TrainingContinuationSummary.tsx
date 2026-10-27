import type { RunStageEvidence } from "@openpond/contracts";

/** Configuration and execution evidence stay distinct: enabled is not loaded. */
export function TrainingContinuationSummary({
  parent,
  optimizerMode,
  materialized,
}: {
  parent: string;
  optimizerMode: "continue" | "reset";
  materialized?: boolean;
}) {
  return (
    <section className="labs-run-summary-card" aria-label="Continual learning">
      <header>
        <h3>Continual learning</h3>
      </header>
      <dl className="labs-run-detail-list">
        <div>
          <dt>Starting adapter</dt>
          <dd>{parent}</dd>
        </div>
        <div>
          <dt>Continuation</dt>
          <dd>
            {materialized === undefined
              ? "Enabled"
              : materialized
                ? "Parent adapter loaded"
                : "Awaiting parent adapter"}
          </dd>
        </div>
        <div>
          <dt>Optimizer state</dt>
          <dd>{optimizerMode === "reset" ? "Reset for this run" : "Continue from parent"}</dd>
        </div>
      </dl>
    </section>
  );
}

export function RecordedTrainingContinuation({
  continuation,
}: {
  continuation?: RunStageEvidence["continuation"];
}) {
  return continuation ? (
    <TrainingContinuationSummary
      parent={`Checkpoint ${continuation.checkpointId}`}
      optimizerMode={continuation.optimizerMode}
      materialized={continuation.materialized}
    />
  ) : null;
}
