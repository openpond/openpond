import type {
  CorrelatedTelemetryReceipt,
  ManagedTrainingRunEvidence,
} from "@openpond/contracts";
import type { ReactNode } from "react";

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
  evidence,
  configuration,
  children,
  failure,
  onOpenTaskset,
}: {
  title: string;
  status: string;
  statusValue: string;
  versionStatus: string | null;
  method: string;
  baseModel: string;
  taskset: string;
  compute: string;
  duration: string;
  output: string;
  reward: number | null;
  telemetry: CorrelatedTelemetryReceipt | null;
  evidence: ManagedTrainingRunEvidence | null;
  configuration: Array<{ label: string; value: string }>;
  children?: ReactNode;
  failure: string | null;
  onOpenTaskset?: () => void;
}) {
  const cost =
    telemetry?.cost.providerReportedUsd ??
    telemetry?.cost.estimatedUsd ??
    evidence?.cost.totalUsd ??
    null;

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
      </section>

      {children}

      <section className="labs-run-summary-card">
        <header>
          <h3>Run setup</h3>
        </header>
        <dl className="labs-run-detail-list">
          <DetailFact label="Training method" value={method} />
          <DetailFact label="Base model" value={baseModel} />
          <DetailFact label="Compute" value={compute} />
          <DetailFact label="Output" value={output} />
          {versionStatus ? (
            <DetailFact label="Version status" value={versionStatus} />
          ) : null}
          <DetailFact label="Duration" value={duration} />
          <DetailFact
            label="Run cost"
            value={cost === null ? "Not reported" : `$${cost.toFixed(4)}`}
          />
          <DetailFact
            label="Final reward"
            value={reward === null ? "Not reported" : reward.toFixed(4)}
          />
          {configuration.map((fact) => (
            <DetailFact
              key={fact.label}
              label={fact.label}
              value={fact.value}
            />
          ))}
          {telemetry || evidence ? (
            <>
              <UsageFact
                label="GPU"
                value={gpuLabel(telemetry, evidence)}
              />
              <UsageFact
                label="Tokens"
                value={`${formatCount(
                  telemetry?.usage.promptTokens ??
                    evidence?.usage.inputTokens ??
                    null
                )} prompt · ${formatCount(
                  telemetry?.usage.generatedTokens ??
                    evidence?.usage.outputTokens ??
                    null
                )} generated`}
              />
              <UsageFact
                label="Trajectories"
                value={`${formatCount(
                  telemetry?.usage.successfulTrajectories ??
                    evidence?.reward.eligibleTrajectoryCount ??
                    null
                )} succeeded · ${formatCount(
                  telemetry?.usage.failedTrajectories ??
                    (evidence
                      ? evidence.reward.trajectoryCount -
                        evidence.reward.eligibleTrajectoryCount
                      : null)
                )} failed`}
              />
              <UsageFact
                label="Optimizer updates"
                value={formatCount(
                  telemetry?.usage.optimizerSteps ??
                    evidence?.progress.committedOptimizerSteps ??
                    null
                )}
              />
              <UsageFact
                label="GPU time"
                value={
                  telemetry?.usage.gpuSeconds == null
                    ? "Not reported"
                    : `${telemetry.usage.gpuSeconds.toFixed(1)} seconds`
                }
              />
            </>
          ) : (
            <DetailFact
              label="Resource usage"
              value="Not retained for this run"
            />
          )}
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

      {failure ? <p className="labs-training-error">{failure}</p> : null}
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
  return <DetailFact label={label} value={value} />;
}

function gpuLabel(
  telemetry: CorrelatedTelemetryReceipt | null,
  evidence: ManagedTrainingRunEvidence | null,
): string {
  const count =
    telemetry?.resource.gpuCount ?? evidence?.resource.gpuCount ?? null;
  const type =
    telemetry?.resource.gpuType ?? evidence?.resource.gpuType ?? null;
  if (count === null && type === null) return "Not reported";
  return `${count ?? "Unknown"} × ${
    type ? humanizeResourceLabel(type) : "Unreported"
  }`;
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
