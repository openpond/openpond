import {
  SubagentMessageDeliverySchema,
  SubagentMessageSchema,
  type RuntimeEvent,
  type Session,
  type SubagentMessage,
  type SubagentRef,
  type SubagentRun,
  type Turn,
} from "@openpond/contracts";
import { event, now, textFromUnknown } from "../../utils.js";
import type { BackgroundWorkerQueue, BackgroundWorkReceipt } from "../background-worker-queue.js";
import type { KeyedRegistry } from "../turns/keyed-registry.js";
import { truncateForModelAside } from "../turns/value-utils.js";

const COMPLETION_BODY_MAX_CHARS = 4_000;
const COMPLETION_BATCH_MAX_CHARS = 12_000;
const PARENT_IDLE_POLL_MS = 250;
const COMPLETION_COALESCE_MS = 50;

type PendingCompletion = {
  message: SubagentMessage;
  run: SubagentRun;
  childSession: Session;
};

type CompletionNotification = {
  messageId: string;
  queuedAt: string;
  settledAt: string | null;
  outcome: "continued" | "goal_not_running" | "joined" | null;
};

export function createSubagentCompletionRuntime(deps: {
  appendMessage(message: SubagentMessage): Promise<unknown>;
  listMessages(input: { fromRunId?: string; limit?: number }): Promise<SubagentMessage[]>;
  getRun(runId: string): Promise<SubagentRun | null>;
  listRuns(input: { limit?: number }): Promise<SubagentRun[]>;
  upsertRun(run: SubagentRun): Promise<SubagentRun>;
  getSession(sessionId: string): Promise<Session>;
  hasParentWakeTurn(sessionId: string, messageId: string): Promise<boolean>;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  currentGoal(sessionId: string): Promise<unknown>;
  turnFollowUpQueue: BackgroundWorkerQueue;
  parentWakeJobs: KeyedRegistry<BackgroundWorkReceipt>;
  getActiveTurn(sessionId: string): { sessionId: string; turn: { id: string } } | null;
  sendTurn(sessionId: string, payload: unknown): Promise<Turn>;
}) {
  const pendingByParent = new Map<string, PendingCompletion[]>();

  async function notifyParentOfSubagentCompletion(input: {
    run: SubagentRun;
    parentSession: Session;
    childSession: Session;
    childTurnId: string;
    body: string;
    refs?: SubagentRef[];
  }): Promise<SubagentMessage> {
    const messageId = `subagent_completion_${input.childTurnId}`;
    const existing = (await deps.listMessages({ fromRunId: input.run.id, limit: 1000 }))
      .find((message) => message.id === messageId);
    if (existing) {
      const run = await persistQueuedNotification(input.run, existing.id);
      const completion = { message: existing, run, childSession: input.childSession };
      if (completionConsumedByParent(run)) await settleNotifications([completion], "joined");
      else queueCompletion(input.parentSession, completion);
      return existing;
    }

    const delivery = SubagentMessageDeliverySchema.parse({
      status: "delivered",
      deliveredRunIds: [],
      acknowledgedRunIds: [],
      deliveredParentSessionId: input.parentSession.id,
      acknowledgedParentSessionId: input.parentSession.id,
      wakeRequestedParentSessionId: input.parentSession.id,
      wakeQueuedParentSessionId: input.parentSession.id,
      wakeParentReason: "child_turn_completed",
    });
    const message = SubagentMessageSchema.parse({
      id: messageId,
      parentGoalId: input.run.parentGoalId,
      fromRunId: input.run.id,
      toRunId: null,
      toRole: "parent",
      kind: "handoff",
      priority: "normal",
      body: truncateForModelAside(input.body || "Child conversation completed.", COMPLETION_BODY_MAX_CHARS),
      refs: input.refs ?? [],
      delivery,
      createdAt: now(),
    });
    await deps.appendMessage(message);
    await deps.appendRuntimeEvent(event({
      sessionId: input.parentSession.id,
      turnId: input.run.parentTurnId ?? undefined,
      name: "subagent.message",
      source: "server",
      appId: input.parentSession.appId,
      status: "completed",
      output: `${input.run.roleId} child completed.`,
      data: {
        message,
        delivery,
        deliveredRunIds: [],
        childSessionId: input.childSession.id,
        roleId: input.run.roleId,
        modelRef: input.run.modelRef,
      },
    }));
    const run = await persistQueuedNotification(input.run, message.id);
    const completion = { message, run, childSession: input.childSession };
    if (completionConsumedByParent(run)) await settleNotifications([completion], "joined");
    else queueCompletion(input.parentSession, completion);
    return message;
  }

  async function recoverPendingCompletions(): Promise<number> {
    const [runs, messages] = await Promise.all([
      deps.listRuns({ limit: 1000 }),
      deps.listMessages({ limit: 1000 }),
    ]);
    const runsById = new Map(runs.map((run) => [run.id, run]));
    const completions = messages.filter((message) =>
      message.id.startsWith("subagent_completion_") && message.delivery?.wakeParentReason === "child_turn_completed"
    );
    let recovered = 0;

    for (const message of completions) {
      const storedRun = runsById.get(message.fromRunId);
      if (!storedRun?.childSessionId) continue;
      const childSessionId = storedRun.childSessionId;
      const run = await persistQueuedNotification(storedRun, message.id);
      const notification = completionNotifications(run).find((item) => item.messageId === message.id);
      if (notification?.settledAt) continue;

      if (await deps.hasParentWakeTurn(run.parentSessionId, message.id)) {
        await settleNotifications([{ message, run, childSession: await deps.getSession(childSessionId) }], "continued");
        continue;
      }

      const [parentSession, childSession] = await Promise.all([
        deps.getSession(run.parentSessionId),
        deps.getSession(childSessionId),
      ]);
      queueCompletion(parentSession, { message, run, childSession });
      recovered += 1;
    }
    return recovered;
  }

  function queueCompletion(parentSession: Session, completion: PendingCompletion): void {
    const pending = pendingByParent.get(parentSession.id) ?? [];
    if (!pending.some((item) => item.message.id === completion.message.id)) pending.push(completion);
    pendingByParent.set(parentSession.id, pending);
    scheduleParentContinuation(parentSession);
  }

  function scheduleParentContinuation(parentSession: Session): void {
    const key = parentSession.id;
    if (deps.parentWakeJobs.has(key)) return;
    const receipt = deps.turnFollowUpQueue.enqueue(
      {
        label: `Continue after child completion: ${parentSession.title}`,
        metadata: { parentSessionId: parentSession.id, kind: "subagent_completion" },
      },
      async () => {
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, COMPLETION_COALESCE_MS));
          while (deps.getActiveTurn(parentSession.id)) {
            await new Promise<void>((resolve) => setTimeout(resolve, PARENT_IDLE_POLL_MS));
          }
          const goal = await deps.currentGoal(parentSession.id).catch(() => null) as { status?: unknown } | null;
          const batch = pendingByParent.get(parentSession.id) ?? [];
          pendingByParent.delete(parentSession.id);
          if (batch.length === 0) return;
          const consumed: PendingCompletion[] = [];
          const unconsumed: PendingCompletion[] = [];
          for (const item of batch) {
            const current = (await deps.getRun(item.run.id)) ?? item.run;
            const refreshed = { ...item, run: current };
            if (completionConsumedByParent(current)) consumed.push(refreshed);
            else unconsumed.push(refreshed);
          }
          if (consumed.length > 0) await settleNotifications(consumed, "joined");
          if (unconsumed.length === 0) return;
          if (goal && goal.status !== "running") {
            await settleNotifications(unconsumed, "goal_not_running");
            return;
          }
          // Settle the durable completion before yielding control to the parent.
          // `sendTurn` resolves only after the parent turn ends, and that turn may
          // queue a follow-up on this same run. A lifecycle write after it returns
          // can race with (and overwrite) the newly queued follow-up.
          await settleNotifications(unconsumed, "continued");
          await deps.sendTurn(parentSession.id, {
            prompt: completionBatchPrompt(unconsumed),
            metadata: {
              subagentCompletionWake: {
                messageIds: unconsumed.map((item) => item.message.id),
                runIds: unconsumed.map((item) => item.run.id),
                requestedAt: now(),
              },
            },
          });
        } catch (error) {
          await deps.appendRuntimeEvent(event({
            sessionId: parentSession.id,
            name: "diagnostic",
            source: "server",
            appId: parentSession.appId,
            status: "failed",
            output: textFromUnknown(error) || "Failed to continue parent after child completion.",
            data: { kind: "subagent_completion_wake_failed" },
          })).catch(() => undefined);
        } finally {
          deps.parentWakeJobs.delete(key);
          if ((pendingByParent.get(parentSession.id)?.length ?? 0) > 0) scheduleParentContinuation(parentSession);
        }
      },
    );
    deps.parentWakeJobs.set(key, receipt);
  }

  async function persistQueuedNotification(run: SubagentRun, messageId: string): Promise<SubagentRun> {
    const current = (await deps.getRun(run.id)) ?? run;
    const notifications = completionNotifications(current);
    if (notifications.some((item) => item.messageId === messageId)) return current;
    return deps.upsertRun({
      ...current,
      metadata: {
        ...(current.metadata ?? {}),
        completionNotifications: [
          ...notifications,
          { messageId, queuedAt: now(), settledAt: null, outcome: null },
        ].slice(-100),
      },
    });
  }

  async function settleNotifications(
    batch: PendingCompletion[],
    outcome: Exclude<CompletionNotification["outcome"], null>,
  ): Promise<void> {
    for (const item of batch) {
      const current = (await deps.getRun(item.run.id)) ?? item.run;
      const notifications = completionNotifications(current);
      const index = notifications.findIndex((notification) => notification.messageId === item.message.id);
      if (index === -1 || notifications[index]?.settledAt) continue;
      notifications[index] = {
        ...notifications[index]!,
        settledAt: now(),
        outcome,
      };
      await deps.upsertRun({
        ...current,
        metadata: { ...(current.metadata ?? {}), completionNotifications: notifications },
      });
    }
  }

  function completionBatchPrompt(batch: PendingCompletion[]): string {
    let remaining = COMPLETION_BATCH_MAX_CHARS;
    const sections: string[] = [];
    for (const item of batch) {
      if (remaining <= 0) break;
      const body = truncateForModelAside(item.message.body, Math.min(COMPLETION_BODY_MAX_CHARS, remaining));
      const section = [
        `Child ${item.run.id} (${item.run.roleId}) completed.`,
        `Child conversation: ${item.childSession.id}`,
        `Final result:\n${body}`,
      ].join("\n");
      sections.push(section);
      remaining -= section.length;
    }
    return [
      "One or more child agents completed. Use their final results and decide the next action.",
      "You may follow up with an existing child, spawn another child (including a reviewer), continue the work yourself, or finish. The runtime does not interpret or accept child work for you.",
      "",
      sections.join("\n\n"),
    ].join("\n");
  }

  function completionConsumedByParent(run: SubagentRun): boolean {
    const value = run.metadata?.completionConsumedByParent;
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  return { notifyParentOfSubagentCompletion, recoverPendingCompletions };
}

function completionNotifications(run: SubagentRun): CompletionNotification[] {
  const value = run.metadata?.completionNotifications;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.messageId !== "string" || typeof record.queuedAt !== "string") return [];
    const outcome = record.outcome === "continued" || record.outcome === "goal_not_running" || record.outcome === "joined"
      ? record.outcome
      : null;
    return [{
      messageId: record.messageId,
      queuedAt: record.queuedAt,
      settledAt: typeof record.settledAt === "string" ? record.settledAt : null,
      outcome,
    }];
  });
}
