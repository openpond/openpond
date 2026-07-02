import { randomUUID } from "node:crypto";

import { createGoalEvent, recordGoalEvent } from "../events";
import type { HostedGoalClient } from "../state/hosted";
import type { GoalStateAdapter } from "../state/adapter";
import type { GoalQuestion } from "../types";

export async function askGoalQuestion(params: {
  goalId: string;
  iterationId?: string | null;
  title: string;
  reason: string;
  required?: boolean;
  options?: GoalQuestion["options"];
  freeformAllowed?: boolean;
  localState?: GoalStateAdapter | null;
  hostedClient?: HostedGoalClient | null;
}): Promise<GoalQuestion> {
  const question: GoalQuestion = {
    id: `question_${randomUUID()}`,
    goalId: params.goalId,
    title: params.title,
    reason: params.reason,
    required: params.required ?? true,
    options: params.options ?? [],
    freeformAllowed: params.freeformAllowed ?? true,
    answeredAt: null,
  };

  await params.localState?.addQuestion(params.goalId, question);
  await params.hostedClient?.createQuestion(params.goalId, question);
  await recordGoalEvent(
    createGoalEvent({
      goalId: params.goalId,
      iterationId: params.iterationId,
      kind: "question.created",
      summary: `Question created: ${question.title}`,
      payload: {
        questionId: question.id,
        required: question.required,
        options: question.options,
        freeformAllowed: question.freeformAllowed,
      },
    }),
    { localState: params.localState, hostedClient: params.hostedClient }
  );
  return question;
}
