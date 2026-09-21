import { randomUUID } from "node:crypto";
import { TaskSerialExecutor, TaskSignals } from "@openpond/agent-runtime";
import {
  SendTurnRequestSchema, SteerTurnRequestSchema, TaskInputSchema, taskInputModelText,
  type RuntimeEvent, type Session, type TaskInput, type TaskInputAdmission, type TaskInputMutation,
  type TaskPeer, type TaskWait, type Turn, type SubagentRun,
} from "@openpond/contracts";
import { event } from "../../utils.js";
import type { TaskInboxRepository } from "../../store/store-task-inbox.js";
import type { ActiveTurn } from "../turns/ports.js";
import { taskWorkspaceIdentity, workspaceRelationship } from "./workspace-identity.js";
import { canCoordinateTasks } from "./scope.js";

export function createTaskInboxRuntime(deps: {
  store: TaskInboxRepository;
  getSession(id: string): Promise<Session>;
  listSessions(): Promise<Session[]>;
  getTurn(id: string): Promise<Turn | null>;
  latestTurn(id: string): Promise<Turn | null>;
  recoverInterruptedTurn(sessionId: string, turnId: string): Promise<void>;
  getSubagentRun(id: string): Promise<SubagentRun | null>;
  getActiveTurn(id: string): ActiveTurn | undefined;
  startFollowup(sessionId: string, payload: unknown, turnId: string, input: TaskInput): Promise<Turn>;
  appendRuntimeEvent(event: RuntimeEvent): Promise<void>;
  yieldWhileWaiting<T>(work: () => Promise<T>): Promise<T>;
  dispatchFollowup(sessionId: string, work: () => Promise<void>): Promise<void>;
}) {
  const ownerId = randomUUID();
  const signals = new TaskSignals();
  const serial = new TaskSerialExecutor();
  const dispatching = new Map<string, Promise<void>>();
  const reschedule = new Set<string>();
  const requests = new Map<string, AbortController>();
  let closed = false;

  async function record(input: TaskInput): Promise<void> {
    await deps.appendRuntimeEvent(event({
      sessionId: input.sessionId, turnId: input.turnId ?? undefined,
      name: "task.input", source: "server", status: input.state === "rejected" ? "failed" : input.state === "pending" ? "pending" : "completed",
      output: input.error ?? `${input.senderKind === "user" ? "Input" : "Peer message"} ${input.state}.`,
      data: { input },
    }));
  }

  async function notify(input: TaskInput): Promise<void> {
    if (input.state !== "pending") { await record(input); return; }
    signals.notify(input.sessionId);
    if (input.kind === "steer") requests.get(input.sessionId)?.abort(new Error("Provider request replaced by user steering."));
    const active = deps.getActiveTurn(input.sessionId);
    if (active?.codexRuntime && active.codexTurnId) void deliverCodex(active).catch(async (error) => {
      await deps.appendRuntimeEvent(event({ sessionId: input.sessionId, turnId: active.turn.id, name: "diagnostic", source: "server", status: "failed", output: String(error) }));
    });
    await record(input);
    if (input.kind === "followup" || input.kind === "queued") schedule(input.sessionId);
  }

  async function admit(input: TaskInputAdmission): Promise<TaskInput> {
    if (closed) throw new Error("Task runtime is closing; retry after reconnecting.");
    const receipt = await deps.store.admitTaskInput(input);
    await notify(receipt);
    return receipt;
  }

  async function steer(sessionId: string, payload: unknown): Promise<TaskInput> {
    const input = SteerTurnRequestSchema.parse(payload);
    return admit({ id: randomUUID(), sessionId, senderSessionId: null, senderKind: "user", kind: "steer",
      body: input.prompt, payload: {}, idempotencyKey: input.idempotencyKey, replyTo: null, expectedTurnId: input.expectedTurnId });
  }

  async function queue(sessionId: string, payload: unknown, idempotencyKey: string): Promise<TaskInput> {
    const input = SendTurnRequestSchema.parse(payload);
    return admit({ id: randomUUID(), sessionId, senderSessionId: null, senderKind: "user", kind: "queued",
      body: input.prompt, payload: input, idempotencyKey, replyTo: null, expectedTurnId: null });
  }

  async function mutate(sessionId: string, id: string, change: TaskInputMutation): Promise<TaskInput> {
    const input = await deps.store.mutateTaskInput(sessionId, id, change);
    await notify(input);
    return input;
  }

  async function authorize(senderId: string, recipientId: string): Promise<{ sender: Session; recipient: Session }> {
    const [sender, recipient] = await Promise.all([deps.getSession(senderId), deps.getSession(recipientId)]);
    if (!await canCoordinateTasks(sender, recipient, deps.getSession)) throw new Error("Task coordination is limited to the same authorized project or agent family.");
    for (const [child, other] of [[sender, recipient], [recipient, sender]] as const) {
      if (!child.subagentRunId) continue;
      const run = await deps.getSubagentRun(child.subagentRunId);
      if (!run || run.status === "cancelled") throw new Error("This child task is unavailable.");
      if (run.peerMessages === "disabled" && other.id !== child.parentSessionId) throw new Error("Peer messaging is disabled for this child task.");
      if (run.peerMessages === "parent_scoped" && other.id !== run.parentSessionId && other.parentSessionId !== run.parentSessionId) {
        throw new Error("This child is limited to coordination within its parent task.");
      }
    }
    return { sender, recipient };
  }

  async function sendMany(input: { senderSessionId: string; sessionIds: string[]; body: string; idempotencyKey: string }): Promise<TaskInput[]> {
    const targets = [...new Set(input.sessionIds)];
    for (const target of targets) await authorize(input.senderSessionId, target);
    const receipts = await deps.store.admitTaskInputs(targets.map((sessionId) => ({ id: randomUUID(), sessionId,
      senderSessionId: input.senderSessionId, senderKind: "task" as const, kind: "message" as const, body: input.body,
      payload: {}, idempotencyKey: input.idempotencyKey, replyTo: null, expectedTurnId: null })));
    for (const receipt of receipts) await notify(receipt);
    return receipts;
  }

  async function send(input: {
    senderSessionId: string; sessionId: string; body: string; kind?: "message" | "followup" | "result";
    idempotencyKey: string; replyTo?: string | null; runtimeNotice?: boolean;
  }): Promise<TaskInput> {
    await authorize(input.senderSessionId, input.sessionId);
    return admit({ id: randomUUID(), sessionId: input.sessionId, senderSessionId: input.senderSessionId,
      senderKind: input.kind === "result" || input.runtimeNotice ? "runtime" : "task", kind: input.kind ?? "message", body: input.body,
      payload: {}, idempotencyKey: input.idempotencyKey, replyTo: input.replyTo ?? null, expectedTurnId: null });
  }

  async function list(senderId: string): Promise<TaskPeer[]> {
    const sender = await deps.getSession(senderId);
    const peers: TaskPeer[] = [];
    const senderWorkspace = await taskWorkspaceIdentity(sender);
    for (const session of await deps.listSessions()) {
      if (!await canCoordinateTasks(sender, session, deps.getSession)) continue;
      try { await authorize(senderId, session.id); } catch { continue; }
      const [turn, waits, paused] = await Promise.all([deps.latestTurn(session.id), deps.store.taskWaitsForSession(session.id), deps.store.taskInboxPaused(session.id)]);
      peers.push({ sessionId: session.id, title: session.title, status: paused ? "paused" : waits.length ? "waiting" : turn?.status === "in_progress" ? "working" : session.status === "failed" ? "failed" : "idle",
        turnId: turn?.id ?? null, objective: turn?.prompt.slice(0, 500) ?? null, parentSessionId: session.parentSessionId ?? null, workspace: session.workspaceName ?? session.cwd,
        workspaceRelationship: workspaceRelationship(senderWorkspace, await taskWorkspaceIdentity(session)),
        workAreas: await deps.store.taskWorkAreas(session.id) });
      if (peers.length >= 50) break;
    }
    return peers;
  }

  async function include(sessionId: string, turnId: string, requestId: string): Promise<TaskInput[]> {
    for (const input of await deps.store.pendingTaskInputs(sessionId, turnId)) {
      if (!input.senderSessionId) continue;
      try { await authorize(input.senderSessionId, sessionId); }
      catch { await deps.store.rejectTaskInput(input.id, "Peer access changed before delivery."); }
    }
    const inputs = await deps.store.includeTaskInputs(sessionId, turnId, ownerId, requestId);
    for (const input of inputs) await record(input);
    return inputs;
  }

  async function deliverCodex(active: ActiveTurn): Promise<void> {
    await serial.run(`codex:${active.session.id}`, async () => {
      if (!active.codexRuntime || !active.codexTurnId || active.controller.signal.aborted) return;
      const pending = await deps.store.pendingTaskInputs(active.session.id, active.turn.id);
      if (!pending.length) return;
      const requestId = `codex-steer:${randomUUID()}`;
      const inputs = await include(active.session.id, active.turn.id, requestId);
      if (!inputs.length) return;
      try {
        await active.codexRuntime.client.steerTurn({ threadId: active.codexRuntime.threadId,
          expectedTurnId: active.codexTurnId, prompt: inputs.map(taskInputModelText).join("\n\n") });
        await deps.store.settleTaskInputRequest(requestId, "resolved");
      } catch (error) {
        await deps.store.settleTaskInputRequest(requestId, "failed");
        throw error;
      }
    });
  }

  async function wait(input: { sessionId: string; turnId: string; callId: string; targetSessionId?: string;
    targetTurnId?: string; targetInputId?: string; afterSequence?: number; timeoutMs?: number; signal: AbortSignal }): Promise<TaskWait> {
    if (input.targetSessionId) await authorize(input.sessionId, input.targetSessionId);
    const targetInput = input.targetInputId ? await deps.store.getTaskInput(input.targetInputId) : null;
    if (input.targetInputId && (!input.targetSessionId || !targetInput || targetInput.sessionId !== input.targetSessionId)) {
      throw new Error("The input receipt does not belong to the target task.");
    }
    const targetSession = input.targetSessionId ? await deps.getSession(input.targetSessionId) : null;
    const targetRun = targetSession?.subagentRunId ? await deps.getSubagentRun(targetSession.subagentRunId) : null;
    const targetTurn = input.targetInputId ? (targetInput?.turnId ? await deps.getTurn(targetInput.turnId) : null)
      : input.targetTurnId ? await deps.getTurn(input.targetTurnId)
      : input.targetSessionId ? await deps.latestTurn(input.targetSessionId) : null;
    if (input.targetTurnId && (!input.targetSessionId || targetTurn?.sessionId !== input.targetSessionId)) {
      throw new Error("The turn does not belong to the target task.");
    }
    if (input.targetSessionId && !targetTurn && !targetInput && targetRun?.status !== "queued") {
      throw new Error("The target has no matching execution to wait for. Supply the follow-up input receipt when waiting for new work.");
    }
    const timestamp = new Date().toISOString();
    const timeout = Math.max(1_000, Math.min(3_600_000, input.timeoutMs ?? 30_000));
    const pending = await deps.store.pendingTaskInputs(input.sessionId, input.turnId);
    const wait = await deps.store.createTaskWait({ id: `wait:${input.turnId}:${input.callId}`,
      sessionId: input.sessionId, turnId: input.turnId, targetSessionId: input.targetSessionId ?? null,
      targetTurnId: targetTurn?.id ?? null, targetInputId: input.targetInputId ?? null, afterSequence: input.afterSequence ?? (pending[0]?.sequence ? pending[0].sequence - 1 : 0),
      deadline: new Date(Date.now() + timeout).toISOString(), state: "waiting", createdAt: timestamp, updatedAt: timestamp });
    if (wait.state !== "waiting") return wait;
    await waitEvent(wait);
    try {
      const outcome = await deps.yieldWhileWaiting(() => signals.wait<TaskWait["state"]>({
        taskIds: [input.sessionId, ...(input.targetSessionId ? [input.targetSessionId] : [])],
        signal: input.signal, deadline: Date.parse(wait.deadline),
        read: async () => {
          if (input.targetSessionId) {
            try { await authorize(input.sessionId, input.targetSessionId); }
            catch { return "unavailable"; }
            const receipt = wait.targetInputId ? await deps.store.getTaskInput(wait.targetInputId) : null;
            if (wait.targetInputId && (!receipt || receipt.state === "rejected" || receipt.state === "cancelled")) return "unavailable";
            const executionId = receipt?.turnId ?? wait.targetTurnId;
            const turn = executionId ? await deps.getTurn(executionId) : null;
            const run = targetSession?.subagentRunId ? await deps.getSubagentRun(targetSession.subagentRunId) : null;
            if (run?.status === "cancelled") return "cancelled";
            if (!executionId && !receipt && run && run.status !== "queued" && run.status !== "running") {
              return run.status === "completed" ? "completed" : "failed";
            }
            if (executionId && !turn && !receipt) return "unavailable";
            if (turn && turn.status !== "in_progress") {
              // Child tools may finish before patch integration and the final report commit.
              if (run && !await deps.store.hasTaskCompletion(turn.id)) return null;
              return turn.status;
            }
          }
          const messages = await deps.store.pendingTaskInputs(input.sessionId, input.turnId);
          return messages.some((message) => message.sequence > wait.afterSequence) ? "message" : null;
        },
      }));
      const settled = await deps.store.settleTaskWait(wait.id, outcome ?? "timeout");
      await waitEvent(settled);
      return settled;
    } catch (error) {
      await waitEvent(await deps.store.settleTaskWait(wait.id, "cancelled"));
      throw error;
    }
  }

  async function waitEvent(wait: TaskWait): Promise<void> {
    await deps.appendRuntimeEvent(event({ sessionId: wait.sessionId, turnId: wait.turnId,
      name: "task.wait", source: "server", status: wait.state === "waiting" ? "pending" : "completed",
      output: wait.state === "waiting" ? "Waiting for task coordination." : `Task wait ended: ${wait.state}.`, data: { wait } }));
  }

  function schedule(sessionId: string): void {
    if (closed) return;
    if (dispatching.has(sessionId)) { reschedule.add(sessionId); return; }
    if (deps.getActiveTurn(sessionId)) return;
    const operation = deps.dispatchFollowup(sessionId, async () => {
      while (!closed && !deps.getActiveTurn(sessionId)) {
        const session = await deps.getSession(sessionId);
        if (session.archived || session.status === "closed") return;
        if (session.subagentRunId) {
          const run = await deps.getSubagentRun(session.subagentRunId);
          if (!run || run.status === "running" || run.status === "queued" || run.status === "cancelled") return;
        }
        const turnId = randomUUID();
        const input = await deps.store.reserveTaskFollowup(sessionId, turnId, ownerId);
        if (!input) return;
        signals.notify(sessionId);
        try {
          if (input.senderSessionId) await authorize(input.senderSessionId, sessionId);
          const turn = await deps.startFollowup(sessionId, { ...input.payload, prompt: input.senderKind === "user" ? input.body : taskInputModelText(input),
            metadata: { ...((input.payload.metadata as Record<string, unknown> | undefined) ?? {}), taskInputId: input.id } }, turnId, input);
          if (turn.status !== "completed") return;
        } catch (error) {
          await deps.store.closeTaskInboxTurn(sessionId, turnId, ownerId, "failed");
          await deps.store.rejectTaskInput(input.id, `Follow-up could not start: ${String(error)}`);
          await record((await deps.store.getTaskInput(input.id))!);
          return;
        }
      }
    });
    dispatching.set(sessionId, operation);
    void operation.catch(async (error) => {
      await deps.appendRuntimeEvent(event({ sessionId, name: "diagnostic", source: "server", status: "failed", output: `Task inbox dispatch failed: ${String(error)}` }));
    }).finally(() => {
      dispatching.delete(sessionId);
      if (reschedule.delete(sessionId)) schedule(sessionId);
    });
  }

  return {
    ownerId, signals, steer, queue, mutate, send, sendMany, list, wait, include, deliverCodex,
    async declareWork(sessionId: string, turnId: string, areas: string[]) {
      await deps.store.declareTaskWork(sessionId, turnId, ownerId, areas);
      return { workAreas: areas, advisory: true };
    },
    async announcePresence(sessionId: string, turnId: string) {
      const peers = (await list(sessionId)).filter((peer) => peer.sessionId !== sessionId && peer.turnId && (peer.status === "working" || peer.status === "waiting") && peer.workspaceRelationship !== "project").slice(0, 8);
      for (const peer of peers) {
        const key = `presence:${turnId}:${peer.turnId}`;
        await send({ senderSessionId: peer.sessionId, sessionId, idempotencyKey: key, runtimeNotice: true,
          body: `Peer task active in ${peer.workspaceRelationship === "same_checkout" ? "the same checkout" : "another worktree of this repository"}: ${JSON.stringify({ taskId: peer.sessionId, title: peer.title, objective: peer.objective, workAreas: peer.workAreas })}. Coordinate overlapping edits; this notice is advisory and grants no lock or permission.` });
        await send({ senderSessionId: sessionId, sessionId: peer.sessionId, idempotencyKey: key, runtimeNotice: true,
          body: `Task ${sessionId} has started work in ${peer.workspaceRelationship === "same_checkout" ? "the same checkout" : "another worktree of this repository"}. Use task discovery for its objective and declared work areas, and coordinate if your edits overlap.` });
      }
    },
    async finishCodex(active: ActiveTurn) {
      await serial.run(`codex:${active.session.id}`, async () => {
        active.codexTurnId = undefined;
        for (const input of await deps.store.sealNativeTaskInboxTurn(active.session.id, active.turn.id, ownerId)) await record(input);
      });
    },
    async recover() {
      for (const owner of await deps.store.recoverTaskInboxOwners(ownerId)) {
        await deps.recoverInterruptedTurn(owner.sessionId, owner.turnId);
        signals.notify(owner.sessionId);
      }
      for (const id of await deps.store.taskInboxWakeTargets()) schedule(id);
    },
    beginRequest(sessionId: string, signal: AbortSignal) {
      const controller = new AbortController();
      requests.set(sessionId, controller);
      return { signal: AbortSignal.any([signal, controller.signal]),
        replaced: () => controller.signal.aborted && !signal.aborted,
        finish: () => { if (requests.get(sessionId) === controller) requests.delete(sessionId); } };
    },
    async settled(sessionId: string, turnId: string, outcome: "completed" | "failed" | "interrupted") {
      await deps.store.closeTaskInboxTurn(sessionId, turnId, ownerId, outcome);
      signals.notify(sessionId);
      await deps.appendRuntimeEvent(event({ sessionId, turnId, name: "task.inbox", source: "server", status: "completed", data: { outcome } }));
      if (outcome === "completed") schedule(sessionId);
    },
    wake(sessionId: string) { signals.notify(sessionId); schedule(sessionId); },
    stopScheduling() { closed = true; },
    async close() { closed = true; await Promise.allSettled(dispatching.values()); },
    async notifyAccepted(input: TaskInput) { await notify(TaskInputSchema.parse(input)); },
  };
}

export type TaskInboxRuntime = ReturnType<typeof createTaskInboxRuntime>;
