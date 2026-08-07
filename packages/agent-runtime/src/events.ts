import { z } from "zod";

import { canonicalHash } from "./canonical.js";

export const AgentEventNameSchema = z.enum([
  "thread.started",
  "thread.resumed",
  "turn.started",
  "turn.steered",
  "turn.interrupted",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.delta",
  "item.completed",
  "assistant.reasoning.delta",
  "assistant.delta",
  "tool.started",
  "tool.completed",
  "approval.requested",
  "approval.resolved",
  "user_input.requested",
  "user_input.resolved",
  "compaction.started",
  "compaction.completed",
  "harness.admitted",
  "harness.refiner.queued",
  "harness.refiner.started",
  "harness.refiner.completed",
  "harness.refiner.failed",
  "diagnostic"
]);

export const CanonicalAgentEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  name: AgentEventNameSchema,
  source: z.enum(["runtime", "provider", "tool", "host", "refiner"]),
  status: z.string().trim().min(1).nullable().default(null),
  threadId: z.string().trim().min(1),
  turnId: z.string().trim().min(1).nullable().default(null),
  callId: z.string().trim().min(1).nullable().default(null),
  output: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  data: z.record(z.string(), z.unknown()).default({})
}).strict();

export type CanonicalAgentEvent = z.infer<typeof CanonicalAgentEventSchema>;

export function canonicalEventHash(event: CanonicalAgentEvent): string {
  return canonicalHash(CanonicalAgentEventSchema.parse(event));
}
