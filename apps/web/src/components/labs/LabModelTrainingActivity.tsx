import type { TrainingJobEvent } from "@openpond/contracts";

import { formatDateTime } from "../training/training-model-data";

export function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function TrainingEventLog({
  error,
  events,
  loading,
}: {
  error: string | null;
  events: TrainingJobEvent[];
  loading: boolean;
}) {
  if (loading && !events.length) {
    return <div className="training-run-placeholder">Loading run events…</div>;
  }
  if (!events.length) {
    return (
      <div className="training-run-placeholder">
        {error ?? "No normalized run events were recorded."}
      </div>
    );
  }
  return (
    <div
      aria-label="Training activity log"
      aria-live="polite"
      className="training-event-log"
      role="log"
    >
      {events.map((event) => (
        <div className={`training-event-log-line ${event.type}`} key={event.id}>
          <time dateTime={event.timestamp}>{formatDateTime(event.timestamp)}</time>
          <span>{eventLabel(event.type)}</span>
          <code>{eventSummary(event)}</code>
        </div>
      ))}
      {error ? (
        <div className="training-event-log-line failure">
          <time>—</time>
          <span>Failure</span>
          <code>{error}</code>
        </div>
      ) : null}
    </div>
  );
}

function eventLabel(type: TrainingJobEvent["type"]): string {
  return type
    .replaceAll("_", " ")
    .replace(/^./, (value) => value.toUpperCase());
}

export function eventSummary(event: TrainingJobEvent): string {
  const payload = event.payload;
  const step = finiteNumber(payload.step);
  const maxSteps = finiteNumber(payload.maxSteps);
  if (typeof payload.telemetryType === "string") {
    const message =
      typeof payload.message === "string" ? payload.message : null;
    const errorCode =
      typeof payload.errorCode === "string" ? payload.errorCode : null;
    const source =
      typeof payload.telemetrySource === "string"
        ? ` · ${payload.telemetrySource}`
        : "";
    return `${message ?? payload.telemetryType.replaceAll("_", " ")}${
      step == null ? "" : ` · step ${step}`
    }${source}${errorCode ? ` · ${errorCode}` : ""}`;
  }
  if (typeof payload.remoteEventType === "string") {
    const label = remoteEventLabel(payload.remoteEventType);
    const phase =
      typeof payload.remotePhase === "string"
        ? remotePhaseLabel(payload.remotePhase)
        : null;
    const errorCode =
      typeof payload.errorCode === "string" && payload.errorCode.trim()
        ? payload.errorCode.trim()
        : null;
    return [
      label,
      phase,
      step == null ? null : `step ${step}`,
      errorCode ? `error ${errorCode}` : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (event.type === "start") {
    return typeof payload.device === "string"
      ? `Worker started on ${payload.device}.`
      : "Worker started.";
  }
  if (event.type === "progress" && step != null) {
    return maxSteps == null ? `Step ${step}.` : `Step ${step} of ${maxSteps}.`;
  }
  if (event.type === "metric") {
    const kind =
      typeof payload.metricKind === "string"
        ? payload.metricKind.replaceAll("_", " ")
        : "metric";
    const values = [
      numericSummary("loss", payload.loss),
      numericSummary("reward", payload.meanReward ?? payload.reward),
      numericSummary("policy loss", payload.policyLoss),
      numericSummary("value loss", payload.valueLoss),
      numericSummary(
        "preference accuracy",
        payload.preferenceAccuracy,
        percentValue,
      ),
    ].filter((value): value is string => Boolean(value));
    const failureClass =
      typeof payload.failureClass === "string" ? payload.failureClass : null;
    const failureCode =
      typeof payload.failureCode === "string" ? payload.failureCode : null;
    const managedMetric =
      typeof payload.metricId === "string" &&
      typeof payload.value === "number"
        ? ` · ${payload.metricId}: ${payload.value.toPrecision(4)}`
        : "";
    return `${kind}${step == null ? "" : ` · step ${step}`}${managedMetric}${
      failureClass ? ` · ${failureClass}` : ""
    }${failureCode ? ` · ${failureCode}` : ""}${
      values.length ? ` · ${values.join(" · ")}` : ""
    }`;
  }
  if (event.type === "checkpoint") {
    const policyVersion = finiteNumber(payload.policyVersion);
    const sizeBytes = finiteNumber(payload.sizeBytes);
    const details = [
      policyVersion == null ? null : `policy ${policyVersion}`,
      sizeBytes == null ? null : formatBytes(sizeBytes),
      payload.final === true ? "final" : null,
    ].filter((value): value is string => Boolean(value));
    return details.length
      ? `Checkpoint committed · ${details.join(" · ")}.`
      : "Checkpoint committed.";
  }
  if (event.type === "complete") {
    const artifactCount = finiteNumber(payload.artifactCount);
    return artifactCount == null
      ? "Worker completed."
      : `Worker completed with ${artifactCount} artifacts.`;
  }
  if (event.type === "failure" && typeof payload.message === "string") {
    return payload.message;
  }
  return Object.keys(payload).length ? JSON.stringify(payload) : "Recorded.";
}

function remoteEventLabel(value: string): string {
  const known: Record<string, string> = {
    drain: "Rollout drain",
    infer: "Model inference",
    materialize_checkpoint: "Checkpoint materialization",
    optimizer_metric: "Optimizer metric",
    provision_gpu: "GPU provisioning",
    rollout_metric: "Rollout trajectory",
    score_reward_model: "Reward scoring",
    start_inference: "Policy server",
    train_step: "Optimizer update",
    upload_checkpoint: "Checkpoint upload",
  };
  return known[value] ?? humanizeEventValue(value);
}

function remotePhaseLabel(value: string): string {
  const known: Record<string, string> = {
    committed: "committed",
    completed: "completed",
    eligible: "recorded",
    failed: "failed",
    running: "running",
    succeeded: "succeeded",
  };
  return known[value] ?? humanizeEventValue(value).toLocaleLowerCase();
}

function humanizeEventValue(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function numericSummary(
  label: string,
  value: unknown,
  format: (value: number) => string = (number) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(
      number,
    ),
): string | null {
  const number = finiteNumber(value);
  return number == null ? null : `${label} ${format(number)}`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentValue(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
