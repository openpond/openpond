import { z } from "zod";

import { goalEventRecordSchema } from "./event";
import type { GoalRunResult } from "../types";

export const goalRunResultSchema = {
  type: "object",
  required: ["goalId", "status", "summary", "events"],
  properties: {
    goalId: { type: "string" },
    status: { type: "string" },
    summary: { type: "string" },
    events: { type: "array" },
  },
} as const;

export const goalRunResultRecordSchema = z.object({
  goalId: z.string().min(1),
  status: z.enum([
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
  ]),
  summary: z.string().min(1),
  events: z.array(goalEventRecordSchema),
}) satisfies z.ZodType<GoalRunResult>;

export function assertGoalRunResultRecord(result: GoalRunResult): GoalRunResult {
  return goalRunResultRecordSchema.parse(result);
}
