import type { GoalState } from "./types";

export function goalIterationBudgetRemaining(goal: GoalState): number {
  const startedIterations = goal.events.filter(
    (event) => event.kind === "iteration.started"
  ).length;
  return Math.max(0, goal.budget.maxIterations - startedIterations);
}

export function assertGoalBudgetAllowsIteration(goal: GoalState): void {
  if (goalIterationBudgetRemaining(goal) <= 0) {
    throw new Error("goal iteration budget exhausted");
  }
}
