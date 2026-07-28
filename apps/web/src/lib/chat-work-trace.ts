import type { ActivityItem } from "./app-models";

export type WorkTracePresentation = {
  toolCount: number;
  toolsExpanded: boolean;
  visibleActivities: ActivityItem[];
};

export function workTracePresentation(
  activities: ActivityItem[],
  toolsExpanded: boolean,
): WorkTracePresentation {
  const toolCount = activities.reduce(
    (count, activity) => count + (isInlineWorkTraceActivity(activity) ? 0 : 1),
    0,
  );
  return {
    toolCount,
    toolsExpanded,
    visibleActivities: toolsExpanded
      ? activities
      : activities.filter(isInlineWorkTraceActivity),
  };
}

export function isInlineWorkTraceActivity(activity: ActivityItem): boolean {
  return activity.kind === "reasoning";
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
