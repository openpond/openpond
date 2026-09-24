import type { ChatWorkflow, HostedSavedWorkDefinition, HostedSavedWorkSchedule, LocalAgentSchedule } from "@openpond/contracts";
import type { ScheduledCalendarItem } from "./ScheduledWorkCalendar";
import { formatLocalTime } from "./scheduledWorkFormatting";
import { recurrenceCadence } from "./chatWorkflowFormatting";

export type ScheduleFilter = "active" | "paused" | "all";
export type ScheduledRow = {
  definition: HostedSavedWorkDefinition;
  schedule: HostedSavedWorkSchedule;
};
export type CombinedScheduleRow =
  | { kind: "chat"; workflow: ChatWorkflow }
  | { kind: "local"; schedule: LocalAgentSchedule }
  | { kind: "hosted"; row: ScheduledRow };

export function scheduledRows(
  definitions: HostedSavedWorkDefinition[]
): ScheduledRow[] {
  return definitions.flatMap((definition) =>
    definition.schedules.map((schedule) => ({ definition, schedule }))
  );
}

export function filterAndSortSchedules(
  rows: ScheduledRow[],
  filter: ScheduleFilter
): ScheduledRow[] {
  return rows
    .filter((row) => {
      if (filter === "active") return row.schedule.enabled;
      if (filter === "paused") return !row.schedule.enabled;
      return true;
    })
    .sort((left, right) => {
      const timeDifference =
        scheduleTime(left.schedule.nextRunAt) -
        scheduleTime(right.schedule.nextRunAt);
      return timeDifference || left.definition.name.localeCompare(right.definition.name);
    });
}

export function filterAndSortLocalSchedules(
  schedules: LocalAgentSchedule[],
  filter: ScheduleFilter
): LocalAgentSchedule[] {
  return schedules
    .filter((schedule) => {
      if (filter === "active") return schedule.enabled;
      if (filter === "paused") return !schedule.enabled;
      return true;
    })
    .sort((left, right) => {
      const timeDifference =
        scheduleTime(left.nextRunAt) - scheduleTime(right.nextRunAt);
      return timeDifference || left.scheduleName.localeCompare(right.scheduleName);
    });
}

export function combineScheduleRows(
  chatWorkflows: ChatWorkflow[],
  localSchedules: LocalAgentSchedule[],
  hostedRows: ScheduledRow[]
): CombinedScheduleRow[] {
  return [
    ...chatWorkflows.map((workflow) => ({ kind: "chat" as const, workflow })),
    ...localSchedules.map((schedule) => ({
      kind: "local" as const,
      schedule,
    })),
    ...hostedRows.map((row) => ({ kind: "hosted" as const, row })),
  ].sort((left, right) => {
    const leftTime = scheduleTime(scheduleRowNextRunAt(left));
    const rightTime = scheduleTime(scheduleRowNextRunAt(right));
    if (leftTime !== rightTime) return leftTime - rightTime;
    const leftName = scheduleRowName(left);
    const rightName = scheduleRowName(right);
    return leftName.localeCompare(rightName);
  });
}

export function calendarItemForRow(item: CombinedScheduleRow): ScheduledCalendarItem {
  if (item.kind === "chat") {
    return {
      enabled: item.workflow.enabled,
      key: chatWorkflowKey(item.workflow.id),
      nextRunAt: item.workflow.nextRunAt,
      title: item.workflow.name,
    };
  }
  if (item.kind === "local") {
    return {
      enabled: item.schedule.enabled,
      key: localScheduleKey(item.schedule.id),
      nextRunAt: item.schedule.nextRunAt,
      title: item.schedule.scheduleName,
    };
  }
  return {
    enabled: item.row.schedule.enabled,
    key: hostedScheduleKey(item.row.schedule.id),
    nextRunAt: item.row.schedule.nextRunAt,
    title: item.row.definition.name,
  };
}

export function scheduleCadence(schedule: HostedSavedWorkSchedule): string {
  const recurrence = schedule.recurrence;
  if (!recurrence) return schedule.expression ?? "Manual";
  return recurrenceCadence(recurrence);
}

function scheduleRowNextRunAt(item: CombinedScheduleRow): string | null {
  if (item.kind === "chat") return item.workflow.nextRunAt;
  return item.kind === "local" ? item.schedule.nextRunAt : item.row.schedule.nextRunAt;
}

function scheduleRowName(item: CombinedScheduleRow): string {
  if (item.kind === "chat") return item.workflow.name;
  return item.kind === "local" ? item.schedule.scheduleName : item.row.definition.name;
}

export function localScheduleCadence(schedule: LocalAgentSchedule): string {
  const timeZone = schedule.timezone ? ` · ${schedule.timezone}` : "";
  if (schedule.scheduleType === "rate") {
    return `Every ${schedule.scheduleExpression}${timeZone}`;
  }
  const fields = schedule.scheduleExpression.trim().split(/\s+/);
  if (
    fields.length === 5 &&
    /^\d+$/.test(fields[0]!) &&
    /^\d+$/.test(fields[1]!)
  ) {
    const time = formatLocalTime(
      `${fields[1]!.padStart(2, "0")}:${fields[0]!.padStart(2, "0")}`
    );
    if (fields[2] === "*" && fields[3] === "*" && fields[4] === "*") {
      return `Daily at ${time}${timeZone}`;
    }
    if (
      fields[2] === "*" &&
      fields[3] === "*" &&
      fields[4] === "MON-FRI"
    ) {
      return `Weekdays at ${time}${timeZone}`;
    }
  }
  return `Cron ${schedule.scheduleExpression}${timeZone}`;
}

export function localScheduleKey(scheduleId: string): string {
  return `local:${scheduleId}`;
}

export function chatWorkflowKey(workflowId: string): string {
  return `chat:${workflowId}`;
}

export function profileWorkflowKey(workflowId: string): string {
  return `profile:${workflowId}`;
}

export function hostedScheduleKey(scheduleId: string): string {
  return `hosted:${scheduleId}`;
}

function scheduleTime(value: string | null): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}
