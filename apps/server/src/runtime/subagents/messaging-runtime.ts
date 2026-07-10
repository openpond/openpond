import { randomUUID } from "node:crypto";
import {
  SubagentMessageDeliverySchema,
  SubagentMessageSchema,
  SubagentRunSchema,
  type ModelUsageRecord,
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
import type { BackgroundWorkerQueue, BackgroundWorkReceipt } from "../background-worker-queue.js";
import type { KeyedRegistry } from "../turns/keyed-registry.js";
import { recordFromUnknown, stringFromRecord } from "../turns/value-utils.js";

const SUBAGENT_PARENT_WAKE_MAX_CHAIN = 4;

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
  hasParentWakeTurn(parentSessionId: string, messageId: string): Promise<boolean>;
  countParentWakeTurns(parentSessionId: string, fromRunId: string): Promise<number>;
  getSession(sessionId: string): Promise<Session>;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  appendSubagentReceipt: AppendSubagentReceipt;
  turnFollowUpQueue: BackgroundWorkerQueue;
  parentWakeJobs: KeyedRegistry<BackgroundWorkReceipt>;
  getActiveTurn(sessionId: string): ActiveTurnInfo | null;
  interruptActiveTurn(active: ActiveTurnInfo, reason: string): Promise<Turn>;
  sendTurn(sessionId: string, payload: unknown): Promise<Turn>;
}) {
  const requireSubagentDeps = deps.requireSubagentDeps;
  const getSession = deps.getSession;
  const appendRuntimeEvent = deps.appendRuntimeEvent;
  const appendSubagentReceipt = deps.appendSubagentReceipt;
  const turnFollowUpQueue = deps.turnFollowUpQueue;
  const subagentParentWakeJobs = deps.parentWakeJobs;
  const sendTurn = deps.sendTurn;
  const interruptActiveTurn = deps.interruptActiveTurn;
  const activeTurns = {
    has: (sessionId: string) => Boolean(deps.getActiveTurn(sessionId)),
    get: (sessionId: string) => deps.getActiveTurn(sessionId),
  };
  const store = {
    currentOpenPondThreadGoal: async (sessionId: string) => recordFromUnknown(await deps.currentGoal(sessionId)),
    hasSubagentParentWakeTurn: deps.hasParentWakeTurn,
    countSubagentParentWakeTurns: deps.countParentWakeTurns,
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
    delivery = await maybeWakeParentForSubagentMessage(context, message, delivery);
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

  async function maybeWakeParentForSubagentMessage(
    context: ModelToolExecutionContext,
    message: SubagentMessage,
    delivery: SubagentMessageDelivery,
  ): Promise<SubagentMessageDelivery> {
    const parentSessionId = delivery.deliveredParentSessionId ?? null;
    if (!parentSessionId || !context.session.subagentRunId || context.session.parentSessionId !== parentSessionId) {
      return delivery;
    }

    let nextDelivery = SubagentMessageDeliverySchema.parse({
      ...delivery,
      wakeRequestedParentSessionId: parentSessionId,
      wakeParentReason: "child_to_parent_handoff",
    });

    if (activeTurns.has(parentSessionId)) {
      return SubagentMessageDeliverySchema.parse({
        ...nextDelivery,
        wakeDeferredParentSessionId: parentSessionId,
        wakeParentReason: "parent_turn_active",
      });
    }

    if (
      subagentParentWakeJobs.has(message.id) ||
      await store.hasSubagentParentWakeTurn(parentSessionId, message.id)
    ) {
      return SubagentMessageDeliverySchema.parse({
        ...nextDelivery,
        wakeQueuedParentSessionId: parentSessionId,
        wakeParentReason: "parent_wake_already_queued",
      });
    }

    const chainCount = await store.countSubagentParentWakeTurns(parentSessionId, message.fromRunId);
    if (chainCount >= SUBAGENT_PARENT_WAKE_MAX_CHAIN) {
      return SubagentMessageDeliverySchema.parse({
        ...nextDelivery,
        wakeDeferredParentSessionId: parentSessionId,
        wakeParentReason: `parent_wake_loop_limit:${SUBAGENT_PARENT_WAKE_MAX_CHAIN}`,
      });
    }

    const parentSession = await getSession(parentSessionId).catch(() => null);
    if (!parentSession) {
      return SubagentMessageDeliverySchema.parse({
        ...nextDelivery,
        wakeDeferredParentSessionId: parentSessionId,
        wakeParentReason: "parent_session_missing",
      });
    }

    const requestedAt = now();
    const receipt = turnFollowUpQueue.enqueue(
      {
        label: `Subagent handoff from ${context.session.subagentRoleId ?? context.session.subagentRunId}`,
        metadata: {
          messageId: message.id,
          parentSessionId,
          childSessionId: context.session.id,
          fromRunId: message.fromRunId,
          kind: message.kind,
        },
      },
      async () => {
        try {
          await sendTurn(parentSessionId, {
            prompt: subagentParentWakePrompt({
              parentSession,
              childSession: context.session,
              message,
            }),
            metadata: {
              subagentParentWake: {
                messageId: message.id,
                parentGoalId: message.parentGoalId,
                fromRunId: message.fromRunId,
                childSessionId: context.session.id,
                childRoleId: context.session.subagentRoleId ?? null,
                kind: message.kind,
                requestedAt,
              },
            },
          });
        } catch (error) {
          await appendRuntimeEvent(
            event({
              sessionId: parentSessionId,
              name: "diagnostic",
              source: "server",
              appId: parentSession.appId,
              status: "failed",
              output: textFromUnknown(error) || "Failed to wake parent for subagent handoff.",
              data: {
                kind: "subagent_parent_wake_failed",
                messageId: message.id,
                fromRunId: message.fromRunId,
                childSessionId: context.session.id,
              },
            }),
          ).catch(() => undefined);
        } finally {
          subagentParentWakeJobs.delete(message.id);
        }
      },
    );
    subagentParentWakeJobs.set(message.id, receipt);
    nextDelivery = SubagentMessageDeliverySchema.parse({
      ...nextDelivery,
      wakeQueuedParentSessionId: parentSessionId,
      wakeParentReason: "parent_wake_queued",
    });
    return nextDelivery;
  }

  function subagentParentWakePrompt(input: {
    parentSession: Session;
    childSession: Session;
    message: SubagentMessage;
  }): string {
    const role = input.childSession.subagentRoleId ?? "subagent";
    const refs = input.message.refs.length
      ? input.message.refs.slice(0, 8).map((ref) => `- ${ref.kind}:${ref.id} (${ref.label})`).join("\n")
      : "None.";
    return [
      `A ${role} subagent sent a ${input.message.kind} handoff to this main chat.`,
      "",
      `Child run: ${input.message.fromRunId}`,
      `Child conversation: ${input.childSession.id}`,
      input.message.parentGoalId ? `Goal: ${input.message.parentGoalId}` : null,
      "",
      "Message:",
      input.message.body,
      "",
      "Refs:",
      refs,
      "",
      "Decide the next step as the main agent. You may respond to the user, update the goal, message the child back with openpond_subagent_send_message, route work to another child, join/cancel a child, or continue without action. Do not poll for routine lifecycle status unless a fresh diagnostic snapshot is actually needed.",
    ].filter(Boolean).join("\n");
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
      const active = activeTurns.get(recipient.childSessionId);
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


  async function appendSubagentReviewCorrectionMessage(input: {
    context: ModelToolExecutionContext;
    run: SubagentRun;
    summary: string | null;
    issues: string[];
    requiredCorrections: string[];
    priority: SubagentMessagePriority;
  }): Promise<SubagentMessage | null> {
    const deps = requireSubagentDeps();
    const delivered = Boolean(input.run.childSessionId);
    let delivery: SubagentMessageDelivery = {
      status: delivered ? "delivered" : "undelivered",
      deliveredRunIds: delivered ? [input.run.id] : [],
      acknowledgedRunIds: delivered ? [input.run.id] : [],
      deliveredParentSessionId: null,
      acknowledgedParentSessionId: null,
      wakeRequestedParentSessionId: null,
      wakeQueuedParentSessionId: null,
      wakeDeferredParentSessionId: null,
      wakeParentReason: null,
      wakeRequestedRunIds: [],
      wakeInterruptedRunIds: [],
      wakeDeferredRunIds: [],
      reason: delivered ? null : "The reviewed child run has no child session for correction delivery.",
    };
    let message = SubagentMessageSchema.parse({
      id: randomUUID(),
      parentGoalId: input.run.parentGoalId,
      fromRunId: input.context.session.subagentRunId ?? `parent:${input.context.session.id}`,
      toRunId: input.run.id,
      toRole: input.run.roleId,
      kind: "status",
      priority: input.priority,
      body: subagentReviewCorrectionBody(input),
      refs: [],
      delivery,
      createdAt: now(),
    });
    if (delivered) {
      await deliverSubagentMessageToReceivers(input.context, message, [input.run]);
    }
    const wake = input.priority === "interrupt"
      ? await wakeInterruptPrioritySubagentRuns(input.context, message, [input.run])
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
        sessionId: input.context.session.id,
        turnId: input.context.turnId,
        name: "subagent.message",
        source: "provider",
        appId: input.context.session.appId,
        status: delivery.status === "delivered" ? "completed" : "pending",
        output: input.priority === "interrupt"
          ? "Interrupt subagent review correction sent."
          : "Subagent review correction sent.",
        data: {
          message,
          delivery,
          deliveredRunIds: delivery.deliveredRunIds,
          modelRef: input.run.modelRef,
        },
      }),
    );
    return message;
  }

  function subagentReviewCorrectionBody(input: {
    summary: string | null;
    issues: string[];
    requiredCorrections: string[];
  }): string {
    return [
      "Review decision: needs_revision.",
      input.summary ? `Summary: ${input.summary}` : null,
      input.issues.length ? `Issues:\n${input.issues.map((issue) => `- ${issue}`).join("\n")}` : null,
      input.requiredCorrections.length
        ? `Required corrections:\n${input.requiredCorrections.map((correction) => `- ${correction}`).join("\n")}`
        : null,
      "Revise the submission, run relevant validation, and submit a new review packet.",
    ].filter(Boolean).join("\n\n");
  }


  return {
    appendSubagentReviewCorrectionMessage,
    deliverSubagentMessageToReceivers,
    sendSubagentMessageFromModelTool,
    wakeInterruptPrioritySubagentRuns,
    withSubagentInterruptWakeMetadata,
  };
}
