export const OPENPOND_GOAL_STATUSES = [
  "queued",
  "running",
  "awaiting_user_input",
  "awaiting_approval",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "budget_limited",
] as const;

export type OpenPondGoalStatus = (typeof OPENPOND_GOAL_STATUSES)[number];

const OPENPOND_GOAL_STATUS_SET = new Set<string>(OPENPOND_GOAL_STATUSES);

export function normalizeOpenPondGoalStatus(value: string | null | undefined): OpenPondGoalStatus | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !OPENPOND_GOAL_STATUS_SET.has(normalized)) return null;
  return normalized as OpenPondGoalStatus;
}
