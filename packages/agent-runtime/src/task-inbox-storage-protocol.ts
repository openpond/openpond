import { z } from "zod";

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(32_000);
const sequence = z.number().int().nonnegative();
const admission = z.object({
  id, sessionId: id, senderSessionId: id.nullable(),
  senderKind: z.enum(["user", "task", "runtime"]),
  kind: z.enum(["steer", "message", "followup", "queued", "result"]),
  body: text, payload: z.record(z.string(), z.unknown()),
  idempotencyKey: id, replyTo: id.nullable(), expectedTurnId: id.nullable(),
}).strict();
const mutation = z.discriminatedUnion("action", [
  z.object({ action: z.literal("resume"), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("cancel"), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("edit"), expectedRevision: z.number().int().positive(), body: text }).strict(),
  z.object({ action: z.literal("steer"), expectedRevision: z.number().int().positive(), expectedTurnId: id }).strict(),
]);
const wait = z.object({
  id, sessionId: id, turnId: id, targetSessionId: id.nullable(), targetTurnId: id.nullable(),
  targetInputId: id.nullable(), afterSequence: sequence, deadline: z.string(),
  state: z.enum(["waiting", "message", "completed", "failed", "interrupted", "unavailable", "timeout", "cancelled"]),
  createdAt: z.string(), updatedAt: z.string(),
}).strict();
const run = z.record(z.string(), z.unknown());
const runStatus = z.enum(["queued", "running", "completed", "failed", "cancelled", "needs_resume"]);
const runQuery = z.object({ parentSessionId: id.nullable().optional(), childSessionId: id.nullable().optional(),
  status: z.array(runStatus).nullable().optional(), afterId: z.string().max(200), limit: z.number().int().min(1).max(10) }).strict();

/** Every action has a fixed, validated shape; the host applies its trusted scope. */
export const TaskInboxStorageParamsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("recoverTaskInboxOwners"), ownerId: id }).strict(),
  z.object({ action: z.literal("hasTaskCompletion"), turnId: id }).strict(),
  z.object({ action: z.literal("taskInboxSnapshot"), sessionId: id }).strict(),
  z.object({ action: z.literal("taskInboxSnapshotInputs"), sessionId: id, afterSequence: sequence }).strict(),
  z.object({ action: z.literal("declareTaskWork"), sessionId: id, turnId: id, ownerId: id, areas: z.array(text).max(100) }).strict(),
  z.object({ action: z.literal("taskWorkAreas"), sessionId: id }).strict(),
  z.object({ action: z.literal("admitTaskInput"), input: admission }).strict(),
  z.object({ action: z.literal("admitTaskInputs"), inputs: z.array(admission).max(50) }).strict(),
  z.object({ action: z.literal("rejectTaskInput"), id, error: text }).strict(),
  z.object({ action: z.literal("getTaskInput"), id }).strict(),
  z.object({ action: z.literal("taskInputsForSession"), sessionId: id, query: z.object({ afterSequence: sequence.optional(), pendingOnly: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() }).strict() }).strict(),
  z.object({ action: z.literal("mutateTaskInput"), sessionId: id, inputId: id, change: mutation }).strict(),
  z.object({ action: z.literal("openTaskInboxTurn"), sessionId: id, turnId: id, ownerId: id }).strict(),
  z.object({ action: z.literal("renewTaskInboxTurn"), sessionId: id, turnId: id, ownerId: id }).strict(),
  z.object({ action: z.literal("pendingTaskInputs"), sessionId: id, turnId: id, afterSequence: sequence }).strict(),
  z.object({ action: z.literal("taskAssignmentInputs"), turnId: id, afterSequence: sequence }).strict(),
  z.object({ action: z.literal("pauseTaskInboxTurn"), sessionId: id, turnId: id, ownerId: id }).strict(),
  z.object({ action: z.literal("includeTaskInputs"), sessionId: id, turnId: id, ownerId: id, requestId: id }).strict(),
  z.object({ action: z.literal("settleTaskInputRequest"), requestId: id, outcome: z.enum(["resolved", "failed", "replaced"]) }).strict(),
  z.object({ action: z.literal("sealTaskInboxTurn"), sessionId: id, turnId: id, ownerId: id }).strict(),
  z.object({ action: z.literal("sealNativeTaskInboxTurn"), sessionId: id, turnId: id, ownerId: id }).strict(),
  z.object({ action: z.literal("closeTaskInboxTurn"), sessionId: id, turnId: id, ownerId: id, outcome: z.enum(["completed", "failed", "interrupted"]) }).strict(),
  z.object({ action: z.literal("taskInboxPaused"), sessionId: id }).strict(),
  z.object({ action: z.literal("reserveTaskFollowup"), sessionId: id, turnId: id, ownerId: id }).strict(),
  z.object({ action: z.literal("taskInboxWakeTargets"), afterSessionId: z.string().max(200) }).strict(),
  z.object({ action: z.literal("createTaskWait"), value: wait }).strict(),
  z.object({ action: z.literal("settleTaskWait"), id, state: wait.shape.state }).strict(),
  z.object({ action: z.literal("taskWaitsForSession"), sessionId: id, afterId: z.string().max(200) }).strict(),
  z.object({ action: z.literal("commitSubagentCompletion"), value: run, turnId: id }).strict(),
  z.object({ action: z.literal("pendingTaskCompletions"), afterTurnId: z.string().max(200) }).strict(),
  z.object({ action: z.literal("settleTaskCompletion"), turnId: id, inputId: id }).strict(),
  z.object({ action: z.literal("upsertSubagentRun"), value: run }).strict(),
  z.object({ action: z.literal("getSubagentRun"), id }).strict(),
  z.object({ action: z.literal("listSubagentRuns"), query: runQuery }).strict(),
]);

export type TaskInboxStorageParams = z.infer<typeof TaskInboxStorageParamsSchema>;
