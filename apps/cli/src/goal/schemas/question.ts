import { z } from "zod";

import type { GoalAnswer, GoalQuestion } from "../types";

export const goalQuestionSchema = {
  type: "object",
  required: [
    "id",
    "goalId",
    "title",
    "reason",
    "required",
    "options",
    "freeformAllowed",
    "answeredAt",
  ],
  properties: {
    id: { type: "string" },
    goalId: { type: "string" },
    title: { type: "string" },
    reason: { type: "string" },
    required: { type: "boolean" },
    options: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "label"],
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    freeformAllowed: { type: "boolean" },
    answeredAt: { type: ["string", "null"] },
  },
} as const;

export const goalQuestionOptionRecordSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
});

export const goalQuestionRecordSchema = z.object({
  id: z.string().min(1),
  goalId: z.string().min(1),
  title: z.string().min(1),
  reason: z.string().min(1),
  required: z.boolean(),
  options: z.array(goalQuestionOptionRecordSchema),
  freeformAllowed: z.boolean(),
  answeredAt: z.string().min(1).nullable(),
}) satisfies z.ZodType<GoalQuestion>;

export const goalAnswerRecordSchema = z.object({
  id: z.string().min(1),
  goalId: z.string().min(1),
  questionId: z.string().min(1),
  optionId: z.string().min(1).nullable(),
  freeformText: z.string().min(1).nullable(),
  value: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
}) satisfies z.ZodType<GoalAnswer>;

export const goalQuestionSnapshotSchema = z.object({
  questions: z.array(goalQuestionRecordSchema),
  answers: z.array(goalAnswerRecordSchema),
});

export function assertGoalQuestionSnapshot(snapshot: {
  questions: GoalQuestion[];
  answers: GoalAnswer[];
}): { questions: GoalQuestion[]; answers: GoalAnswer[] } {
  return goalQuestionSnapshotSchema.parse(snapshot);
}
