import type { CorrelatedTelemetryReceipt } from "@openpond/contracts";

import { ChevronRight } from "../icons";
import { LabStatusBadge } from "./LabStatusBadge";

export function LabModelRunSummary({
  title,
  status,
  statusValue,
  versionStatus,
  method,
  baseModel,
  taskset,
  compute,
  duration,
  output,
  reward,
  telemetry,
  failure,
  onOpenTaskset,
}: {
  title: string;
  status: string;
  statusValue: string;
  versionStatus: string;
  method: string;
  baseModel: string;
  taskset: string;
  compute: string;
  duration: string;
  output: string;
  reward: number | null;
  telemetry: CorrelatedTelemetryReceipt | null;
  failure: string | null;
  onOpenTaskset?: () => void;
}) {
  const cost =
    telemetry?.cost.providerReportedUsd ?? telemetry?.cost.estimatedUsd ?? null;

  return (
    <div className="labs-model-run-summary">
      <section className="labs-run-outcome-card">
        <header>
          <div>
            <div className="labs-run-title-row">
              <h2>{title}</h2>
              <LabStatusBadge label={status} value={statusValue} />
            </div>
            <p>
              {trainingDescription(method)} on {baseModel}
            </p>
          </div>
        </header>
        <dl className="labs-run-outcome-grid">
          <SummaryMetric
            primary
            label="Final reward"
            value={reward === null ? "Not reported" : reward.toFixed(3)}
          />
          <SummaryMetric label="Output" value={output} />
          <SummaryMetric label="Duration" value={duration} />
          <SummaryMetric
            label={
              telemetry?.cost.providerReportedUsd === null
                ? "Estimated cost"
                : "Run cost"
            }
            value={cost === null ? "Not reported" : `$${cost.toFixed(4)}`}
          />
        </dl>
      </section>

      <div className="labs-run-summary-columns">
        <section className="labs-run-summary-card">
          <header>
            <h3>Run setup</h3>
          </header>
          <dl className="labs-run-detail-list">
            <DetailFact label="Training method" value={method} />
            <DetailFact label="Base model" value={baseModel} />
            <DetailFact label="Compute" value={compute} />
            <DetailFact label="Version status" value={versionStatus} />
            <div>
              <dt>Taskset</dt>
              <dd>
                {onOpenTaskset ? (
                  <button
                    className="labs-run-taskset-link"
                    type="button"
                    onClick={onOpenTaskset}
                  >
                    <span>{taskset}</span>
                    <ChevronRight aria-hidden="true" size={14} />
                  </button>
                ) : (
                  taskset
                )}
              </dd>
            </div>
          </dl>
        </section>

        <section className="labs-run-summary-card">
          <header>
            <h3>Resource usage</h3>
          </header>
          {telemetry ? (
            <dl className="labs-run-usage-grid">
              <UsageFact
                label="GPU"
                value={
                  telemetry.resource.gpuCount === null &&
                  telemetry.resource.gpuType === null
                    ? "Not reported"
                    : `${telemetry.resource.gpuCount ?? "—"} × ${
                        telemetry.resource.gpuType
                          ? humanizeResourceLabel(telemetry.resource.gpuType)
                          : "unreported"
                      }`
                }
              />
              <UsageFact
                label="Tokens"
                value={`${formatCount(
                  telemetry.usage.promptTokens
                )} prompt · ${formatCount(
                  telemetry.usage.generatedTokens
                )} generated`}
              />
              <UsageFact
                label="Trajectories"
                value={`${formatCount(
                  telemetry.usage.successfulTrajectories
                )} succeeded · ${formatCount(
                  telemetry.usage.failedTrajectories
                )} failed`}
              />
              <UsageFact
                label="Optimizer updates"
                value={formatCount(telemetry.usage.optimizerSteps)}
              />
              <UsageFact
                label="GPU time"
                value={
                  telemetry.usage.gpuSeconds === null
                    ? "Not reported"
                    : `${telemetry.usage.gpuSeconds.toFixed(1)} seconds`
                }
              />
            </dl>
          ) : (
            <p className="labs-run-usage-empty">
              Resource usage was not retained for this run.
            </p>
          )}
        </section>
      </div>

      {failure ? <p className="labs-training-error">{failure}</p> : null}
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  primary = false,
}: {
  label: string;
  value: string;
  primary?: boolean;
}) {
  return (
    <div className={primary ? "primary" : undefined}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function DetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function UsageFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatCount(value: number | null): string {
  return value === null ? "Not reported" : value.toLocaleString();
}

function trainingDescription(method: string): string {
  return method === "RFT" ? "Reinforcement fine-tuning" : `${method} training`;
}

function humanizeResourceLabel(value: string): string {
  return value
    .split(" · ")
    .map((part) =>
      part
        .replaceAll("_", " ")
        .replace(/\b[a-z]/g, (character) => character.toUpperCase())
    )
    .join(" · ");
}
