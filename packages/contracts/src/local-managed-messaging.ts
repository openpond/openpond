import { z } from "zod";
import { TASK_INPUT_MAX_CHARS, TaskInboxSnapshotSchema } from "./task-inbox.js";

/** Desktop-local presentation contract; this does not authorize remote device control. */
export const LocalManagedMessageTargetSchema = z.object({
  sessionId: z.string().min(1),
  provider: z.string().min(1),
  title: z.string(),
  targetRevision: z.string().min(1),
  managedSessionId: z.string().nullable(),
  latestTurnId: z.string().nullable(),
  activeTurnId: z.string().nullable(),
  paused: z.boolean(),
  approvalBlocked: z.boolean(),
  canSendFollowup: z.boolean(),
  canSteer: z.boolean(),
  unavailableReason: z.string().nullable(),
  inbox: TaskInboxSnapshotSchema,
}).strict();
export type LocalManagedMessageTarget = z.infer<typeof LocalManagedMessageTargetSchema>;

// The caller marker documents click intent. Authentication and local-only scope
// remain the route's responsibility; model output cannot supply authority.
export const SendLocalManagedMessageSchema = z.object({
  authority: z.literal("user_click"),
  mode: z.enum(["followup", "steer"]),
  expectedTargetRevision: z.string().min(1),
  expectedTurnId: z.string().min(1).optional(),
  prompt: z.string().trim().min(1).max(TASK_INPUT_MAX_CHARS),
  idempotencyKey: z.string().trim().min(1).max(200),
  recommendationId: z.string().min(1).max(200).optional(),
}).strict().superRefine((input, context) => {
  if (input.mode === "steer" && !input.expectedTurnId) {
    context.addIssue({ code: "custom", path: ["expectedTurnId"], message: "Active steering requires the exact observed turn." });
  }
  if (input.mode === "followup" && input.expectedTurnId) {
    context.addIssue({ code: "custom", path: ["expectedTurnId"], message: "Follow-up messages are delivered at the next turn boundary." });
  }
});
export type SendLocalManagedMessage = z.infer<typeof SendLocalManagedMessageSchema>;
