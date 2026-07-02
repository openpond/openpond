import type { GoalState } from "./types";

export function canAutoUpdateSource(goal: GoalState): boolean {
  return goal.executionPolicy.sourceUpdates === "auto_commit_push_default_branch";
}

export function requiresApprovalForExternalEffect(goal: GoalState): boolean {
  return goal.executionPolicy.externalEffects === "approval_required";
}

export function assertGoalCanStartIteration(goal: GoalState): void {
  if (
    goal.status === "cancelled" ||
    goal.status === "completed" ||
    goal.status === "failed"
  ) {
    throw new Error(`goal is terminal: ${goal.status}`);
  }
  if (goal.status === "paused") throw new Error("goal is paused");
  if (goal.status === "awaiting_user_input") {
    throw new Error("goal is awaiting required user input");
  }
  if (goal.status === "awaiting_approval") {
    throw new Error("goal is awaiting approval");
  }
}
