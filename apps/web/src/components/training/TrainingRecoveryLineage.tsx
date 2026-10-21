import type { RunStageEvidence } from "@openpond/contracts";
import { modelsLocation, modelsPath, navigateModelsRoute } from "../labs/lab-primary-tab-state";
import "./training-recovery-lineage.css";

/** Native checkpoint recovery retains the adapter block; it is not continual learning. */
export function TrainingRecoveryLineage({
  recovery,
  compact = false,
  sourceJobId,
}: {
  recovery: RunStageEvidence["recovery"];
  compact?: boolean;
  sourceJobId?: string;
}) {
  if (!recovery) return null;
  const source = modelsLocation("runs", null, {
    area: "console",
    resourceId: `hosted-job:${sourceJobId ?? recovery.sourceJobId}`,
  });
  const checkpoint = modelsLocation("runs", null, {
    area: "console",
    resourceId: `hosted-job:${recovery.checkpointJobId ?? recovery.sourceJobId}`,
  });
  const sourceHref = modelsPath(source),
    checkpointHref = `${modelsPath(checkpoint)}#outputs`;
  return (
    <span className={`training-recovery-lineage${compact ? " compact" : ""}`}>
      <span>Resumed from</span>
      <a
        className="app-tooltip"
        data-tooltip="Open source run"
        aria-label={`Open recovery source run ${sourceJobId ?? recovery.sourceJobId}`}
        href={sourceHref}
        onClick={(event) => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          void navigateModelsRoute(source);
        }}
      >
        {(sourceJobId ?? recovery.sourceJobId).slice(0, 6)}…
      </a>
      <a
        className="app-tooltip"
        data-tooltip="Inspect recovery checkpoint in source outputs"
        aria-label={`Inspect recovery checkpoint ${recovery.checkpointId}`}
        href={checkpointHref}
      >
        {recovery.checkpointId.slice(0, 6)}…
      </a>
      {recovery.replayGroups?.length ? (
        <span>
          {recovery.replayCompleted ? "Replayed" : "Replaying"}{" "}
          {recovery.replayGroups.length === 1 ? "group" : "groups"}{" "}
          {recovery.replayGroups.map((group) => group.groupIndex + 1).join(", ")} after checkpoint
          restore · Previous update was not saved
        </span>
      ) : null}
      <span>
        Checkpoint recovery
        {compact
          ? ""
          : ` · policy v${recovery.policyVersion} · ${recovery.completedGroups} inherited groups · ${recovery.optimizerStateRestored ? "optimizer checkpoint restored" : "optimizer checkpoint not restored yet"}`}
      </span>
    </span>
  );
}
