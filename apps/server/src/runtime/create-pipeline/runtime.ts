import {
  ApplyCreateImproveRunActionRequestSchema,
  DEFAULT_OPENPOND_CHAT_MODEL,
  ResolveApprovalRequestSchema,
  nextCreateImproveRunRevision,
  type Approval,
  type ChatModelRef,
  type ChatProvider,
  type CreateImproveRun,
  type CreateImproveRunAction,
  type ModelUsageRecord,
  type RuntimeEvent,
  type Session,
  type GradeResult,
  type TaskAttemptResult,
  type Taskset,
  type Turn,
} from "@openpond/contracts";
import { streamOpenPondHostedChatTurn as defaultStreamOpenPondHostedChatTurn } from "@openpond/runtime";
import {
  assertCreateImproveMutationApproved,
  assertCreateImproveRunLinked,
  isCreateImproveMutationState,
} from "../../create-pipeline-guards.js";
import { isOpenAiCompatibleProviderId } from "../../openpond/openai-compatible-provider.js";
import { event } from "../../utils.js";
import type { BackgroundWorkerQueue, BackgroundWorkReceipt } from "../background-worker-queue.js";
import {
  createBlockedCreateImprovePlannerRun,
  runModelBackedCreateImprovePlanner,
  type CreateImprovePlanner,
} from "../create-pipeline-planner.js";
import type {
  LocalCreatePipelineCheckInput,
  LocalCreatePipelineCheckResult,
} from "../local-create-pipeline.js";
import { startProviderRequestUsageRecorder } from "../model-usage-recorder.js";
import { KeyedRegistry } from "../turns/keyed-registry.js";
import type { HostedToolLoopDelta, TurnRunnerDependencies } from "../turns/ports.js";
import {
  applyCreateImproveRunAction,
  approvalStatusForPlan,
  createImproveBackgroundFailureRun,
  createImprovePlanApproval,
  createImproveRuntimeEventStatus,
  createPlanExecutionRunForApprovedAdapter,
  shouldRunCreateImprovePlanner,
  withCreateImproveRun,
} from "./snapshots.js";
import { createImproveTargetAdapter } from "./target-adapters.js";
import {
  executeAgentImprovementReleaseAction,
  isAgentImprovementReleaseAction,
} from "./agent-improvement-release.js";

export type CreateImproveRuntime = ReturnType<typeof createCreateImproveRuntime>;

