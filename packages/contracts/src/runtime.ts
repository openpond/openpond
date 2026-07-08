import { z } from "zod";
import { SUBAGENT_RUNTIME_EVENT_NAMES } from "./subagents.js";

export const RuntimeEventNameSchema = z.enum([
  "session.started",
  "turn.started",
  "assistant.delta",
  "assistant.reasoning.delta",
  "tool.started",
  "tool.completed",
  "skill.selected",
  "skill.loaded",
  "skill.load_failed",
  "approval.requested",
  "approval.resolved",
  "command.output",
  "workspace_action",
  "workspace_action_result",
  "workspace.diff",
  "create_pipeline.updated",
  "session.context.updated",
  "session.compaction.started",
  "session.compaction.completed",
  "session.compaction.failed",
  "goal.continuation.started",
  "goal.continuation.skipped",
  "goal.continuation.failed",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "session.closed",
  ...SUBAGENT_RUNTIME_EVENT_NAMES,
  "diagnostic",
]);

export type RuntimeEventName = z.infer<typeof RuntimeEventNameSchema>;

export const RuntimeEventSchema = z.object({
  id: z.string(),
  sequence: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  name: RuntimeEventNameSchema,
  timestamp: z.string(),
  source: z
    .enum(["ui_button", "chat_action", "terminal_command", "hook", "provider", "server"])
    .optional(),
  action: z.string().optional(),
  appId: z.string().nullable().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["started", "completed", "failed", "pending"]).optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  relatedDeploymentId: z.string().optional(),
  data: z.unknown().optional(),
});

export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;
