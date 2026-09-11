import { z } from "zod";
import { ReleaseHashSchema, ReleaseIdSchema, ReleaseTimestampSchema } from "@openpond/harness";
import { LearningRevisionRefSchema } from "./contracts.js";
import { NightlyScheduleSchema } from "./nightly-schedule.js";

/** The durable timer is operational state; every fire retains its own policy. */
export const LearningScheduleSchema = z.object({
  schemaVersion: z.literal("openpond.learningSchedule.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  policy: LearningRevisionRefSchema,
  modelProjectId: ReleaseIdSchema,
  executionOwner: z.enum(["local", "hosted"]),
  state: z.enum(["scheduled", "disabled", "blocked"]),
  intervalSeconds: z.number().int().min(60).max(31_536_000).nullable(),
  calendar: NightlyScheduleSchema.nullable().default(null),
  nextRunAt: ReleaseTimestampSchema.nullable(),
  lastFire: LearningRevisionRefSchema.nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  nextAttemptAt: ReleaseTimestampSchema.nullable(),
  lastError: z.string().max(20_000).nullable(),
  createdAt: ReleaseTimestampSchema,
  updatedAt: ReleaseTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.state !== "disabled" && ((!value.intervalSeconds && !value.calendar) || !value.nextRunAt))
    context.addIssue({ code: "custom", path: ["nextRunAt"], message: "An active timer must retain its cadence and due time." });
  if (value.state === "disabled" && value.nextRunAt)
    context.addIssue({ code: "custom", path: ["nextRunAt"], message: "A disabled timer cannot have a pending occurrence." });
  if (value.intervalSeconds && value.calendar) context.addIssue({ code: "custom", path: ["calendar"], message: "A timer uses either an interval or a nightly calendar." });
});

/** Immutable occurrence evidence survives timer edits and coalesced downtime. */
export const LearningScheduleFireSchema = z.object({
  schemaVersion: z.literal("openpond.learningScheduleFire.v1"),
  id: ReleaseIdSchema,
  revision: z.literal(1),
  scheduleId: ReleaseIdSchema,
  policy: LearningRevisionRefSchema,
  scheduledAt: ReleaseTimestampSchema,
  coalescedThroughAt: ReleaseTimestampSchema,
  coalescedCount: z.number().int().nonnegative(),
  outcome: z.enum(["reserved", "waiting_for_data", "waiting_for_review", "skipped"]),
  reason: z.enum(["active_iteration", "cooldown", "daily_budget"]).nullable(),
  iteration: z.object({ id: ReleaseIdSchema, revision: z.number().int().positive() }).strict().nullable(),
  createdAt: ReleaseTimestampSchema,
  contentHash: ReleaseHashSchema,
}).strict().superRefine((value, context) => {
  if ((value.outcome === "skipped") !== Boolean(value.reason) || (value.outcome !== "skipped") !== Boolean(value.iteration))
    context.addIssue({ code: "custom", path: ["outcome"], message: "A fire retains either its reservation or its explicit skip reason." });
});

export type LearningSchedule = z.infer<typeof LearningScheduleSchema>;
export type LearningScheduleFire = z.infer<typeof LearningScheduleFireSchema>;
