import { randomUUID } from "node:crypto";
import {
  SubagentMessageDeliverySchema,
  SubagentMessageSchema,
  SubagentRunSchema,
  type RuntimeEvent,
  type Session,
  type SubagentMessage,
  type SubagentMessageDelivery,
  type SubagentMessagePriority,
  type SubagentRun,
  type Turn,
} from "@openpond/contracts";
import type {
  OpenPondSubagentMessageToolInput,
  OpenPondSubagentMessageToolResult,
} from "../../openpond/capability-tool-registry.js";
import type { ModelToolExecutionContext } from "../../openpond/model-tool-registry.js";
import { event, now, textFromUnknown } from "../../utils.js";
import { recordFromUnknown, stringFromRecord } from "../turns/value-utils.js";

type AppendSubagentReceipt = (input: {
  parentSession: Session;
  parentTurnId?: string | null;
  run: SubagentRun;
  childSession?: Session | null;
  eventName: Extract<RuntimeEvent["name"], `subagent.${string}`>;
  status: RuntimeEvent["status"];
  output: string;
}) => Promise<void>;

type ActiveTurnInfo = {
  sessionId: string;
  turn: { id: string };
};

export function subagentActiveTurnIsDurablyTerminal(
  active: ActiveTurnInfo | null,
  durableTurn: Turn | null,
): boolean {
  return Boolean(
    active &&
    durableTurn?.id === active.turn.id &&
    durableTurn.status !== "in_progress",
  );
}

