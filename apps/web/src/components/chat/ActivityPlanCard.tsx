import { useId, useState } from "react";
import type { ActivityItem } from "../../lib/app-models";
import { Check, ChevronDown, CircleDashed, LoaderCircle } from "../icons";

export function ActivityPlanCard({
  entries,
  initiallyExpanded = false,
}: {
  entries: NonNullable<ActivityItem["plan"]>;
  initiallyExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const listId = useId();
  const completed = entries.filter((entry) => entry.status === "completed").length;
  const active = entries.find((entry) => entry.status === "in_progress");
  const current = active ?? entries.find((entry) => entry.status === "pending");
  const currentLabel = current
    ? (current === active ? current.activeForm : null) ?? current.content
    : "All tasks completed";
  return (
    <section className="activity-plan-card" aria-label="Task progress">
      <button
        type="button"
        className="activity-plan-heading"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={() => setExpanded((value) => !value)}
      >
        <strong className="activity-plan-title" title={currentLabel}>
          {active ? (
            <LoaderCircle aria-hidden size={13} className="activity-plan-spinner" />
          ) : current ? (
            <CircleDashed aria-hidden size={13} />
          ) : (
            <Check aria-hidden size={13} />
          )}
          <span>{currentLabel}</span>
        </strong>
        <span>
          {completed} of {entries.length} completed
          <ChevronDown aria-hidden size={13} className={`activity-plan-chevron ${expanded ? "expanded" : ""}`} />
        </span>
      </button>
      {expanded ? (
        <ol id={listId}>
          {entries.map((entry, index) => (
            <li key={entry.id ?? index} data-state={entry.status}>
              {entry.status === "completed" ? (
                <Check aria-hidden size={13} />
              ) : entry.status === "in_progress" ? (
                <LoaderCircle aria-hidden size={13} className="activity-plan-spinner" />
              ) : (
                <CircleDashed aria-hidden size={13} />
              )}
              <span>
                <span className="sr-only">{entry.status.replace("_", " ")}: </span>
                {entry.status === "in_progress" && entry.activeForm
                  ? entry.activeForm
                  : entry.content}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
