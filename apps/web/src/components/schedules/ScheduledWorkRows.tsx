import type {
  HostedSavedWorkDefinition,
  HostedSavedWorkSchedule,
  LocalAgentSchedule,
} from "@openpond/contracts";
import { formatScheduledRunAt } from "./scheduledWorkFormatting";

export function LocalScheduleRow({
  cadence,
  onSelect,
  schedule,
  selected,
}: {
  cadence: string;
  onSelect: () => void;
  schedule: LocalAgentSchedule;
  selected: boolean;
}) {
  return (
    <button
      aria-current={selected ? "true" : undefined}
      className="scheduled-list-row"
      onClick={onSelect}
      type="button"
    >
      <span
        className={`scheduled-status-dot ${schedule.enabled ? "active" : "paused"}`}
      />
      <span className="scheduled-list-copy">
        <span className="scheduled-list-title">
          <strong>{schedule.scheduleName}</strong>
        </span>
        <span>{schedule.localProjectName}</span>
        <small>
          {cadence}
          {schedule.nextRunAt
            ? ` · Next ${formatScheduledRunAt(schedule.nextRunAt, schedule.timezone)}`
            : " · No next run"}
        </small>
      </span>
    </button>
  );
}

export function HostedScheduleRow({
  cadence,
  definition,
  onSelect,
  schedule,
  selected,
}: {
  cadence: string;
  definition: HostedSavedWorkDefinition;
  onSelect: () => void;
  schedule: HostedSavedWorkSchedule;
  selected: boolean;
}) {
  return (
    <button
      aria-current={selected ? "true" : undefined}
      className="scheduled-list-row"
      onClick={onSelect}
      type="button"
    >
      <span
        className={`scheduled-status-dot ${schedule.enabled ? "active" : "paused"}`}
      />
      <span className="scheduled-list-copy">
        <span className="scheduled-list-title">
          <strong>{definition.name}</strong>
          <small className="scheduled-environment-badge hosted">Hosted</small>
        </span>
        <span>{definition.prompt}</span>
        <small>
          {cadence}
          {schedule.nextRunAt
            ? ` · Next ${formatScheduledRunAt(schedule.nextRunAt, schedule.timeZone)}`
            : " · No next run"}
        </small>
      </span>
    </button>
  );
}
