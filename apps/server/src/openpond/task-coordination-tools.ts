import { z } from "zod";
import { TASK_INPUT_MAX_CHARS } from "@openpond/contracts";
import type { TaskInboxRuntime } from "../runtime/task-inbox/runtime.js";
import type { ModelToolDefinition, ModelToolExecutionContext } from "./model-tool-registry.js";

const SendSchema = z.object({
  taskId: z.string().trim().min(1), message: z.string().trim().min(1).max(TASK_INPUT_MAX_CHARS),
  replyTo: z.string().trim().min(1).optional(),
}).strict();
const WaitSchema = z.object({
  taskId: z.string().trim().min(1).optional(), turnId: z.string().trim().min(1).optional(),
  inputId: z.string().trim().min(1).optional(),
  afterSequence: z.number().int().nonnegative().optional(), timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
}).strict();

function tool(name: string, description: string, schema: z.ZodType, execute: (context: ModelToolExecutionContext) => Promise<unknown>): ModelToolDefinition {
  return { name, description, parameters: z.toJSONSchema(schema),
    enabled: ({ session }) => session.experience !== "chat" && !session.systemKind,
    execute: async (context) => {
      const data = await execute(context);
      return { toolCallId: context.callId, name, ok: true, contentText: JSON.stringify(data), data };
    } };
}

export function taskCoordinationTools(inbox: TaskInboxRuntime): ModelToolDefinition[] {
  return [
    tool("openpond_declare_task_work", "Publish the files or components this execution intends to change. These advisory claims help peers avoid conflicting edits; they do not reserve files or grant permission. Replace your areas as the assignment changes; pass an empty array to clear them.",
      z.object({ areas: z.array(z.string().trim().min(1).max(250)).max(20) }).strict(), async (context) => {
        const { areas } = z.object({ areas: z.array(z.string().trim().min(1).max(250)).max(20) }).strict().parse(context.args);
        return inbox.declareWork(context.session.id, context.turnId, areas);
      }),
    tool("openpond_list_tasks", "Discover up to 50 tasks in your authorized project or agent family, with their current execution and objective. Use when coordination would help; do not repeatedly poll.",
      z.object({}).strict(), async (context) => { z.object({}).strict().parse(context.args); return { tasks: await inbox.list(context.session.id) }; }),
    ...(["message", "followup"] as const).map((kind) => tool(
      kind === "message" ? "openpond_send_task_message" : "openpond_followup_task",
      kind === "message"
        ? "Send an attributed peer update. An active task receives it at a model boundary and a matching wait wakes. It does not restart idle work. Reply when useful; avoid acknowledgement loops."
        : "Explicitly assign more work to an existing task. Active tasks queue a new assignment; idle tasks start a turn. A user pause or approval block takes precedence. Ordinary status updates should use send_task_message.",
      SendSchema, async (context) => {
        const args = SendSchema.parse(context.args);
        const receipt = await inbox.send({ senderSessionId: context.session.id, sessionId: args.taskId,
          body: args.message, kind, replyTo: args.replyTo, idempotencyKey: `tool:${context.turnId}:${context.callId}` });
        return { receipt, note: "Acceptance is not evidence that the recipient has read or answered this message." };
      },
    )),
    tool("openpond_wait_for_task", "Suspend until the specified task execution finishes, incoming input arrives, or the deadline expires. Pins the current target turn unless turnId is supplied. For newly requested work, pass inputId from the follow-up receipt so an older completion cannot satisfy the wait. Omit taskId to wait for inbox activity. Arrival wakes immediately; timeout is not a polling interval. Do independent work first.",
      WaitSchema, async (context) => {
        const args = WaitSchema.parse(context.args);
        return inbox.wait({ sessionId: context.session.id, turnId: context.turnId, callId: context.callId,
          targetSessionId: args.taskId, targetTurnId: args.turnId, targetInputId: args.inputId, afterSequence: args.afterSequence,
          timeoutMs: args.timeoutMs, signal: context.signal });
      }),
  ];
}
