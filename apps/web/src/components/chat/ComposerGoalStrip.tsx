import { ChevronDown, PanelRight } from "../icons";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";

export function ComposerGoalStrip({
  detailsOpen,
  goalRuntime,
  objectiveId,
  onOpenDetails,
  onToggleDetails,
}: {
  detailsOpen: boolean;
  goalRuntime: GoalRuntimeStatus;
  objectiveId: string;
  onOpenDetails?: () => void;
  onToggleDetails: () => void;
}) {
  return (
    <div className={`composer-goal-strip ${goalRuntime.tone}`} data-tooltip={goalRuntime.tooltip}>
      <div className="composer-goal-heading">
        <button
          type="button"
          className="composer-goal-toggle"
          aria-expanded={detailsOpen}
          aria-controls={objectiveId}
          onClick={onToggleDetails}
        >
          <span>{goalRuntime.actionLabel}</span>
          <span className="composer-goal-toggle-meta">
            <span>{goalRuntime.timeLabel}</span>
            <ChevronDown size={15} aria-hidden="true" />
          </span>
        </button>
        {onOpenDetails ? (
          <button type="button" className="composer-goal-details-button" onClick={onOpenDetails}>
            <PanelRight size={13} />
            <span>Details</span>
          </button>
        ) : null}
      </div>
      {detailsOpen && (
        <div className="composer-goal-objective" id={objectiveId}>
          {goalRuntime.objective}
        </div>
      )}
    </div>
  );
}
