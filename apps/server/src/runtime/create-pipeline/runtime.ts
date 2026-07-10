import {
  DEFAULT_OPENPOND_CHAT_MODEL,
  ResolveApprovalRequestSchema,
  UpdateTurnCreatePipelineRequestSchema,
  type Approval,
  type ChatModelRef,
  type ChatProvider,
  type CreatePipelineRequest,
  type CreatePipelineSnapshot,
  type ModelUsageRecord,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "@openpond/contracts";
import { streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn } from "@openpond/runtime";
import {
  assertCreatePipelineMutationApproved,
  assertCreatePipelineSnapshotLinked,
  isCreatePipelineMutationState,
} from "../../create-pipeline-guards.js";
import { isOpenAiCompatibleProviderId } from "../../openpond/openai-compatible-provider.js";
import { event } from "../../utils.js";
import type { BackgroundWorkerQueue, BackgroundWorkReceipt } from "../background-worker-queue.js";
import {
  createBlockedCreatePipelinePlannerSnapshot,
  runModelBackedCreatePipelinePlanner,
  type CreatePipelinePlanner,
} from "../create-pipeline-planner.js";
import {
  applyApprovedLocalCreatePipelineSnapshot,
  type LocalCreatePipelineCheckInput,
  type LocalCreatePipelineCheckResult,
} from "../local-create-pipeline.js";
import { startProviderRequestUsageRecorder } from "../model-usage-recorder.js";
import { KeyedRegistry } from "../turns/keyed-registry.js";
import type { HostedToolLoopDelta, TurnRunnerDependencies } from "../turns/ports.js";
import {
  approvalStatusForPlan,
  createPipelineBackgroundFailureSnapshot,
  createPipelineRuntimeEventStatus,
  createPlanApproval,
  createPlanDecisionSnapshot,
  createPlanExecutionSnapshotForApprovedAdapter,
  shouldRunCreatePipelinePlanner,
} from "./snapshots.js";

export type CreatePipelineRuntime = ReturnType<typeof createCreatePipelineRuntime>;

export function createCreatePipelineRuntime(deps: {
  getSession(sessionId: string): Promise<Session>;
  getTurn(turnId: string): Promise<Turn | null>;
  updateTurn(turnId: string, updater: (turn: Turn) => Turn): Promise<Turn | null>;
  getApproval(approvalId: string): Promise<Approval | null>;
  upsertApproval(approval: Approval): Promise<void>;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  ensureCodexRuntime: TurnRunnerDependencies["ensureCodexRuntime"];
  runLocalCreatePipelineChecks?: (input: LocalCreatePipelineCheckInput) => Promise<LocalCreatePipelineCheckResult>;
  planCreatePipeline?: CreatePipelinePlanner;
  turnFollowUpQueue: BackgroundWorkerQueue;
  streamLocalByokChatTurn?: (input: {
    providerId: ChatProvider;
    modelId?: string | null;
    messages: Parameters<typeof runModelBackedCreatePipelinePlanner>[0]["stream"] extends (messages: infer M) => unknown ? M : never;
    requestId: string;
    signal: AbortSignal;
  }) => AsyncGenerator<HostedToolLoopDelta, void, unknown>;
  streamOpenPondHostedChatTurn?: typeof defaultStreamOpenPondHostedChatTurn;
  upsertModelUsageRecord(record: ModelUsageRecord): Promise<void>;
}) {
  const applyJobs = new KeyedRegistry<BackgroundWorkReceipt>("create pipeline apply job");
  const streamOpenPondHostedChatTurn = deps.streamOpenPondHostedChatTurn ?? defaultStreamOpenPondHostedChatTurn;

  async function updateTurnCreatePipeline(sessionId: string, turnId: string, payload: unknown): Promise<Turn> {
    const input = UpdateTurnCreatePipelineRequestSchema.parse(payload);
    const session = await deps.getSession(sessionId);
    const requestedRequest = input.createPipelineRequest ?? input.createPipeline.request ?? null;
    assertCreatePipelineSnapshotLinked({
      actionLabel: "Create pipeline turn update",
      request: requestedRequest,
      snapshot: input.createPipeline,
    });
    const existingTurn = await deps.getTurn(turnId);
    if (!existingTurn || existingTurn.sessionId !== sessionId) throw new Error("Turn not found");
    let nextSnapshot = input.createPipeline;
    if (shouldRunCreatePipelinePlanner(nextSnapshot)) {
      await deps.appendRuntimeEvent(event({
        sessionId,
        turnId,
        name: "create_pipeline.updated",
        source: "server",
        appId: session.appId,
        status: "pending",
        output: "Create planner is preparing the plan.",
        data: { createPipelineRequest: requestedRequest, createPipeline: nextSnapshot },
      }));
      nextSnapshot = await planCreatePipelineForTurn({
        session,
        turn: existingTurn,
        request: requestedRequest ?? nextSnapshot.request,
        previousSnapshot: nextSnapshot,
        signal: new AbortController().signal,
      });
    }
    let queueApply = false;
    if (isCreatePipelineMutationState(nextSnapshot.state)) {
      assertCreatePipelineMutationApproved({
        actionLabel: "Create pipeline turn update",
        request: requestedRequest,
        snapshot: nextSnapshot,
      });
      nextSnapshot = createPlanExecutionSnapshotForApprovedAdapter(nextSnapshot, session);
      queueApply = shouldApplyLocalCreatePipelineAsync(nextSnapshot);
    }
    const result = await deps.updateTurn(turnId, (current) => {
      if (current.sessionId !== sessionId) throw new Error("Turn not found");
      if (current.createPipelineRequest?.id && requestedRequest?.id && current.createPipelineRequest.id !== requestedRequest.id) {
        throw new Error("Create pipeline turn update cannot change the original request.");
      }
      return withCreatePipeline(current, requestedRequest, nextSnapshot);
    });
    if (!result) throw new Error("Turn not found");
    await appendSnapshotEvent(session, result, nextSnapshot, "ui_button");
    await syncCreatePlanApproval({ session, turn: result, request: result.createPipelineRequest ?? requestedRequest, snapshot: result.createPipeline });
    if (queueApply && result.createPipeline) {
      queueLocalCreatePipelineApply({ session, turn: result, request: result.createPipelineRequest ?? requestedRequest, snapshot: result.createPipeline });
    }
    return result;
  }

  async function resolveCreatePipelineApproval(approvalId: string, payload: unknown): Promise<Approval | null> {
    const input = ResolveApprovalRequestSchema.parse(payload);
    const approval = await deps.getApproval(approvalId);
    if (!approval || approval.kind !== "create_plan") return null;
    if (approval.status !== "pending") throw new Error("Approval not found or already resolved");
    const turn = approval.turnId ? await deps.getTurn(approval.turnId) : null;
    if (!turn?.createPipeline) throw new Error("Create plan approval is missing its create pipeline turn.");
    const session = await deps.getSession(approval.sessionId);
    const decided = createPlanDecisionSnapshot(turn.createPipeline, input.decision);
    const snapshot = createPlanExecutionSnapshotForApprovedAdapter(decided, session);
    const queueApply = shouldApplyLocalCreatePipelineAsync(snapshot);
    const result = await deps.updateTurn(turn.id, (current) => {
      if (current.sessionId !== approval.sessionId) throw new Error("Turn not found");
      return withCreatePipeline(current, current.createPipelineRequest ?? snapshot.request, snapshot);
    });
    if (!result) throw new Error("Turn not found");
    assertCreatePipelineSnapshotLinked({ actionLabel: "Create plan approval resolution", request: result.createPipelineRequest ?? snapshot.request, snapshot });
    if (isCreatePipelineMutationState(snapshot.state)) {
      assertCreatePipelineMutationApproved({ actionLabel: "Create plan approval resolution", request: result.createPipelineRequest ?? snapshot.request, snapshot });
    }
    await appendSnapshotEvent(session, result, snapshot, "ui_button");
    const resolved = await syncCreatePlanApproval({ session, turn: result, request: result.createPipelineRequest ?? snapshot.request, snapshot });
    if (queueApply) queueLocalCreatePipelineApply({ session, turn: result, request: result.createPipelineRequest ?? snapshot.request, snapshot });
    return resolved;
  }

  async function syncCreatePlanApproval(input: {
    session: Session;
    turn: Turn;
    request?: CreatePipelineRequest | null;
    snapshot?: CreatePipelineSnapshot | null;
  }): Promise<Approval | null> {
    const snapshot = input.snapshot;
    const plan = snapshot?.plan ?? null;
    if (!snapshot || !plan?.approvalId) return null;
    const existing = await deps.getApproval(plan.approvalId);
    const approval = createPlanApproval({
      existing,
      session: input.session,
      turn: input.turn,
      request: input.request ?? snapshot.request,
      snapshot,
      status: approvalStatusForPlan(plan.status),
    });
    await deps.upsertApproval(approval);
    if (!existing && approval.status === "pending") {
      await deps.appendRuntimeEvent(event({
        sessionId: input.session.id,
        turnId: input.turn.id,
        name: "approval.requested",
        source: "server",
        action: "create_plan",
        appId: input.session.appId,
        status: "pending",
        output: approval.title,
        data: approval,
      }));
    }
    if (existing?.status === "pending" && approval.status !== "pending") {
      await deps.appendRuntimeEvent(event({
        sessionId: input.session.id,
        turnId: input.turn.id,
        name: "approval.resolved",
        source: "server",
        action: "create_plan",
        appId: input.session.appId,
        status: approval.status === "accepted" || approval.status === "accepted_for_session" ? "completed" : "failed",
        output: approval.title,
        data: { approvalId: approval.id, status: approval.status },
      }));
    }
    return approval;
  }

  function queueLocalCreatePipelineApply(input: {
    session: Session;
    turn: Turn;
    request?: CreatePipelineRequest | null;
    snapshot: CreatePipelineSnapshot;
  }): void {
    const key = `${input.session.id}:${input.turn.id}:${input.snapshot.id}`;
    if (applyJobs.has(key)) return;
    const receipt = deps.turnFollowUpQueue.enqueue(
      {
        label: "Apply approved local Create pipeline",
        metadata: { key, sessionId: input.session.id, turnId: input.turn.id, pipelineId: input.snapshot.id },
      },
      async () => {
        try {
          await runQueuedLocalCreatePipelineApply(input);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await persistCreatePipelineSnapshot({
            session: input.session,
            turnId: input.turn.id,
            request: input.request ?? input.snapshot.request,
            snapshot: createPipelineBackgroundFailureSnapshot(input.snapshot, message),
            source: "server",
          });
        } finally {
          applyJobs.delete(key);
        }
      },
    );
    applyJobs.set(key, receipt);
  }

  async function runQueuedLocalCreatePipelineApply(input: {
    session: Session;
    turn: Turn;
    request?: CreatePipelineRequest | null;
    snapshot: CreatePipelineSnapshot;
  }): Promise<void> {
    const latestTurn = await deps.getTurn(input.turn.id) ?? input.turn;
    const snapshot = await applyApprovedLocalCreatePipelineSnapshot(input.snapshot, {
      session: input.session,
      turn: latestTurn,
      ensureCodexRuntime: deps.ensureCodexRuntime,
      appendRuntimeEvent: deps.appendRuntimeEvent,
      setProviderTurnId: (providerTurnId) => setTurnProviderTurnId(input.session.id, input.turn.id, providerTurnId),
      onSnapshot: async (next) => {
        await persistCreatePipelineSnapshot({ session: input.session, turnId: input.turn.id, request: input.request ?? next.request, snapshot: next, source: "server" });
      },
      model: input.session.provider === "codex" ? input.session.modelRef?.modelId ?? null : null,
      runChecks: deps.runLocalCreatePipelineChecks,
    });
    await persistCreatePipelineSnapshot({ session: input.session, turnId: input.turn.id, request: input.request ?? snapshot.request, snapshot, source: "server" });
  }

  async function planCreatePipelineForTurn(input: {
    session: Session;
    turn: Turn;
    request: CreatePipelineRequest;
    previousSnapshot?: CreatePipelineSnapshot | null;
    signal: AbortSignal;
  }): Promise<CreatePipelineSnapshot> {
    if (deps.planCreatePipeline) {
      return deps.planCreatePipeline({
        request: input.request,
        previousSnapshot: input.previousSnapshot ?? null,
        modelRef: input.turn.modelRef,
        requestId: `${input.turn.id}:create-planner`,
        signal: input.signal,
      });
    }
    const providerId = input.turn.modelRef?.providerId ?? input.session.provider;
    const modelId = input.turn.modelRef?.modelId ?? (providerId === "openpond" ? DEFAULT_OPENPOND_CHAT_MODEL : null);
    if (providerId === "openpond") {
      const model = modelId || DEFAULT_OPENPOND_CHAT_MODEL;
      return runRecordedPlanner({
        ...input,
        previousSnapshot: input.previousSnapshot ?? null,
        provider: providerId,
        model,
        modelRef: { providerId, modelId: model },
        requestId: `${input.turn.id}:create-planner`,
        stream: async function* (messages) {
          for await (const delta of streamOpenPondHostedChatTurn({ model, messages, requestId: `${input.turn.id}:create-planner`, signal: input.signal })) {
            if (delta.type === "text_delta" && delta.text) yield { text: delta.text, raw: delta.raw };
            if (delta.type === "usage") yield { raw: delta.raw, usage: delta.usage };
          }
        },
      });
    }
    if (isOpenAiCompatibleProviderId(providerId) && deps.streamLocalByokChatTurn) {
      if (!modelId) throw new Error(`Create planner requires a selected model for provider ${providerId}.`);
      return runRecordedPlanner({
        ...input,
        previousSnapshot: input.previousSnapshot ?? null,
        provider: providerId,
        model: modelId,
        modelRef: { providerId, modelId },
        requestId: `${input.turn.id}:create-planner`,
        stream: (messages) => deps.streamLocalByokChatTurn!({ providerId, modelId, messages, requestId: `${input.turn.id}:create-planner`, signal: input.signal }),
      });
    }
    throw new Error("Create planner requires OpenPond Chat or a configured OpenAI-compatible provider.");
  }

  async function runRecordedPlanner(input: {
    session: Session;
    turn: Turn;
    request: CreatePipelineRequest;
    previousSnapshot: CreatePipelineSnapshot | null;
    provider: ChatProvider;
    model: string;
    modelRef: ChatModelRef;
    requestId: string;
    signal: AbortSignal;
    stream: Parameters<typeof runModelBackedCreatePipelinePlanner>[0]["stream"];
  }): Promise<CreatePipelineSnapshot> {
    const usageTurn = withCreatePipeline(input.turn, input.request, input.previousSnapshot);
    const recorder = await startProviderRequestUsageRecorder({
      session: input.session,
      turn: usageTurn,
      provider: input.provider,
      model: input.model,
      requestId: input.requestId,
      requestOrdinal: 0,
      requestKind: "create_pipeline_planner",
      upsert: deps.upsertModelUsageRecord,
    });
    try {
      const snapshot = await runModelBackedCreatePipelinePlanner({
        request: input.request,
        previousSnapshot: input.previousSnapshot,
        modelRef: input.modelRef,
        requestId: input.requestId,
        signal: input.signal,
        stream: async function* (messages) {
          for await (const delta of input.stream(messages)) {
            recorder.observeDelta(delta);
            yield delta;
          }
        },
      });
      usageTurn.createPipeline = snapshot;
      await recorder.complete();
      return snapshot;
    } catch (error) {
      await recorder.fail(error, input.signal.aborted || (error instanceof Error && error.name === "AbortError") ? "interrupted" : "failed");
      throw error;
    }
  }

  async function persistCreatePipelinePlanningFailure(input: {
    session: Session;
    turn: Turn;
    request: CreatePipelineRequest;
    message: string;
  }): Promise<Turn | null> {
    const current = await deps.getTurn(input.turn.id);
    const existing = current?.createPipeline ?? input.turn.createPipeline ?? null;
    if (existing && existing.state !== "planning") return current;
    return persistCreatePipelineSnapshot({
      session: input.session,
      turnId: input.turn.id,
      request: input.request,
      snapshot: createBlockedCreatePipelinePlannerSnapshot({
        request: input.request,
        previousSnapshot: existing,
        modelRef: current?.modelRef ?? input.turn.modelRef,
        reason: `Create planner failed: ${input.message}`,
      }),
      source: "server",
    });
  }

  async function persistCreatePipelineSnapshot(input: {
    session: Session;
    turnId: string;
    request?: CreatePipelineRequest | null;
    snapshot: CreatePipelineSnapshot;
    source: RuntimeEvent["source"];
  }): Promise<Turn> {
    const result = await deps.updateTurn(input.turnId, (current) => {
      if (current.sessionId !== input.session.id) throw new Error("Turn not found");
      return withCreatePipeline(current, input.request ?? current.createPipelineRequest ?? input.snapshot.request, input.snapshot);
    });
    if (!result) throw new Error("Turn not found");
    await appendSnapshotEvent(input.session, result, input.snapshot, input.source);
    await syncCreatePlanApproval({ session: input.session, turn: result, request: result.createPipelineRequest ?? input.request ?? input.snapshot.request, snapshot: input.snapshot });
    return result;
  }

  async function appendSnapshotEvent(session: Session, turn: Turn, snapshot: CreatePipelineSnapshot, source: RuntimeEvent["source"]): Promise<void> {
    await deps.appendRuntimeEvent(event({
      sessionId: session.id,
      turnId: turn.id,
      name: "create_pipeline.updated",
      source,
      appId: session.appId,
      status: createPipelineRuntimeEventStatus(snapshot),
      output: snapshot.blockedReason ?? snapshot.plan?.summary ?? snapshot.state,
      data: { createPipelineRequest: turn.createPipelineRequest, createPipeline: snapshot },
    }));
  }

  function withCreatePipeline(turn: Turn, request: CreatePipelineRequest | null, snapshot: CreatePipelineSnapshot | null): Turn {
    return {
      ...turn,
      metadata: { ...(turn.metadata ?? {}), createPipelineRequest: request, createPipeline: snapshot },
      createPipelineRequest: request,
      createPipeline: snapshot,
    };
  }

  function shouldApplyLocalCreatePipelineAsync(snapshot: CreatePipelineSnapshot): boolean {
    return snapshot.state === "applying_source" && snapshot.plan?.status === "approved" && snapshot.request.adapter.kind === "local";
  }

  async function setTurnProviderTurnId(sessionId: string, turnId: string, providerTurnId: string): Promise<void> {
    await deps.updateTurn(turnId, (current) => current.sessionId === sessionId ? { ...current, providerTurnId } : current);
  }

  return {
    assertNoLeakedApplyJobs: () => applyJobs.assertEmpty(),
    persistCreatePipelinePlanningFailure,
    persistCreatePipelineSnapshot,
    planCreatePipelineForTurn,
    queueLocalCreatePipelineApply,
    resolveCreatePipelineApproval,
    syncCreatePlanApproval,
    updateTurnCreatePipeline,
  };
}
