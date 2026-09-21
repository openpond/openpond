import {
  SubagentMessageDeliverySchema, SubagentMessageSchema,
  type RuntimeEvent, type Session, type SubagentMessage, type SubagentRef, type SubagentRun,
} from "@openpond/contracts";
import { event, now } from "../../utils.js";
import type { TaskInboxRuntime } from "../task-inbox/runtime.js";
import type { TaskInboxRepository } from "../../store/store-task-inbox.js";

export function createSubagentCompletionRuntime(deps: {
  inbox: TaskInboxRuntime;
  store: TaskInboxRepository;
  appendMessage(message: SubagentMessage): Promise<unknown>;
  getSession(id: string): Promise<Session>;
  appendRuntimeEvent(event: RuntimeEvent): Promise<void>;
}) {
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let recovering: Promise<number> | null = null;
  let closed = false;
  const reportedFailures = new Set<string>();
  function retryLater() {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void recoverPendingCompletions().catch(() => retryLater());
    }, 15_000);
    retryTimer.unref();
  }
  async function deliverCompletion(input: {
    run: SubagentRun; parentSession: Session; childSession: Session; childTurnId: string;
    body: string; refs?: SubagentRef[];
  }): Promise<SubagentMessage> {
    const receipt = await deps.inbox.send({ senderSessionId: input.childSession.id, sessionId: input.parentSession.id,
      kind: "result", body: input.body || "Child conversation completed.", idempotencyKey: `completion:${input.childTurnId}` });
    const delivery = SubagentMessageDeliverySchema.parse({ status: "pending", deliveredParentSessionId: input.parentSession.id,
      acknowledgedParentSessionId: null, inputIds: [receipt.id], reason: "Durable completion report accepted; delivery does not restart an idle parent." });
    const message = SubagentMessageSchema.parse({ id: `subagent_completion_${input.childTurnId}`,
      fromRunId: input.run.id, toRunId: null, toRole: "parent", kind: "handoff", priority: "normal",
      body: input.body || "Child conversation completed.", refs: input.refs ?? [], delivery, createdAt: now() });
    await deps.appendMessage(message);
    await deps.store.settleTaskCompletion(input.childTurnId, receipt.id);
    reportedFailures.delete(input.childTurnId);
    deps.inbox.signals.notify(input.childSession.id);
    await deps.appendRuntimeEvent(event({ sessionId: input.parentSession.id, turnId: input.run.parentTurnId ?? undefined,
      name: "subagent.message", source: "server", appId: input.parentSession.appId, status: "pending",
      output: `${input.run.roleId} child ${input.run.status}.`, data: { message, delivery, taskInputIds: [receipt.id], childSessionId: input.childSession.id } }));
    return message;
  }

  async function notifyParentOfSubagentCompletion(input: Parameters<typeof deliverCompletion>[0]): Promise<SubagentMessage | null> {
    try { return await deliverCompletion(input); }
    catch (error) {
      retryLater();
      if (!reportedFailures.has(input.childTurnId)) {
        reportedFailures.add(input.childTurnId);
        await deps.appendRuntimeEvent(event({ sessionId: input.parentSession.id, name: "diagnostic", source: "server",
          status: "failed", output: `Completion report remains pending: ${String(error)}`, data: { childTurnId: input.childTurnId } }));
      }
      return null;
    }
  }

  async function recoverBatch(): Promise<number> {
    let recovered = 0;
    let cursor = "";
    while (true) {
      const pending = await deps.store.pendingTaskCompletions(cursor);
      if (!pending.length) return recovered;
      for (const { turnId, run } of pending) {
        cursor = turnId;
        try {
        if (closed) return recovered;
        if (!run.childSessionId) continue;
        const [parentSession, childSession] = await Promise.all([deps.getSession(run.parentSessionId), deps.getSession(run.childSessionId)]);
        const delivered = await notifyParentOfSubagentCompletion({ run, parentSession, childSession, childTurnId: turnId,
          body: completionBody(run), refs: [...(run.report?.artifacts ?? []), ...(run.report?.patchRef ? [run.report.patchRef] : []), ...(run.report?.diffRef ? [run.report.diffRef] : [])] });
        if (delivered) recovered += 1;
        } catch (error) {
          retryLater();
          if (reportedFailures.has(turnId)) continue;
          reportedFailures.add(turnId);
          await deps.appendRuntimeEvent(event({ sessionId: run.parentSessionId, name: "diagnostic",
            source: "server", status: "failed", output: `Completion report remains pending: ${String(error)}`,
            data: { runId: run.id, childTurnId: turnId } }));
        }
      }
    }
  }
  function recoverPendingCompletions(): Promise<number> {
    if (recovering) return recovering;
    const work = recoverBatch();
    recovering = work;
    void work.finally(() => { if (recovering === work) recovering = null; }).catch(() => {});
    return work;
  }
  return { notifyParentOfSubagentCompletion, recoverPendingCompletions,
    close: async () => { closed = true; if (retryTimer) clearTimeout(retryTimer); await recovering; },
  };
}

export function completionBody(run: SubagentRun): string {
  return [run.report?.summary || `Child conversation ${run.status}.`, run.error ? `Error: ${run.error}` : null].filter(Boolean).join("\n\n");
}
