import type { ActivityItem, ChatMessage } from "./app-models";

export const LIVE_WORK_TRACE_STEP_LIMIT = 5;

export type WorkTracePresentation = {
  expanded: boolean;
  hiddenCount: number;
  visibleActivities: ActivityItem[];
};

export function workTracePresentation(
  activities: ActivityItem[],
  traceState: ChatMessage["traceState"],
  manualExpanded: boolean | null,
): WorkTracePresentation {
  const running = traceState === "running";
  const expanded = manualExpanded ?? (running && activities.length <= LIVE_WORK_TRACE_STEP_LIMIT);
  if (expanded) {
    return { expanded, hiddenCount: 0, visibleActivities: activities };
  }
  if (running && activities.length > LIVE_WORK_TRACE_STEP_LIMIT) {
    return {
      expanded,
      hiddenCount: Math.max(0, activities.length - 1),
      visibleActivities: activities.slice(-1),
    };
  }
  return { expanded, hiddenCount: activities.length, visibleActivities: [] };
}

export function formatWorkTraceDuration(startedAt?: string, completedAt?: string): string | null {
  if (!startedAt || !completedAt) return null;
  const elapsedMs = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1_000) return null;
  const totalSeconds = Math.round(elapsedMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
