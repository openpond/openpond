import {
  SubagentMessageDeliverySchema, SubagentMessageSchema,
  type RuntimeEvent, type SubagentRun, type Turn, type TaskInput,
} from "@openpond/contracts";
import type { OpenPondSubagentMessageToolInput, OpenPondSubagentMessageToolResult } from "../../openpond/capability-tool-registry.js";
import type { ModelToolExecutionContext } from "../../openpond/model-tool-registry.js";
import { event, now } from "../../utils.js";
import type { TaskInboxRuntime } from "../task-inbox/runtime.js";

export function subagentActiveTurnIsDurablyTerminal(
  active: { sessionId: string; turn: { id: string } } | null, durableTurn: Turn | null,
): boolean {
  return Boolean(active && durableTurn?.id === active.turn.id && durableTurn.status !== "in_progress");
}

export function createSubagentMessagingRuntime(deps: {
  inbox: TaskInboxRuntime;
  requireSubagentDeps(): {
    getRun(id: string): Promise<SubagentRun | null>;
    listRuns(input: { parentSessionId?: string; status?: SubagentRun["status"][]; limit?: number }): Promise<SubagentRun[]>;
    appendMessage(message: ReturnType<typeof SubagentMessageSchema.parse>): Promise<unknown>;
  };
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
}) {
  async function sendSubagentMessageFromModelTool(context: ModelToolExecutionContext, input: OpenPondSubagentMessageToolInput): Promise<OpenPondSubagentMessageToolResult> {
    const runtime = deps.requireSubagentDeps();
    const parentSessionId = context.session.parentSessionId ?? context.session.id;
    const parentTarget = context.session.parentSessionId && ((!input.toRunId && !input.toRole) || input.toRunId === context.session.parentSessionId || input.toRole === "parent")
      ? context.session.parentSessionId : null;
    const candidates = input.toRunId && !parentTarget ? [await runtime.getRun(input.toRunId)]
      : input.toRole && !parentTarget ? await runtime.listRuns({ parentSessionId, status: ["queued", "running", "needs_resume"], limit: 200 }) : [];
    const runs = candidates.filter((run): run is SubagentRun => Boolean(run?.childSessionId && run.parentSessionId === parentSessionId && (!input.toRole || run.roleId === input.toRole)));
    const targets = [...(parentTarget ? [parentTarget] : []), ...runs.map((run) => run.childSessionId!)];
    if (!targets.length) throw new Error("No matching task is available for this message.");
    const messageId = `subagent_message:${context.turnId}:${context.callId}`;
    const receipts = await deps.inbox.sendMany({ senderSessionId: context.session.id, sessionIds: targets,
      body: input.body, idempotencyKey: messageId });
    const delivery = SubagentMessageDeliverySchema.parse({
      status: "pending", deliveredRunIds: runs.map((run) => run.id), deliveredParentSessionId: parentTarget,
      acknowledgedRunIds: [], acknowledgedParentSessionId: null,
      inputIds: receipts.map((receipt) => receipt.id), reason: "Accepted into the durable task inbox; model inclusion is tracked separately.",
    });
    const message = SubagentMessageSchema.parse({ id: messageId, fromRunId: context.session.subagentRunId ?? `parent:${context.session.id}`,
      toRunId: input.toRunId ?? null, toRole: input.toRole ?? null, kind: input.kind, priority: input.priority ?? "normal",
      body: input.body, refs: [], delivery, createdAt: now() });
    await runtime.appendMessage(message);
    await deps.appendRuntimeEvent(event({ sessionId: context.session.id, turnId: context.turnId,
      name: "subagent.message", source: "provider", appId: context.session.appId, status: "pending",
      output: "Peer message accepted.", data: { message, delivery, taskInputIds: delivery.inputIds } }));
    return { messageId, delivery, nextStep: "Message saved. Active recipients receive it at a model boundary; idle recipients keep it for their next turn. No reply or understanding is implied." };
  }

  async function queueSubagentFollowupMessage(input: { context: ModelToolExecutionContext; run: SubagentRun; body: string }): Promise<TaskInput> {
    if (!input.run.childSessionId) throw new Error("The child has no task conversation.");
    return deps.inbox.send({ senderSessionId: input.context.session.id, sessionId: input.run.childSessionId,
      kind: "followup", body: input.body, idempotencyKey: `subagent_followup:${input.context.turnId}:${input.context.callId}` });
  }

  return { sendSubagentMessageFromModelTool, queueSubagentFollowupMessage };
}
