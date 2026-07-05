import { z } from "zod";

export const LocalAgentScheduleTypeSchema = z.enum(["cron", "rate"]);
export type LocalAgentScheduleType = z.infer<typeof LocalAgentScheduleTypeSchema>;

export const LocalAgentScheduleRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);
export type LocalAgentScheduleRunStatus = z.infer<
  typeof LocalAgentScheduleRunStatusSchema
>;

export const LocalAgentScheduleSchema = z.object({
  id: z.string(),
  localProjectId: z.string(),
  localProjectName: z.string(),
  agentRootPath: z.string(),
  agentName: z.string(),
  scheduleName: z.string(),
  scheduleType: LocalAgentScheduleTypeSchema,
  scheduleExpression: z.string(),
  timezone: z.string().nullable(),
  targetAction: z.string(),
  input: z.record(z.string(), z.unknown()).optional().default({}),
  enabledByDefault: z.boolean(),
  enabled: z.boolean(),
  sourceHash: z.string(),
  manifestHash: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: LocalAgentScheduleRunStatusSchema.nullable(),
  lastRunId: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LocalAgentSchedule = z.infer<typeof LocalAgentScheduleSchema>;

export const LocalAgentScheduleRunSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  localProjectId: z.string(),
  scheduleName: z.string(),
  scheduledFor: z.string(),
  trigger: z.enum(["schedule", "manual"]),
  status: LocalAgentScheduleRunStatusSchema,
  targetAction: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  stdout: z.string().nullable(),
  stderr: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  traceArtifactRef: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LocalAgentScheduleRun = z.infer<typeof LocalAgentScheduleRunSchema>;

export const LocalAgentSchedulesResponseSchema = z.object({
  schedules: z.array(LocalAgentScheduleSchema),
  scheduler: z.object({
    running: z.boolean(),
    nextTickAt: z.string().nullable(),
    lastSyncAt: z.string().nullable(),
    scanRunning: z.boolean(),
  }),
});
export type LocalAgentSchedulesResponse = z.infer<
  typeof LocalAgentSchedulesResponseSchema
>;

export const LocalAgentScheduleRunsResponseSchema = z.object({
  runs: z.array(LocalAgentScheduleRunSchema),
});
export type LocalAgentScheduleRunsResponse = z.infer<
  typeof LocalAgentScheduleRunsResponseSchema
>;

export const PatchLocalAgentScheduleRequestSchema = z.object({
  enabled: z.boolean().optional(),
});
export type PatchLocalAgentScheduleRequest = z.infer<
  typeof PatchLocalAgentScheduleRequestSchema
>;

export const LocalAgentScheduleRunNowRequestSchema = z.object({
  input: z.record(z.string(), z.unknown()).optional(),
});
export type LocalAgentScheduleRunNowRequest = z.infer<
  typeof LocalAgentScheduleRunNowRequestSchema
>;

export const LocalAgentScheduleRunResponseSchema = z.object({
  schedule: LocalAgentScheduleSchema,
  run: LocalAgentScheduleRunSchema,
});
export type LocalAgentScheduleRunResponse = z.infer<
  typeof LocalAgentScheduleRunResponseSchema
>;
