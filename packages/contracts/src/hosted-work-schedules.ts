import { z } from "zod";

export const HostedWorkScheduleSchema = z.object({
  id: z.string(),
  expression: z.string().nullable(),
  timeZone: z.string(),
  recurrence: z.record(z.string(), z.unknown()),
  configurationVersion: z.number().int().positive(),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastTriggeredAt: z.string().nullable(),
  delivery: z.record(z.string(), z.unknown()),
});

export const HostedWorkDefinitionSchema = z.object({
  id: z.string(),
  definitionKey: z.string(),
  version: z.number().int().positive(),
  name: z.string(),
  prompt: z.string(),
  modelId: z.string(),
  schedules: z.array(HostedWorkScheduleSchema),
});

export const HostedWorkRunSchema = z.object({
  id: z.string(),
  definitionId: z.string(),
  scheduleId: z.string().nullable(),
  definitionName: z.string(),
  definitionVersion: z.number().int().nonnegative(),
  conversationId: z.string(),
  triggerKind: z.enum(["manual", "schedule", "webhook", "retry"]),
  status: z.string(),
  notificationStatus: z.string(),
  deliveryStatus: z.string(),
  deliveryError: z.string().nullable(),
  createdAt: z.string(),
});

export const HostedWorkSchedulesResponseSchema = z.object({
  definitions: z.array(HostedWorkDefinitionSchema),
  runs: z.array(HostedWorkRunSchema),
  asOf: z.string(),
});

export const HostedWorkScheduleMutationRequestSchema = z.object({
  teamId: z.string().min(1),
  scheduleId: z.string().min(1),
});

export const HostedWorkScheduleToggleRequestSchema =
  HostedWorkScheduleMutationRequestSchema.extend({ enabled: z.boolean() });

export const HostedWorkScheduleRunRequestSchema =
  HostedWorkScheduleMutationRequestSchema.extend({
    clientRequestId: z.string().min(1),
  });

export type HostedWorkSchedulesResponse = z.infer<
  typeof HostedWorkSchedulesResponseSchema
>;
export type HostedWorkScheduleToggleRequest = z.infer<
  typeof HostedWorkScheduleToggleRequestSchema
>;
export type HostedWorkScheduleRunRequest = z.infer<
  typeof HostedWorkScheduleRunRequestSchema
>;
export type HostedWorkScheduleMutationRequest = z.infer<
  typeof HostedWorkScheduleMutationRequestSchema
>;
