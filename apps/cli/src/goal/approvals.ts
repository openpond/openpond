import type { GoalApprovalKind, GoalApprovalRequest, GoalState } from "./types";

export function createGoalApprovalRequest(input: {
  goal: GoalState;
  title: string;
  reason: string;
  kind: GoalApprovalKind;
  payload?: Record<string, unknown>;
}): GoalApprovalRequest {
  return {
    goalId: input.goal.id,
    kind: input.kind,
    title: input.title,
    reason: input.reason,
    payload: input.payload ?? {},
    createdAt: new Date().toISOString(),
  };
}
