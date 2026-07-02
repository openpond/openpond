import type { GoalEvent, GoalRunResult, GoalState } from "./types";

export function createGoalRunResult(input: {
  goal: GoalState;
  status: GoalRunResult["status"];
  summary: string;
  events: GoalEvent[];
}): GoalRunResult {
  return {
    goalId: input.goal.id,
    status: input.status,
    summary: input.summary,
    events: input.events,
  };
}
