import type { ModelRun } from "@openpond/contracts";

export function LabLifecycleRunMetrics({ run }: { run: ModelRun }) {
  const telemetry = run.receipt?.telemetry ?? null;
  const cost =
    telemetry?.cost.providerReportedUsd ?? telemetry?.cost.estimatedUsd ?? null;
  const hasResults = run.reward !== null || telemetry !== null;

  if (!hasResults) {
    return (
      <div className="training-run-placeholder">
        No performance metrics were retained for this run.
      </div>
    );
  }

  return (
    <div className="training-run-evaluation">
      <div className="training-metric-summary">
        <Metric
          label="Final reward"
          value={run.reward ? run.reward.raw.toFixed(3) : "Not reported"}
        />
        <Metric
          label="Optimizer updates"
          value={formatCount(telemetry?.usage.optimizerSteps)}
        />
        <Metric
          label="Successful trajectories"
          value={formatCount(telemetry?.usage.successfulTrajectories)}
        />
        <Metric
          label="Cost"
          value={cost === null ? "Not reported" : `$${cost.toFixed(4)}`}
        />
      </div>
      {telemetry ? (
        <dl className="labs-inline-facts">
          <Fact
            label="Tokens"
            value={`${formatCount(
              telemetry.usage.promptTokens
            )} prompt · ${formatCount(
              telemetry.usage.generatedTokens
            )} generated`}
          />
          <Fact
            label="Trajectories"
            value={`${formatCount(
              telemetry.usage.successfulTrajectories
            )} succeeded · ${formatCount(
              telemetry.usage.failedTrajectories
            )} failed`}
          />
          <Fact
            label="GPU time"
            value={
              telemetry.usage.gpuSeconds === null
                ? "Not reported"
                : `${telemetry.usage.gpuSeconds.toFixed(1)} seconds`
            }
          />
          <Fact
            label="GPU"
            value={
              telemetry.resource.gpuCount === null &&
              telemetry.resource.gpuType === null
                ? "Not reported"
                : `${telemetry.resource.gpuCount ?? "—"} × ${
                    telemetry.resource.gpuType ?? "unreported"
                  }`
            }
          />
        </dl>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "Not reported"
    : value.toLocaleString();
}
