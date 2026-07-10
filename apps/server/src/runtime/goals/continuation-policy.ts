import type { OpenPondGoalControlGoal } from "../../openpond/goal-control.js";

export function normalizeOpenPondGoalForContinuation(
  value: Record<string, unknown> | null,
): OpenPondGoalControlGoal | null {
  if (!value) return null;
  const id = stringValue(value.id);
  const objective = stringValue(value.objective);
  const status = stringValue(value.status);
  if (!id || !objective || !status) return null;
  return {
    ...(value as OpenPondGoalControlGoal),
    id,
    objective,
    status: status as OpenPondGoalControlGoal["status"],
    provider: "openpond",
  };
}

export function isContinuableOpenPondGoal(goal: OpenPondGoalControlGoal): boolean {
  return goal.provider === "openpond" && (goal.status === "queued" || goal.status === "running");
}

export function openPondGoalContinuationPrompt(goal: OpenPondGoalControlGoal): string {
  return [
    "<goal_context>",
    "Continue the active OpenPond goal now.",
    "",
    `Goal ID: ${goal.id}`,
    `Objective: ${goal.objective}`,
    "",
    "This is a continuation of the goal above. Do not call openpond_goal_control with action start.",
    "Make concrete progress in this turn using the available tools and workspace context.",
    "If the goal is complete, call openpond_goal_control with action complete and include the evidence in the reason.",
    "If you cannot continue productively without user input or an external change, explain the blocker clearly and do not start an empty loop.",
    "</goal_context>",
  ].join("\n");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
