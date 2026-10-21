import "./run-flow-diagram.css";
import { TrainingRecoveryLineage } from "./TrainingRecoveryLineage";
import { useRunEvidenceTooltip } from "./useRunEvidenceTooltip";
import type { RunStageEvidence } from "@openpond/contracts";
import { GitBranch, Layers, Check } from "../icons";
import { modelsLocation, modelsPath } from "../labs/models-route";

type Continuation = RunStageEvidence["continuation"];
export function TrainingRunLineage({
  continuation,
  recovery,
  compact = false,
}: {
  continuation?: Pick<NonNullable<Continuation>, "sourceJobId" | "checkpointId">;
  recovery?: RunStageEvidence["recovery"];
  compact?: boolean;
}) {
  if (recovery) return <TrainingRecoveryLineage recovery={recovery} compact={compact} />;
  if (!continuation) return null;
  const href = modelsPath(
    modelsLocation("runs", null, {
      area: "console",
      resourceId: `hosted-run:${continuation.sourceJobId}`,
    }),
  );
  const short = (value: string) => `${value.slice(0, 6)}…`;
  return (
    <div className={`training-run-lineage${compact ? " training-run-lineage-compact" : ""}`}>
      {compact ? null : <span>Continues from</span>}
      <a href={href} aria-label={`Open parent run ${continuation.sourceJobId}`}>
        <GitBranch size={12} aria-hidden />
        {short(continuation.sourceJobId)}
      </a>
      <a
        href={`${href}#outputs`}
        aria-label={`Inspect checkpoint ${continuation.checkpointId} in parent run outputs`}
      >
        <Layers size={12} aria-hidden />
        {short(continuation.checkpointId)}
      </a>
    </div>
  );
}

export function OptimizerResetIndicator({ continuation }: { continuation?: Continuation }) {
  return continuation?.optimizerMode === "reset" ? (
    <span
      className="training-optimizer-reset app-tooltip"
      data-tooltip="Optimizer state reset; parent adapter weights retained"
      aria-label="Optimizer state reset for this run"
    >
      Optimizer reset
    </span>
  ) : null;
}

export function TrainingAdapterStack({
  continuation,
}: {
  continuation: NonNullable<Continuation>;
}) {
  return (
    <div className="training-adapter-stack" aria-label="Continual adapter lineage">
      <div className="training-adapter-parent">
        <span>Frozen parent</span>
        <b>{continuation.parentRank ? `Rank ${continuation.parentRank}` : "Rank unavailable"}</b>
      </div>
      <div className="training-adapter-current">
        <strong>Continual learning</strong>
        <span>This update</span>
        <b>
          {continuation.trainableRank ? `Rank ${continuation.trainableRank}` : "Rank unavailable"}
        </b>
        <small>{continuation.materialized ? "Parent materialized" : "Materialization pending"}</small>
      </div>
    </div>
  );
}

export function ContinualLearningStatus({ enabled }: { enabled?: boolean }) {
  const message =
    enabled === undefined
      ? "Continual learning configuration is loading."
      : `Continual learning ${enabled ? "is configured" : "is not configured"} for this run. This setting does not indicate current execution.`;
  const { triggerProps, tooltip } = useRunEvidenceTooltip(message);
  return (
    <span
      {...triggerProps}
      tabIndex={0}
      className="training-continual-setting"
      aria-label={message}
    >
      Continual learning{" "}
      <small
        className={`training-continual-badge${enabled === undefined ? " pending" : enabled ? "" : " off"}`}
      >
        {enabled ? <Check size={10} aria-hidden="true" /> : null}
        {enabled === undefined ? "…" : enabled ? "On" : "Off"}
      </small>
      {tooltip}
    </span>
  );
}
