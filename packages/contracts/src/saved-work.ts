import { z } from "zod";

export const SavedWorkWeekdaySchema = z.enum([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);

export const SavedWorkRecurrenceSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["once", "daily", "weekdays", "weekly", "monthly"]),
    timeZone: z.string().trim().min(1).max(100),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    localTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
    weekdays: z.array(SavedWorkWeekdaySchema).min(1).max(7).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    end: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("never") }),
      z.object({
        kind: z.literal("on_date"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
      z.object({
        kind: z.literal("after_occurrences"),
        occurrences: z.number().int().min(1).max(100_000),
      }),
    ]),
  })
  .superRefine((value, context) => {
    if (value.kind === "weekly" && !value.weekdays?.length) {
      context.addIssue({
        code: "custom",
        message: "Weekly recurrence requires at least one weekday.",
        path: ["weekdays"],
      });
    }
    if (value.kind === "monthly" && value.dayOfMonth === undefined) {
      context.addIssue({
        code: "custom",
        message: "Monthly recurrence requires a day of month.",
        path: ["dayOfMonth"],
      });
    }
  });

export const HostedSavedWorkScheduleSchema = z.object({
  id: z.string(),
  expression: z.string().nullable(),
  timeZone: z.string(),
  recurrence: SavedWorkRecurrenceSchema.nullable(),
  configurationVersion: z.number().int(),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastTriggeredAt: z.string().nullable(),
  delivery: z.record(z.string(), z.unknown()).default({}),
});

export const HostedSavedWorkDefinitionSchema = z.object({
  id: z.string(),
  definitionKey: z.string(),
  version: z.number().int(),
  name: z.string(),
  prompt: z.string(),
  modelId: z.string(),
  schedules: z.array(HostedSavedWorkScheduleSchema),
});

export const HostedSavedWorkRunSchema = z.object({
  id: z.string(),
  definitionId: z.string(),
  scheduleId: z.string().nullable(),
  definitionName: z.string(),
  definitionVersion: z.number().int(),
  conversationId: z.string(),
  triggerKind: z.enum(["manual", "schedule", "webhook", "retry"]),
  status: z.string(),
  notificationStatus: z.string(),
  deliveryStatus: z.string(),
  deliveryError: z.string().nullable(),
  createdAt: z.string(),
});

export const HostedSavedWorkResponseSchema = z.object({
  definitions: z.array(HostedSavedWorkDefinitionSchema),
  runs: z.array(HostedSavedWorkRunSchema),
  asOf: z.string(),
  webBaseUrl: z.string().url().optional(),
});

export const CreateHostedSavedWorkRequestSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(191),
  sourceTurnId: z.string().trim().min(1).max(191).nullable().optional(),
  targetSessionId: z.string().trim().min(1).max(191).nullable().optional(),
  name: z.string().trim().min(1).max(180),
  prompt: z.string().trim().min(1).max(20_000),
  recurrence: SavedWorkRecurrenceSchema,
  modelId: z.string().trim().min(1).max(191).default("openpond-chat"),
});

export const UpdateHostedSavedWorkRequestSchema = z.union([
  z.object({ enabled: z.boolean() }),
  z.object({
    name: z.string().trim().min(1).max(180),
    prompt: z.string().trim().min(1).max(20_000),
    recurrence: SavedWorkRecurrenceSchema,
  }),
]);

export type SavedWorkWeekday = z.infer<typeof SavedWorkWeekdaySchema>;
export type SavedWorkRecurrence = z.infer<typeof SavedWorkRecurrenceSchema>;
export type HostedSavedWorkSchedule = z.infer<
  typeof HostedSavedWorkScheduleSchema
>;
export type HostedSavedWorkDefinition = z.infer<
  typeof HostedSavedWorkDefinitionSchema
>;
export type HostedSavedWorkRun = z.infer<typeof HostedSavedWorkRunSchema>;
export type HostedSavedWorkResponse = z.infer<
  typeof HostedSavedWorkResponseSchema
>;
export type CreateHostedSavedWorkRequest = z.infer<
  typeof CreateHostedSavedWorkRequestSchema
>;
export type UpdateHostedSavedWorkRequest = z.infer<
  typeof UpdateHostedSavedWorkRequestSchema
>;

export const ChatWorkflowRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export const ChatWorkflowSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  sessionTitle: z.string(),
  sourceTurnId: z.string().nullable(),
  name: z.string(),
  prompt: z.string(),
  recurrence: SavedWorkRecurrenceSchema,
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: ChatWorkflowRunStatusSchema.nullable(),
  lastRunId: z.string().nullable(),
  lastError: z.string().nullable(),
  scheduledRunCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ChatWorkflowRunSchema = z.object({
  definitionSnapshot: ChatWorkflowSchema.optional(),
  configurationSnapshot: z.record(z.string(), z.unknown()).optional(),
  id: z.string(),
  workflowId: z.string(),
  sessionId: z.string(),
  scheduledFor: z.string(),
  trigger: z.enum(["schedule", "manual"]),
  status: ChatWorkflowRunStatusSchema,
  turnId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export const CreateChatWorkflowRequestSchema = z.object({
  sessionId: z.string().trim().min(1).max(191),
  sourceTurnId: z.string().trim().min(1).max(191).nullable().optional(),
  name: z.string().trim().min(1).max(180),
  prompt: z.string().trim().min(1).max(20_000),
  recurrence: SavedWorkRecurrenceSchema,
});

export const UpdateChatWorkflowRequestSchema = z.union([
  z.object({ enabled: z.boolean() }),
  z.object({
    name: z.string().trim().min(1).max(180),
    prompt: z.string().trim().min(1).max(20_000),
    recurrence: SavedWorkRecurrenceSchema,
  }),
]);

export const ChatWorkflowsResponseSchema = z.object({
  workflows: z.array(ChatWorkflowSchema),
  runs: z.array(ChatWorkflowRunSchema),
  asOf: z.string(),
});

export type ChatWorkflowRunStatus = z.infer<
  typeof ChatWorkflowRunStatusSchema
>;
export type ChatWorkflow = z.infer<typeof ChatWorkflowSchema>;
export type ChatWorkflowRun = z.infer<typeof ChatWorkflowRunSchema>;
export type CreateChatWorkflowRequest = z.infer<
  typeof CreateChatWorkflowRequestSchema
>;
export type UpdateChatWorkflowRequest = z.infer<
  typeof UpdateChatWorkflowRequestSchema
>;
export type ChatWorkflowsResponse = z.infer<
  typeof ChatWorkflowsResponseSchema
>;