export function createCreateImproveRuntime(deps: {
  getSession(sessionId: string): Promise<Session>;
  getTurn(turnId: string): Promise<Turn | null>;
  updateTurn(turnId: string, updater: (turn: Turn) => Turn): Promise<Turn | null>;
  getCreateImproveRun(runId: string): Promise<CreateImproveRun | null>;
  listCreateImproveRuns(query?: {
    profileId?: string | null;
    conversationId?: string | null;
    targetKind?: CreateImproveRun["target"]["kind"] | null;
    targetId?: string | null;
    state?: CreateImproveRun["state"] | readonly CreateImproveRun["state"][] | null;
    limit?: number;
  }): Promise<CreateImproveRun[]>;
  upsertCreateImproveRun(run: CreateImproveRun): Promise<CreateImproveRun>;
  mutateCreateImproveRun(
    action: CreateImproveRunAction,
    updater: (run: CreateImproveRun) => CreateImproveRun,
  ): Promise<{ run: CreateImproveRun; replayed: boolean }>;
  getApproval(approvalId: string): Promise<Approval | null>;
  upsertApproval(approval: Approval): Promise<void>;
  appendRuntimeEvent(runtimeEvent: RuntimeEvent): Promise<void>;
  ensureCodexRuntime: TurnRunnerDependencies["ensureCodexRuntime"];
  runLocalCreatePipelineChecks?: (input: LocalCreatePipelineCheckInput) => Promise<LocalCreatePipelineCheckResult>;
  planCreateImprove?: CreateImprovePlanner;
  turnFollowUpQueue: BackgroundWorkerQueue;
  streamLocalByokChatTurn?: (input: {
    providerId: ChatProvider;
    modelId?: string | null;
    messages: Parameters<typeof runModelBackedCreateImprovePlanner>[0]["stream"] extends (messages: infer M) => unknown ? M : never;
    requestId: string;
    signal: AbortSignal;
  }) => AsyncGenerator<HostedToolLoopDelta, void, unknown>;
  streamOpenPondHostedChatTurn?: typeof defaultStreamOpenPondHostedChatTurn;
  upsertModelUsageRecord(record: ModelUsageRecord): Promise<void>;
  resolveTaskset?: (tasksetId: string, revision: number, contentHash: string) => Promise<Taskset | null>;
  gradeTaskAttempt?: (input: { tasksetId: string; taskId: string; attempt: TaskAttemptResult }) => Promise<GradeResult>;
}) {
  const applyJobs = new KeyedRegistry<BackgroundWorkReceipt>("create/improve apply job");
  const streamOpenPondHostedChatTurn = deps.streamOpenPondHostedChatTurn
    ?? defaultStreamOpenPondHostedChatTurn;

  async function applyCreateImproveActionPayload(
    routeRunId: string,
    payload: unknown,
  ): Promise<CreateImproveRun> {
    const action = ApplyCreateImproveRunActionRequestSchema.parse(payload);
    if (action.runId !== routeRunId) {
      throw new Error("Create/Improve action route does not match the submitted run.");
    }
    const mutation = await deps.mutateCreateImproveRun(
      action,
      (current) => applyCreateImproveRunAction(current, action),
    );
    let run = mutation.replayed
      ? await deps.getCreateImproveRun(action.runId) ?? mutation.run
      : mutation.run;
    const turn = await turnForRun(run);
    const session = await deps.getSession(run.scope.conversationId ?? turn.sessionId);

    if (!mutation.replayed && shouldRunCreateImprovePlanner(run)) {
      run = await planCreateImproveForTurn({
        session,
        turn,
        run,
        signal: new AbortController().signal,
      });
    }
    if (!mutation.replayed && isCreateImproveMutationState(run.state)) {
      assertCreateImproveMutationApproved({ actionLabel: "Create/Improve action", run });
      run = createPlanExecutionRunForApprovedAdapter(run, session);
    }
    await persistCreateImproveRun({ session, turnId: turn.id, run, source: "ui_button" });
    if (!mutation.replayed && isAgentImprovementReleaseAction(action)) {
      queueAgentImprovementReleaseAction({ session, turn, run, action });
    } else if (!mutation.replayed && shouldExecuteTarget(run)) {
      queueCreateImproveExecution({ session, turn, run });
    }
    return await deps.getCreateImproveRun(run.id) ?? run;
  }

  async function resolveCreateImproveApproval(
    approvalId: string,
    payload: unknown,
  ): Promise<Approval | null> {
    const input = ResolveApprovalRequestSchema.parse(payload);
    const approval = await deps.getApproval(approvalId);
    if (!approval || approval.kind !== "create_plan") return null;
    if (approval.status !== "pending") throw new Error("Approval not found or already resolved");
    const turn = approval.turnId ? await deps.getTurn(approval.turnId) : null;
    const run = turn?.createImproveRun
      ?? (approval.providerRequestId ? await deps.getCreateImproveRun(String(approval.providerRequestId)) : null);
    if (!turn || !run) throw new Error("Create/Improve approval is missing its run.");
    const type = input.decision === "accept" || input.decision === "acceptForSession"
      ? "approve_plan"
      : input.decision === "cancel"
        ? "cancel"
        : "cancel";
    await applyCreateImproveActionPayload(run.id, {
      type,
      runId: run.id,
      expectedRevision: run.revision,
      actionId: `approval:${approvalId}:${input.decision}`,
      ...(type === "cancel"
        ? { reason: input.decision === "cancel" ? "Plan review cancelled." : "Plan review declined." }
        : {}),
    });
    return deps.getApproval(approvalId);
  }

  async function syncCreateImprovePlanApproval(input: {
    session: Session;
    turn: Turn;
    run?: CreateImproveRun | null;
  }): Promise<Approval | null> {
    const run = input.run;
    const plan = run?.plan ?? null;
    if (!run || !plan?.approvalId) return null;
    const existing = await deps.getApproval(plan.approvalId);
    const approval = createImprovePlanApproval({
      existing,
      session: input.session,
      turn: input.turn,
      run,
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
        status: approval.status === "accepted" || approval.status === "accepted_for_session"
          ? "completed"
          : "failed",
        output: approval.title,
        data: { approvalId: approval.id, runId: run.id, status: approval.status },
      }));
    }
    return approval;
  }

  function queueCreateImproveExecution(input: {
    session: Session;
    turn: Turn;
    run: CreateImproveRun;
  }): void {
    const key = `${input.run.id}:${input.run.revision}`;
    if (applyJobs.has(key)) return;
    const receipt = deps.turnFollowUpQueue.enqueue(
      {
        label: `Apply approved ${input.run.target.kind} Create/Improve run`,
        metadata: {
          key,
          sessionId: input.session.id,
          turnId: input.turn.id,
          runId: input.run.id,
          revision: input.run.revision,
        },
      },
      async () => {
        try {
          await runQueuedCreateImproveExecution(input);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await persistCreateImproveRun({
            session: input.session,
            turnId: input.turn.id,
            run: createImproveBackgroundFailureRun(input.run, message),
            source: "server",
          });
        } finally {
          applyJobs.delete(key);
        }
      },
    );
    applyJobs.set(key, receipt);
  }

  function queueAgentImprovementReleaseAction(input: {
    session: Session;
    turn: Turn;
    run: CreateImproveRun;
    action: Extract<
      CreateImproveRunAction,
      { type: "apply_candidate" | "open_pull_request" | "reject_candidate" | "reconcile_pull_request" }
    >;
  }): void {
    const key = `release:${input.run.id}:${input.run.revision}:${input.action.type}`;
    if (applyJobs.has(key)) return;
    const receipt = deps.turnFollowUpQueue.enqueue(
      {
        label: `${input.action.type.replaceAll("_", " ")} for Agent improvement`,
        metadata: {
          key,
          sessionId: input.session.id,
          turnId: input.turn.id,
          runId: input.run.id,
          revision: input.run.revision,
          action: input.action.type,
        },
      },
      async () => {
        try {
          const latestRun = await deps.getCreateImproveRun(input.run.id) ?? input.run;
          const result = await executeAgentImprovementReleaseAction({
            run: latestRun,
            action: input.action,
            resolveTaskset: deps.resolveTaskset,
            gradeTaskAttempt: deps.gradeTaskAttempt,
          });
          await persistCreateImproveRun({
            session: input.session,
            turnId: input.turn.id,
            run: result,
            source: "server",
          });
        } finally {
          applyJobs.delete(key);
        }
      },
    );
    applyJobs.set(key, receipt);
  }

  async function runQueuedCreateImproveExecution(input: {
    session: Session;
    turn: Turn;
    run: CreateImproveRun;
  }): Promise<void> {
    const latestTurn = await deps.getTurn(input.turn.id) ?? input.turn;
    const latestRun = await deps.getCreateImproveRun(input.run.id) ?? input.run;
    const adapter = createImproveTargetAdapter(latestRun.target);
    if (!adapter.canExecute(latestRun)) return;
    const result = adapter.normalizeResult(await adapter.execute(latestRun, {
      session: input.session,
      turn: latestTurn,
      ensureCodexRuntime: deps.ensureCodexRuntime,
      appendRuntimeEvent: deps.appendRuntimeEvent,
      setProviderTurnId: (providerTurnId) =>
        setTurnProviderTurnId(input.session.id, input.turn.id, providerTurnId),
      onRun: async (run) => {
        await persistCreateImproveRun({
          session: input.session,
          turnId: input.turn.id,
          run,
          source: "server",
        });
      },
      model: input.session.provider === "codex"
        ? input.session.modelRef?.modelId ?? null
        : null,
      runChecks: deps.runLocalCreatePipelineChecks,
      resolveTaskset: deps.resolveTaskset,
      gradeTaskAttempt: deps.gradeTaskAttempt,
    }));
    await persistCreateImproveRun({
      session: input.session,
      turnId: input.turn.id,
      run: result,
      source: "server",
    });
  }

  async function planCreateImproveForTurn(input: {
    session: Session;
    turn: Turn;
    run: CreateImproveRun;
    signal: AbortSignal;
  }): Promise<CreateImproveRun> {
    if (deps.planCreateImprove) {
      return deps.planCreateImprove({
        run: input.run,
        modelRef: input.turn.modelRef,
        requestId: `${input.turn.id}:create-improve-planner`,
        signal: input.signal,
      });
    }
    const providerId = input.turn.modelRef?.providerId ?? input.session.provider;
    const modelId = input.turn.modelRef?.modelId
      ?? (providerId === "openpond" ? DEFAULT_OPENPOND_CHAT_MODEL : null);
    if (providerId === "openpond") {
      const model = modelId || DEFAULT_OPENPOND_CHAT_MODEL;
      return runRecordedPlanner({
        ...input,
        provider: providerId,
        model,
        modelRef: { providerId, modelId: model },
        requestId: `${input.turn.id}:create-improve-planner`,
        stream: async function* (messages) {
          for await (const delta of streamOpenPondHostedChatTurn({
            model,
            messages,
            requestId: `${input.turn.id}:create-improve-planner`,
            signal: input.signal,
          })) {
            if (delta.type === "text_delta" && delta.text) {
              yield { text: delta.text, raw: delta.raw };
            }
            if (delta.type === "usage") yield { raw: delta.raw, usage: delta.usage };
          }
        },
      });
    }
    if (isOpenAiCompatibleProviderId(providerId) && deps.streamLocalByokChatTurn) {
      if (!modelId) {
        throw new Error(`Create/Improve planner requires a selected model for provider ${providerId}.`);
      }
      return runRecordedPlanner({
        ...input,
        provider: providerId,
        model: modelId,
        modelRef: { providerId, modelId },
        requestId: `${input.turn.id}:create-improve-planner`,
        stream: (messages) => deps.streamLocalByokChatTurn!({
          providerId,
          modelId,
          messages,
          requestId: `${input.turn.id}:create-improve-planner`,
          signal: input.signal,
        }),
      });
    }
    throw new Error("Create/Improve planner requires OpenPond Chat or a configured OpenAI-compatible provider.");
  }

  async function runRecordedPlanner(input: {
    session: Session;
    turn: Turn;
    run: CreateImproveRun;
    provider: ChatProvider;
    model: string;
    modelRef: ChatModelRef;
    requestId: string;
    signal: AbortSignal;
    stream: Parameters<typeof runModelBackedCreateImprovePlanner>[0]["stream"];
  }): Promise<CreateImproveRun> {
    const usageTurn = withCreateImproveRun(input.turn, input.run);
    const recorder = await startProviderRequestUsageRecorder({
      session: input.session,
      turn: usageTurn,
      provider: input.provider,
      model: input.model,
      requestId: input.requestId,
      requestOrdinal: 0,
      requestKind: "create_improve_planner",
      upsert: deps.upsertModelUsageRecord,
    });
    try {
      const run = await runModelBackedCreateImprovePlanner({
        run: input.run,
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
      usageTurn.createImproveRun = run;
      await recorder.complete();
      return run;
    } catch (error) {
      await recorder.fail(
        error,
        input.signal.aborted || (error instanceof Error && error.name === "AbortError")
          ? "interrupted"
          : "failed",
      );
      throw error;
    }
  }

  async function persistCreateImprovePlanningFailure(input: {
    session: Session;
    turn: Turn;
    run: CreateImproveRun;
    message: string;
  }): Promise<Turn | null> {
    const current = await deps.getCreateImproveRun(input.run.id)
      ?? input.turn.createImproveRun
      ?? input.run;
    if (current.state !== "planning") return deps.getTurn(input.turn.id);
    return persistCreateImproveRun({
      session: input.session,
      turnId: input.turn.id,
      run: createBlockedCreateImprovePlannerRun({
        run: current,
        modelRef: input.turn.modelRef,
        reason: `Create/Improve planner failed: ${input.message}`,
      }),
      source: "server",
    });
  }

  async function persistCreateImproveRun(input: {
    session: Session;
    turnId: string;
    run: CreateImproveRun;
    source: RuntimeEvent["source"];
  }): Promise<Turn> {
    assertCreateImproveRunLinked({ actionLabel: "Persist Create/Improve run", run: input.run });
    const run = input.run.scope.originTurnId
      ? input.run
      : nextCreateImproveRunRevision(input.run, {
          scope: { ...input.run.scope, originTurnId: input.turnId },
          updatedAt: new Date().toISOString(),
        });
    await deps.upsertCreateImproveRun(run);
    const result = await deps.updateTurn(input.turnId, (current) => {
      if (current.sessionId !== input.session.id) throw new Error("Turn not found");
      return withCreateImproveRun(current, run);
    });
    if (!result) throw new Error("Turn not found");
    await appendRunEvent(input.session, result, run, input.source);
    await syncCreateImprovePlanApproval({ session: input.session, turn: result, run });
    return result;
  }

  async function appendRunEvent(
    session: Session,
    turn: Turn,
    run: CreateImproveRun,
    source: RuntimeEvent["source"],
  ): Promise<void> {
    await deps.appendRuntimeEvent(event({
      sessionId: session.id,
      turnId: turn.id,
      name: "create_improve.updated",
      source,
      appId: session.appId,
      status: createImproveRuntimeEventStatus(run),
      output: run.blockedReason ?? run.plan?.summary ?? run.state,
      data: { createImproveRun: run },
    }));
  }

  function shouldExecuteTarget(run: CreateImproveRun): boolean {
    return createImproveTargetAdapter(run.target).canExecute(run);
  }

  async function turnForRun(run: CreateImproveRun): Promise<Turn> {
    const turnId = run.scope.originTurnId;
    if (!turnId) throw new Error(`Create/Improve run ${run.id} is not linked to a turn.`);
    const turn = await deps.getTurn(turnId);
    if (!turn) throw new Error(`Create/Improve turn not found: ${turnId}`);
    return turn;
  }

  async function setTurnProviderTurnId(
    sessionId: string,
    turnId: string,
    providerTurnId: string,
  ): Promise<void> {
    await deps.updateTurn(
      turnId,
      (current) => current.sessionId === sessionId ? { ...current, providerTurnId } : current,
    );
  }

  return {
    applyCreateImproveActionPayload,
    assertNoLeakedApplyJobs: () => applyJobs.assertEmpty(),
    getCreateImproveRun: deps.getCreateImproveRun,
    listCreateImproveRuns: deps.listCreateImproveRuns,
    persistCreateImprovePlanningFailure,
    persistCreateImproveRun,
    planCreateImproveForTurn,
    queueCreateImproveExecution,
    resolveCreateImproveApproval,
    syncCreateImprovePlanApproval,
  };
}