export function createSubagentMessagingRuntime(deps: {
  requireSubagentDeps(): {
    getRun(runId: string): Promise<SubagentRun | null>;
    upsertRun(run: SubagentRun): Promise<unknown>;
    listRuns(input: {
      parentSessionId?: string;
      parentGoalId?: string;
      status?: SubagentRun["status"][];
      limit?: number;
    }): Promise<SubagentRun[]>;
    appendMessage(message: SubagentMessage): Promise<unknown>;
  };
  currentGoal(sessionId: string): Promise<unknown>;
  getSession(sessionId: string): Promise<Session>;
  latestTurnForSession(sessionId: string): Promise<Turn | null>;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  appendSubagentReceipt: AppendSubagentReceipt;
  getActiveTurn(sessionId: string): ActiveTurnInfo | null;
  interruptActiveTurn(active: ActiveTurnInfo, reason: string): Promise<Turn>;
}) {
  const requireSubagentDeps = deps.requireSubagentDeps;
  const getSession = deps.getSession;
  const latestTurnForSession = deps.latestTurnForSession;
  const appendRuntimeEvent = deps.appendRuntimeEvent;
  const appendSubagentReceipt = deps.appendSubagentReceipt;
  const interruptActiveTurn = deps.interruptActiveTurn;
  const activeTurns = {
    has: (sessionId: string) => Boolean(deps.getActiveTurn(sessionId)),
    get: (sessionId: string) => deps.getActiveTurn(sessionId),
  };
  const store = {
    currentOpenPondThreadGoal: async (sessionId: string) => recordFromUnknown(await deps.currentGoal(sessionId)),
  };
  async function sendSubagentMessageFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentMessageToolInput,
  ): Promise<OpenPondSubagentMessageToolResult> {
    const deps = requireSubagentDeps();
    const parentGoalId = stringFromRecord(
      (await store.currentOpenPondThreadGoal(context.session.parentSessionId ?? context.session.id)) ?? {},
      "id",
    );
    const fromRunId = context.session.subagentRunId ?? `parent:${context.session.id}`;
    const priority = input.priority ?? "normal";
    const deliveredParentSessionId = subagentMessageParentDeliveryTarget(context.session, input);
    const recipientRuns = await resolveSubagentMessageRecipients(context, {
      parentGoalId,
      toRunId: input.toRunId ?? null,
      toRole: input.toRole ?? null,
    });
    const deliveredRunIds = recipientRuns.map((run) => run.id);
    const delivered = deliveredRunIds.length > 0 || Boolean(deliveredParentSessionId);
    let delivery: SubagentMessageDelivery = {
      status: delivered ? "delivered" : "undelivered",
      deliveredRunIds,
      acknowledgedRunIds: deliveredRunIds,
      deliveredParentSessionId,
      acknowledgedParentSessionId: deliveredParentSessionId,
      wakeRequestedParentSessionId: null,
      wakeQueuedParentSessionId: null,
      wakeDeferredParentSessionId: null,
      wakeParentReason: null,
      wakeRequestedRunIds: [],
      wakeInterruptedRunIds: [],
      wakeDeferredRunIds: [],
      reason: delivered
        ? null
        : input.toRunId || input.toRole
          ? "No matching active child run was available for delivery."
          : "No target run or role was supplied.",
    };
    let message = SubagentMessageSchema.parse({
      id: randomUUID(),
      parentGoalId,
      fromRunId,
      toRunId: input.toRunId ?? null,
      toRole: input.toRole ?? null,
      kind: input.kind,
      priority,
      body: input.body,
      refs: [],
      delivery,
      createdAt: now(),
    });
    await deliverSubagentMessageToReceivers(context, message, recipientRuns);
    const wake = priority === "interrupt"
      ? await wakeInterruptPrioritySubagentRuns(context, message, recipientRuns)
      : null;
    if (wake) {
      delivery = SubagentMessageSchema.parse({
        ...message,
        delivery: {
          ...delivery,
          wakeRequestedRunIds: wake.requestedRunIds,
          wakeInterruptedRunIds: wake.interruptedRunIds,
          wakeDeferredRunIds: wake.deferredRunIds,
        },
      }).delivery!;
      message = { ...message, delivery };
    }
    message = SubagentMessageSchema.parse({ ...message, delivery });
    await deps.appendMessage(message);
    await appendRuntimeEvent(
      event({
        sessionId: context.session.id,
        turnId: context.turnId,
        name: "subagent.message",
        source: "provider",
        appId: context.session.appId,
        status: delivery.status === "delivered" ? "completed" : "pending",
        output: priority === "interrupt"
          ? `Interrupt subagent message sent: ${message.kind}.`
          : `Subagent message sent: ${message.kind}.`,
        data: { message, delivery, deliveredRunIds, modelRef: context.session.modelRef },
      }),
    );
    if (context.session.parentSessionId && context.session.parentSessionId !== context.session.id) {
      await appendRuntimeEvent(
        event({
          sessionId: context.session.parentSessionId,
          turnId: context.turnId,
          name: "subagent.message",
          source: "server",
          appId: context.session.appId,
          status: "completed",
          output: `Subagent ${fromRunId} sent ${message.kind}.`,
          data: {
            message,
            delivery,
            deliveredRunIds,
            childSessionId: context.session.id,
            roleId: context.session.subagentRoleId ?? null,
            modelRef: context.session.modelRef,
          },
        }),
      );
    }
    return {
      messageId: message.id,
      delivery,
      nextStep: subagentMessageDeliveryNextStep({ priority, deliveredRunIds, delivery }),
    };
  }

  async function queueSubagentFollowupMessage(input: {
    context: ModelToolExecutionContext;
    run: SubagentRun;
    body: string;
  }): Promise<void> {
    const runtime = requireSubagentDeps();
    const delivery = SubagentMessageDeliverySchema.parse({
      status: input.run.childSessionId ? "delivered" : "undelivered",
      deliveredRunIds: input.run.childSessionId ? [input.run.id] : [],
      acknowledgedRunIds: input.run.childSessionId ? [input.run.id] : [],
      reason: input.run.childSessionId ? null : "The child run has no child conversation.",
    });
    const message = SubagentMessageSchema.parse({
      id: randomUUID(),
      parentGoalId: input.run.parentGoalId,
      fromRunId: input.context.session.subagentRunId ?? `parent:${input.context.session.id}`,
      toRunId: input.run.id,
      toRole: input.run.roleId,
      kind: "status",
      priority: "normal",
      body: input.body,
      refs: [],
      delivery,
      createdAt: now(),
    });
    if (input.run.childSessionId) {
      await deliverSubagentMessageToReceivers(input.context, message, [input.run]);
    }
    await runtime.appendMessage(message);
    await appendRuntimeEvent(event({
      sessionId: input.context.session.id,
      turnId: input.context.turnId,
      name: "subagent.message",
      source: "provider",
      appId: input.context.session.appId,
      status: delivery.status === "delivered" ? "completed" : "failed",
      output: "Follow-up task sent to child conversation.",
      data: { message, delivery, deliveredRunIds: delivery.deliveredRunIds, modelRef: input.run.modelRef },
    }));
  }

  function subagentMessageParentDeliveryTarget(
    session: Session,
    input: OpenPondSubagentMessageToolInput,
  ): string | null {
    if (!session.parentSessionId || session.parentSessionId === session.id) return null;
    const toRunId = input.toRunId?.trim() || null;
    const toRole = input.toRole?.trim().toLowerCase() || null;
    if (!toRunId && !toRole) return session.parentSessionId;
    if (toRunId === session.parentSessionId) return session.parentSessionId;
    if (toRole === "parent") return session.parentSessionId;
    return null;
  }

  async function resolveSubagentMessageRecipients(
    context: ModelToolExecutionContext,
    input: {
      parentGoalId: string | null;
      toRunId: string | null;
      toRole: string | null;
    },
  ): Promise<SubagentRun[]> {
    const deps = requireSubagentDeps();
    const parentSessionId = context.session.parentSessionId ?? context.session.id;
    const recipients = input.toRunId
      ? [(await deps.getRun(input.toRunId))].filter((run): run is SubagentRun => Boolean(run))
      : input.toRole
        ? await deps.listRuns({
            parentSessionId,
            parentGoalId: input.parentGoalId ?? undefined,
            status: ["queued", "running", "needs_resume"],
            limit: 50,
          })
        : [];
    return recipients.filter((run) => {
      if (run.parentSessionId !== parentSessionId) return false;
      if (input.toRole && run.roleId !== input.toRole) return false;
      if (!run.childSessionId) return false;
      return true;
    });
  }

  async function deliverSubagentMessageToReceivers(
    context: ModelToolExecutionContext,
    message: SubagentMessage,
    recipients: SubagentRun[],
  ): Promise<void> {
    for (const run of recipients) {
      const childSessionId = run.childSessionId;
      if (!childSessionId) continue;
      await appendRuntimeEvent(
        event({
          sessionId: childSessionId,
          name: "subagent.message",
          source: "server",
          appId: context.session.appId,
          status: "pending",
          output: message.priority === "interrupt"
            ? `Interrupt subagent message received: ${message.kind}.`
            : `Subagent message received: ${message.kind}.`,
          data: {
            message,
            delivery: message.delivery ?? null,
            deliveredToRunId: run.id,
            acknowledgedRunId: run.id,
            priority: message.priority ?? "normal",
            modelRef: run.modelRef,
          },
        }),
      );
    }
  }

  async function wakeInterruptPrioritySubagentRuns(
    context: ModelToolExecutionContext,
    message: SubagentMessage,
    recipients: SubagentRun[],
  ): Promise<{ requestedRunIds: string[]; interruptedRunIds: string[]; deferredRunIds: string[] }> {
    const deps = requireSubagentDeps();
    const requestedRunIds: string[] = [];
    const interruptedRunIds: string[] = [];
    const deferredRunIds: string[] = [];
    for (const recipient of recipients) {
      if (!recipient.childSessionId) continue;
      requestedRunIds.push(recipient.id);
      let active = activeTurns.get(recipient.childSessionId);
      if (active) {
        const durableTurn = await latestTurnForSession(recipient.childSessionId).catch(() => null);
        if (subagentActiveTurnIsDurablyTerminal(active, durableTurn)) {
          // A managed child can persist its terminal turn before provider
          // dispatch cleanup removes the in-memory active-turn entry. Do not
          // interrupt that stale entry: doing so races the child's automatic
          // handoff promotion and can strand a completed run as `running`.
          active = null;
        }
      }
      const activeTurnId = active?.turn.id ?? null;
      const requestedAt = now();
      let wakeStatus = active ? "interrupting" : "deferred";
      let interruptError: string | null = null;
      const latestRun = (await deps.getRun(recipient.id).catch(() => null)) ?? recipient;
      let updated = SubagentRunSchema.parse({
        ...latestRun,
        metadata: withSubagentInterruptWakeMetadata(latestRun.metadata, {
          messageId: message.id,
          kind: message.kind,
          fromRunId: message.fromRunId,
          priority: message.priority ?? "normal",
          requestedAt,
          activeTurnId,
          status: wakeStatus,
        }),
      });
      await deps.upsertRun(updated);
      if (active) {
        try {
          await interruptActiveTurn(active, `Interrupted for subagent message ${message.id}`);
          wakeStatus = "interrupted";
          interruptedRunIds.push(recipient.id);
        } catch (error) {
          wakeStatus = "deferred";
          interruptError = textFromUnknown(error) || "Failed to interrupt active child turn.";
          deferredRunIds.push(recipient.id);
        }
      } else {
        deferredRunIds.push(recipient.id);
      }
      updated = SubagentRunSchema.parse({
        ...updated,
        metadata: withSubagentInterruptWakeMetadata(updated.metadata, {
          messageId: message.id,
          kind: message.kind,
          fromRunId: message.fromRunId,
          priority: message.priority ?? "normal",
          requestedAt,
          activeTurnId,
          status: wakeStatus,
          ...(interruptError ? { error: interruptError } : {}),
        }),
      });
      await deps.upsertRun(updated);
      const parentSession = await getSession(updated.parentSessionId).catch(() => context.session);
      await appendSubagentReceipt({
        parentSession,
        parentTurnId: updated.parentTurnId ?? context.turnId,
        run: updated,
        eventName: "subagent.progress",
        status: "pending",
        output: active
          ? `${updated.roleId} subagent received interrupt steering and is waking at a fresh model boundary.`
          : `${updated.roleId} subagent received interrupt steering and will read it at the next model boundary.`,
      });
    }
    return { requestedRunIds, interruptedRunIds, deferredRunIds };
  }

  function subagentMessageDeliveryNextStep(input: {
    priority: SubagentMessagePriority;
    deliveredRunIds: string[];
    delivery: SubagentMessageDelivery;
  }): string {
    const deliveredToParent = Boolean(input.delivery.deliveredParentSessionId);
    if (input.deliveredRunIds.length === 0 && !deliveredToParent) {
      return "Message persisted in the goal-scoped subagent mailbox.";
    }
    const prefix = input.priority === "interrupt" ? "Interrupt message" : "Message";
    const childDelivery = input.deliveredRunIds.length > 0
      ? `${input.deliveredRunIds.length} subagent run${input.deliveredRunIds.length === 1 ? "" : "s"}`
      : null;
    const base = childDelivery && deliveredToParent
      ? `${prefix} persisted, delivered and acknowledged by ${childDelivery} and delivered to the parent chat at the runtime boundary.`
      : childDelivery
        ? `${prefix} persisted, delivered, and acknowledged by ${childDelivery} at the runtime boundary.`
        : `${prefix} persisted, delivered to the parent chat at the runtime boundary.`;
    const parentWake = input.delivery.wakeQueuedParentSessionId
      ? " Main agent wake queued for this parent handoff."
      : input.delivery.wakeDeferredParentSessionId
        ? ` Main agent wake deferred (${input.delivery.wakeParentReason ?? "deferred"}).`
        : "";
    if (input.priority !== "interrupt") return `${base}${parentWake}`;
    const interrupted = input.delivery.wakeInterruptedRunIds?.length ?? 0;
    const deferred = input.delivery.wakeDeferredRunIds?.length ?? 0;
    if (interrupted > 0) {
      return `${base}${parentWake} Woke ${interrupted} active child turn${interrupted === 1 ? "" : "s"} for a fresh model boundary.`;
    }
    if (deferred > 0) {
      return `${base}${parentWake} No active child turn needed interruption; delivery is queued for the next child model boundary.`;
    }
    return `${base}${parentWake}`;
  }

  function withSubagentInterruptWakeMetadata(
    metadata: Record<string, unknown> | undefined,
    wake: Record<string, unknown>,
  ): Record<string, unknown> {
    const current = recordFromUnknown(metadata) ?? {};
    const history = Array.isArray(current.interruptWakeHistory)
      ? current.interruptWakeHistory.filter((item) => recordFromUnknown(item)).slice(-19)
      : [];
    const nextWake = {
      ...(recordFromUnknown(current.interruptWake) ?? {}),
      ...wake,
    };
    return {
      ...current,
      interruptWake: nextWake,
      interruptWakeHistory: [...history, nextWake],
    };
  }


  return {
    deliverSubagentMessageToReceivers,
    queueSubagentFollowupMessage,
    sendSubagentMessageFromModelTool,
    wakeInterruptPrioritySubagentRuns,
    withSubagentInterruptWakeMetadata,
  };
}
