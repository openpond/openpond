import { ChevronDown } from "../icons";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";

export function ComposerGoalStrip({
  detailsOpen,
  goalRuntime,
  objectiveId,
  subagentRuntime,
  onToggleDetails,
}: {
  detailsOpen: boolean;
  goalRuntime: GoalRuntimeStatus;
  objectiveId: string;
  subagentRuntime?: SubagentRuntimeStatus | null;
  onToggleDetails: () => void;
}) {
  const tooltip = subagentRuntime?.activeCount
    ? `${goalRuntime.tooltip}. ${subagentRuntime.tooltip}`
    : goalRuntime.tooltip;
  return (
    <div className={`composer-goal-strip ${goalRuntime.tone}${subagentRuntime?.activeCount ? " has-subagents" : ""}`} data-tooltip={tooltip}>
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
            {subagentRuntime ? <span className="composer-goal-subagent-count">{subagentRuntime.label}</span> : null}
            <span>{goalRuntime.timeLabel}</span>
            <ChevronDown size={15} aria-hidden="true" />
          </span>
        </button>
      </div>
      {detailsOpen && (
        <div className="composer-goal-objective" id={objectiveId}>
          {goalRuntime.objective}
          {subagentRuntime ? (
            <span className="composer-goal-subagent-summary">{subagentRuntime.tooltip}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
