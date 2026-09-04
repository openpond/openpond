import type { ChatWorkflow, SavedWorkRecurrence } from "@openpond/contracts";
import { capitalize, formatLocalTime } from "./scheduledWorkFormatting";

export type ChatWorkflowFilter = "active" | "paused" | "all";

export function filterAndSortChatWorkflows(
  workflows: ChatWorkflow[],
  filter: ChatWorkflowFilter,
): ChatWorkflow[] {
  return workflows
    .filter((workflow) => {
      if (filter === "active") return workflow.enabled;
      if (filter === "paused") return !workflow.enabled;
      return true;
    })
    .sort((left, right) => {
      const leftTime = left.nextRunAt ? new Date(left.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
      const rightTime = right.nextRunAt ? new Date(right.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
      return leftTime - rightTime || left.name.localeCompare(right.name);
    });
}

export function recurrenceCadence(recurrence: SavedWorkRecurrence): string {
  const time = formatLocalTime(recurrence.localTime);
  if (recurrence.kind === "once") {
    return `Once on ${recurrence.startDate} at ${time} · ${recurrence.timeZone}`;
  }
  if (recurrence.kind === "weekdays") return `Weekdays at ${time} · ${recurrence.timeZone}`;
  if (recurrence.kind === "weekly") {
    const days = recurrence.weekdays?.map(capitalize).join(", ") ?? "Weekly";
    return `${days} at ${time} · ${recurrence.timeZone}`;
  }
  if (recurrence.kind === "monthly") {
    return `Monthly on day ${recurrence.dayOfMonth ?? 1} at ${time} · ${recurrence.timeZone}`;
  }
  return `Daily at ${time} · ${recurrence.timeZone}`;
}
