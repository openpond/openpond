import { useState } from "react";
import type { ActivityItem } from "../../lib/app-models";
import { Check, CircleDashed, LoaderCircle } from "../icons";

export function ActivityPlanCard({
  entries,
  initiallyExpanded = true,
}: {
  entries: NonNullable<ActivityItem["plan"]>;
  initiallyExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const completed = entries.filter((entry) => entry.status === "completed").length;
  const active = entries.find((entry) => entry.status === "in_progress");
  return (
    <section className="activity-plan-card" aria-label="Task progress">
      <button
        type="button"
        className="activity-plan-heading"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <strong>Task progress</strong>
        <span>
          {completed} of {entries.length} completed
        </span>
      </button>
      {!expanded && active ? (
        <p className="activity-plan-current">{active.activeForm ?? active.content}</p>
      ) : null}
      {expanded ? (
        <ol>
          {entries.map((entry, index) => (
            <li key={entry.id ?? index} data-state={entry.status}>
              {entry.status === "completed" ? (
                <Check size={13} />
              ) : entry.status === "in_progress" ? (
                <LoaderCircle size={13} />
              ) : (
                <CircleDashed size={13} />
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
