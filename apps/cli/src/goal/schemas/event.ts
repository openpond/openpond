import { z } from "zod";

import type { GoalEvent } from "../types";

export const goalEventSchema = {
  type: "object",
  required: ["id", "goalId", "kind", "summary", "payload", "createdAt"],
  properties: {
    id: { type: "string" },
    goalId: { type: "string" },
    iterationId: { type: ["string", "null"] },
    kind: { type: "string" },
    summary: { type: "string" },
    payload: { type: "object" },
    createdAt: { type: "string" },
  },
} as const;

export const goalEventRecordSchema = z.object({
  id: z.string().min(1),
  goalId: z.string().min(1),
  iterationId: z.string().min(1).nullable(),
  kind: z.enum([
    "goal.created",
    "goal.status_changed",
    "iteration.started",
    "iteration.completed",
    "question.created",
    "question.answered",
    "approval.requested",
    "approval.decided",
    "create_pipeline.created",
    "create_pipeline.status_changed",
    "create_plan.created",
    "workflow_capture.created",
    "command.started",
    "command.completed",
    "check.completed",
    "source.updated",
    "artifact.created",
    "model.usage",
    "goal.blocked",
    "goal.failed",
  ]),
  summary: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
}) satisfies z.ZodType<GoalEvent>;

export function assertGoalEventRecord(event: GoalEvent): GoalEvent {
  return goalEventRecordSchema.parse(event);
}
