import { randomUUID } from "node:crypto";
import {
  SubagentLifecycleActionRequestSchema,
  SubagentProgressSchema,
  SubagentRunSchema,
  type AppPreferences,
  type RuntimeEvent,
  type Session,
  type SubagentLifecycleActionResponse,
  type SubagentRoleSettings,
  type SubagentRun,
  type Turn,
} from "@openpond/contracts";
import type {
  OpenPondSubagentCancelToolInput,
  OpenPondSubagentJoinToolInput,
  OpenPondSubagentFollowupToolInput,
  OpenPondSubagentStartToolInput,
  OpenPondSubagentStatusToolInput,
  OpenPondSubagentStatusToolResult,
  OpenPondSubagentToolResult,
} from "../../openpond/capability-tool-registry.js";
import type { ModelToolExecutionContext } from "../../openpond/model-tool-registry.js";
import {
  assertSubagentRunAccessible,
  subagentChildSystemContext,
} from "./policies-and-prompts.js";
import type { SubagentTurnPermissions } from "./continuation-runtime.js";
import { now, textFromUnknown } from "../../utils.js";
import type { BackgroundWorkerQueue } from "../background-worker-queue.js";
import {
  recordFromUnknown,
  stringFromRecord,
  uniqueNonEmptyStrings,
} from "../turns/value-utils.js";

type AppendSubagentReceipt = (input: {
  parentSession: Session;
  parentTurnId?: string | null;
  run: SubagentRun;
  childSession?: Session | null;
  eventName: Extract<RuntimeEvent["name"], `subagent.${string}`>;
  status: RuntimeEvent["status"];
  output: string;
}) => Promise<void>;

type PreparedIsolation = {
  cwd: string | null;
  effectiveIsolationMode: SubagentRoleSettings["isolationMode"];
  blocker: string | null;
  workspace: Record<string, unknown> | null;
  sessionWorkspace?: Partial<Pick<
    Session,
    "workspaceKind" | "workspaceId" | "workspaceName" | "localProjectId" | "cloudProjectId" | "cloudTeamId" | "metadata"
  >> | null;
};

export function createSubagentToolRuntime(deps: {
  requireSubagentDeps(): {
    createSession(input: Record<string, unknown>): Promise<Session>;
    queue: BackgroundWorkerQueue;
    getRun(runId: string): Promise<SubagentRun | null>;
    upsertRun(run: SubagentRun): Promise<unknown>;
    listRuns(input: {
      parentSessionId?: string;
      parentGoalId?: string;
      status?: SubagentRun["status"][];
      limit?: number;
    }): Promise<SubagentRun[]>;
  };
  loadAppPreferences(): Promise<AppPreferences>;
  currentGoal(sessionId: string): Promise<unknown>;
  getSession(sessionId: string): Promise<Session>;
  appendSubagentReceipt: AppendSubagentReceipt;
  subagentWorkspaceTargetKeyForSession(session: Session): Promise<string>;
  subagentWorkspaceTargetKeyFromRun(run: SubagentRun): string | null;
  subagentChildTurnPermissions(
    parent: SubagentTurnPermissions,
    role: SubagentRoleSettings,
  ): SubagentTurnPermissions;
  prepareSubagentWorkspaceIsolation(input: {
    parentSession: Session;
    role: SubagentRoleSettings;
    runId: string;
  }): Promise<PreparedIsolation>;
  runSubagentChildTurn(input: {
    run: SubagentRun;
    role: SubagentRoleSettings;
    childSession: Session;
    parentSession: Session;
    parentTurnId: string;
    contextPack: string | null;
    childTurnPermissions: SubagentTurnPermissions;
    initialPrompt?: string | null;
  }): Promise<void>;
  subagentToolResultFromRun(run: SubagentRun, nextStep: string): OpenPondSubagentToolResult;
  subagentRoleLabel(role: SubagentRoleSettings): string;
  interruptSessionTurn(sessionId: string, reason?: string): Promise<Turn>;
  cleanupSubagentRun(input: {
    run: SubagentRun;
    parentSession: Session;
    parentTurnId?: string | null;
    reason: string;
    policy: "auto_after_acceptance" | "cancel_requested" | "manual_cleanup" | "retention_expired";
  }): Promise<{ run: SubagentRun; workspaceCleanup: Record<string, unknown> }>;
  queueSubagentFollowupMessage(input: {
    context: ModelToolExecutionContext;
    run: SubagentRun;
    body: string;
  }): Promise<void>;
  archiveSubagentChildSession(input: {
    parentSession: Session;
    parentTurnId?: string | null;
    run: SubagentRun;
    reason: string;
    policy: "manual_archive";
  }): Promise<{ run: SubagentRun; sessionArchive: Record<string, unknown> }>;
  subagentLifecycleActionNextStep(
    action: "cleanup" | "archive" | "cleanup_and_archive",
    workspaceCleanup: Record<string, unknown> | null,
    sessionArchive: Record<string, unknown> | null,
  ): string;
}) {
  const SUBAGENT_JOIN_WAIT_MS = 60_000;
  const SUBAGENT_JOIN_POLL_MS = 250;
  const workspaceWriteStartReservations = new Set<string>();
  const requireSubagentDeps = deps.requireSubagentDeps;
  const loadAppPreferences = deps.loadAppPreferences;
  const getSession = deps.getSession;
  const appendSubagentReceipt = deps.appendSubagentReceipt;
  const subagentWorkspaceTargetKeyForSession = deps.subagentWorkspaceTargetKeyForSession;
  const subagentWorkspaceTargetKeyFromRun = deps.subagentWorkspaceTargetKeyFromRun;
  const subagentChildTurnPermissions = deps.subagentChildTurnPermissions;
  const prepareSubagentWorkspaceIsolation = deps.prepareSubagentWorkspaceIsolation;
  const runSubagentChildTurn = deps.runSubagentChildTurn;
  const subagentToolResultFromRun = deps.subagentToolResultFromRun;
  const subagentRoleLabel = deps.subagentRoleLabel;
  const interruptSessionTurn = deps.interruptSessionTurn;
  const cleanupSubagentRun = deps.cleanupSubagentRun;
  const queueSubagentFollowupMessage = deps.queueSubagentFollowupMessage;
  const archiveSubagentChildSession = deps.archiveSubagentChildSession;
  const subagentLifecycleActionNextStep = deps.subagentLifecycleActionNextStep;
  const store = {
    currentOpenPondThreadGoal: async (sessionId: string) => recordFromUnknown(await deps.currentGoal(sessionId)),
  };
  async function startSubagentFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentStartToolInput,
  ): Promise<OpenPondSubagentToolResult> {
    if (context.session.subagentRunId) {
      throw new Error("Child subagents cannot start additional subagents in this version.");
    }
    const deps = requireSubagentDeps();
    const preferences = await loadAppPreferences();
    if (!preferences.subagents.enabled) throw new Error("Subagents are disabled in settings.");
    const role = preferences.subagents.roles.find((candidate) => candidate.id === input.roleId);
    if (!role?.enabled) throw new Error(`Subagent role ${input.roleId} is not enabled.`);
    const parentModelRef = context.model ? { providerId: context.provider, modelId: context.model } : null;
    const modelRef = role.modelRef ?? preferences.subagents.defaultModelRef ?? parentModelRef ?? preferences.defaultChatModelRef ?? {
      providerId: preferences.defaultChatProvider,
      modelId: preferences.defaultChatModel,
    };
    const workspaceTargetKey = await subagentWorkspaceTargetKeyForSession(context.session);
    const writeCapable = role.toolPolicy !== "read_only";
    if (writeCapable && workspaceWriteStartReservations.has(workspaceTargetKey)) {
      throw new Error(`Another write-capable subagent is starting for ${workspaceTargetKey}.`);
    }
    if (writeCapable) workspaceWriteStartReservations.add(workspaceTargetKey);
    try {
    const activeRuns = await deps.listRuns({
      parentSessionId: context.session.id,
      status: ["queued", "running", "needs_resume"],
      limit: 1000,
    });
    if (activeRuns.length >= preferences.subagents.maxConcurrentRuns) {
      throw new Error(
        `Subagent concurrency limit reached: ${activeRuns.length}/${preferences.subagents.maxConcurrentRuns} active child runs.`,
      );
    }
    const activeRoleRuns = activeRuns.filter((run) => run.roleId === role.id);
    if (activeRoleRuns.length >= role.maxConcurrentRuns) {
      throw new Error(
        `Subagent role ${role.id} concurrency limit reached: ${activeRoleRuns.length}/${role.maxConcurrentRuns} active runs.`,
      );
    }
    const providerLimit = preferences.subagents.maxConcurrentRunsPerProvider;
    if (providerLimit !== null) {
      const activeProviderRuns = activeRuns.filter((run) => run.modelRef?.providerId === modelRef.providerId);
      if (activeProviderRuns.length >= providerLimit) {
        throw new Error(
          `Subagent provider ${modelRef.providerId} concurrency limit reached: ${activeProviderRuns.length}/${providerLimit} active runs.`,
        );
      }
    }
    const workspaceTargetLimit = preferences.subagents.maxConcurrentRunsPerWorkspaceTarget;
    if (workspaceTargetLimit !== null && writeCapable) {
      const allActiveRuns = await deps.listRuns({
        status: ["queued", "running", "needs_resume"],
        limit: 1000,
      });
      const activeWorkspaceRuns = allActiveRuns.filter(
        (run) => run.toolPolicy !== "read_only" && subagentWorkspaceTargetKeyFromRun(run) === workspaceTargetKey,
      );
      if (activeWorkspaceRuns.length >= workspaceTargetLimit) {
        throw new Error(
          `Subagent workspace target concurrency limit reached: ${activeWorkspaceRuns.length}/${workspaceTargetLimit} active runs for ${workspaceTargetKey}.`,
        );
      }
    }
    const parentGoal = (await store.currentOpenPondThreadGoal(context.session.id)) ?? {};
    const parentGoalId = stringFromRecord(parentGoal, "id");
    const parentGoalStatus = stringFromRecord(parentGoal, "status");
    if (parentGoalId && parentGoalStatus !== "running") {
      throw new Error(
        `Cannot start a subagent for goal ${parentGoalId} while it is ${parentGoalStatus ?? "not running"}. Resume the goal first.`,
      );
    }
    const runId = randomUUID();
    const createdAt = now();
    const childTurnPermissions = subagentChildTurnPermissions(context.turnPermissions, role);
    const isolation = await prepareSubagentWorkspaceIsolation({
      parentSession: context.session,
      role,
      runId,
    });
    const childSessionWorkspace = isolation.sessionWorkspace ?? {};
    const contextPack = input.context ?? null;
    const childSystemContext = subagentChildSystemContext({
      role,
      objective: input.objective,
      parentSession: context.session,
      contextPack,
    });
    const childSessionMetadata = {
      ...(recordFromUnknown(childSessionWorkspace.metadata) ?? {}),
      subagent: {
        runId,
        roleId: role.id,
        parentSessionId: context.session.id,
        parentTurnId: context.turnId,
        parentGoalId,
        toolPolicy: role.toolPolicy,
        requestedIsolationMode: role.isolationMode,
        effectiveIsolationMode: isolation.effectiveIsolationMode,
        workspace: isolation.workspace,
        systemContext: childSystemContext,
      },
    };
    const childSession = await deps.createSession({
      provider: modelRef.providerId,
      modelRef,
      openPondCommandAccessMode: context.session.openPondCommandAccessMode,
      hiddenFromDefaultSidebar: true,
      parentSessionId: context.session.id,
      parentTurnId: context.turnId,
      parentGoalId,
      subagentRunId: runId,
      subagentRoleId: role.id,
      appId: context.session.appId,
      appName: context.session.appName,
      workspaceKind: childSessionWorkspace.workspaceKind ?? context.session.workspaceKind,
      workspaceId: childSessionWorkspace.workspaceId ?? context.session.workspaceId,
      workspaceName: childSessionWorkspace.workspaceName ?? context.session.workspaceName,
      localProjectId: childSessionWorkspace.localProjectId ?? context.session.localProjectId,
      cloudProjectId: childSessionWorkspace.cloudProjectId ?? context.session.cloudProjectId,
      cloudTeamId: childSessionWorkspace.cloudTeamId ?? context.session.cloudTeamId,
      cwd: isolation.cwd ?? context.session.cwd,
      title: `${subagentRoleLabel(role)}: ${input.objective.slice(0, 72)}`,
      metadata: childSessionMetadata,
    });
    const isolationBlocker = isolation.blocker;
    const run = SubagentRunSchema.parse({
      id: runId,
      parentSessionId: context.session.id,
      parentTurnId: context.turnId,
      parentGoalId,
      childSessionId: childSession.id,
      roleId: role.id,
      objective: input.objective,
      modelRef,
      isolationMode: role.isolationMode,
      toolPolicy: role.toolPolicy,
      background: role.background,
      peerMessages: role.peerMessages,
      status: isolationBlocker ? "failed" : "queued",
      progress: SubagentProgressSchema.parse({
        phase: isolationBlocker ? "report" : "orient",
        currentBlocker: isolationBlocker,
        latestMeaningfulActivity: isolationBlocker
          ? "Child failed before execution because isolation is unavailable."
          : "Child run created.",
        updatedAt: createdAt,
      }),
      createdAt,
      startedAt: null,
      completedAt: isolationBlocker ? createdAt : null,
      error: isolationBlocker,
      report: isolationBlocker
        ? {
            summary: "Child could not start because write-capable isolation is unavailable.",
            blockers: [isolationBlocker],
            followUpNeeded: true,
          }
        : null,
      metadata: {
        context: contextPack,
        childTurnPermissions,
        concurrency: {
          providerId: modelRef.providerId,
          providerMaxConcurrentRuns: providerLimit,
          workspaceTargetKey,
          workspaceTargetMaxConcurrentRuns: workspaceTargetLimit,
        },
        subagentWorkspace: isolation.workspace,
      },
    });
    await deps.upsertRun(run);
    await appendSubagentReceipt({
      parentSession: context.session,
      parentTurnId: context.turnId,
      run,
      childSession,
      eventName: isolationBlocker ? "subagent.failed" : "subagent.started",
      status: isolationBlocker ? "failed" : "pending",
      output: isolationBlocker
        ? `Child ${role.id} failed to start: ${isolationBlocker}`
        : `Started ${role.id} subagent.`,
    });
    if (!isolationBlocker && role.background) {
      deps.queue.enqueue(
        {
          label: `${role.id}: ${input.objective.slice(0, 80)}`,
          metadata: { runId, childSessionId: childSession.id, parentSessionId: context.session.id },
        },
        () => runSubagentChildTurn({
          run,
          role,
          childSession,
          parentSession: context.session,
          parentTurnId: context.turnId,
          contextPack,
          childTurnPermissions,
        }),
      );
    }
    return subagentToolResultFromRun(run, isolationBlocker
      ? "Open the child conversation or wait for workspace isolation support before retrying write-capable work."
      : "Subagent queued in its own child conversation. Continue useful parent work or wait for its completion notification.");
    } finally {
      if (writeCapable) workspaceWriteStartReservations.delete(workspaceTargetKey);
    }
  }

  async function statusSubagentsFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentStatusToolInput,
  ): Promise<OpenPondSubagentStatusToolResult> {
    const deps = requireSubagentDeps();
    const runs = input.runId
      ? [(await deps.getRun(input.runId))].filter((run): run is SubagentRun => Boolean(run))
      : await deps.listRuns({
          parentSessionId: context.session.id,
          parentGoalId: input.parentGoalId ?? undefined,
          limit: 50,
        });
    for (const run of runs) {
      assertSubagentRunAccessible(context.session, run);
    }
    return {
      runs: runs.map((run) => subagentToolResultFromRun(run, "Subagent status loaded.")),
      nextStep: runs.length === 0 ? "No matching subagent runs." : `Loaded ${runs.length} subagent run${runs.length === 1 ? "" : "s"}.`,
    };
  }

  async function joinSubagentFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentJoinToolInput,
  ): Promise<OpenPondSubagentToolResult> {
    const deps = requireSubagentDeps();
    let run = await deps.getRun(input.runId);
    if (!run) throw new Error(`Subagent run ${input.runId} was not found.`);
    assertSubagentRunAccessible(context.session, run);
    const deadline = Date.now() + SUBAGENT_JOIN_WAIT_MS;
    while ((run.status === "queued" || run.status === "running") && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, SUBAGENT_JOIN_POLL_MS));
      run = (await deps.getRun(input.runId)) ?? run;
    }
    if (run.status !== "queued" && run.status !== "running") {
      run = SubagentRunSchema.parse({
        ...run,
        metadata: {
          ...(run.metadata ?? {}),
          completionConsumedByParent: {
            at: now(),
            parentSessionId: context.session.id,
            parentTurnId: context.turnId,
            childCompletedAt: run.completedAt,
          },
        },
      });
      await deps.upsertRun(run);
    }
    return subagentToolResultFromRun(
      run,
      run.status === "completed"
        ? "Child completed; use its final result or inspect the child conversation."
        : run.status === "queued" || run.status === "running"
          ? "Child is still running after the wait window. End this turn and let its automatic completion notification continue the parent; do not poll, sleep, or interrupt it for status."
          : `Child ended with status ${run.status}; inspect its result before deciding the next action.`,
    );
  }

  async function cancelSubagentFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentCancelToolInput,
  ): Promise<OpenPondSubagentToolResult> {
    const deps = requireSubagentDeps();
    const run = await deps.getRun(input.runId);
    if (!run) throw new Error(`Subagent run ${input.runId} was not found.`);
    assertSubagentRunAccessible(context.session, run);
    if (run.status === "completed") {
      return subagentToolResultFromRun(run, "Subagent already completed; no cancellation was applied.");
    }
    if (run.status === "cancelled") {
      return subagentToolResultFromRun(run, "Subagent was already cancelled.");
    }
    const reason = input.reason?.trim() || "Subagent cancelled by request.";
    const cancelledAt = now();
    let nextRun = SubagentRunSchema.parse({
      ...run,
      status: "cancelled",
      completedAt: cancelledAt,
      error: reason,
      report: {
        ...(run.report ?? {}),
        summary: run.report?.summary || "Subagent cancelled before completion.",
        blockers: uniqueNonEmptyStrings([...(run.report?.blockers ?? []), reason]),
        followUpNeeded: false,
      },
      metadata: {
        ...(run.metadata ?? {}),
        cancellation: {
          reason,
          cancelledAt,
          requestedBySessionId: context.session.id,
          requestedByTurnId: context.turnId,
        },
      },
    });
    await deps.upsertRun(nextRun);

    let interruptResult: Record<string, unknown> | null = null;
    if (run.childSessionId) {
      try {
        const interrupted = await interruptSessionTurn(run.childSessionId);
        interruptResult = {
          status: interrupted.status,
          turnId: interrupted.id,
        };
      } catch (error) {
        interruptResult = {
          status: "not_active",
          error: textFromUnknown(error) || "No active child turn to interrupt.",
        };
      }
    }
    let cleanupResult: Record<string, unknown> | null = input.cleanupWorkspace === false
      ? { status: "skipped", reason: "cleanupWorkspace was false" }
      : null;
    if (input.cleanupWorkspace !== false) {
      const cleanup = await cleanupSubagentRun({
        run: nextRun,
        parentSession: context.session,
        parentTurnId: context.turnId,
        reason: "cancel_requested",
        policy: "cancel_requested",
      });
      nextRun = cleanup.run;
      cleanupResult = cleanup.workspaceCleanup;
    }
    nextRun = SubagentRunSchema.parse({
      ...nextRun,
      metadata: {
        ...(nextRun.metadata ?? {}),
        cancellation: {
          ...(recordFromUnknown(nextRun.metadata?.cancellation) ?? {}),
          interruptResult,
          workspaceCleanup: cleanupResult,
        },
      },
    });
    await deps.upsertRun(nextRun);
    const parentSession = run.parentSessionId === context.session.id
      ? context.session
      : await getSession(run.parentSessionId).catch(() => context.session);
    await appendSubagentReceipt({
      parentSession,
      parentTurnId: run.parentTurnId ?? context.turnId,
      run: nextRun,
      eventName: "subagent.cancelled",
      status: "failed",
      output: `${run.roleId} subagent cancelled: ${reason}`,
    });
    return subagentToolResultFromRun(
      nextRun,
      cleanupResult?.status === "removed"
        ? "Subagent cancelled and isolated workspace cleanup completed."
        : "Subagent cancelled.",
    );
  }

  async function followupSubagentFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentFollowupToolInput,
  ): Promise<OpenPondSubagentToolResult> {
    const runtime = requireSubagentDeps();
    const run = await runtime.getRun(input.runId);
    if (!run) throw new Error(`Subagent run ${input.runId} was not found.`);
    assertSubagentRunAccessible(context.session, run);
    if (!run.childSessionId) throw new Error(`Subagent run ${run.id} has no child conversation.`);
    if (run.status === "cancelled") {
      throw new Error(`Subagent run ${run.id} is ${run.status} and cannot receive a follow-up.`);
    }

    await queueSubagentFollowupMessage({ context, run, body: input.message });
    if (run.status === "queued" || run.status === "running") {
      return subagentToolResultFromRun(
        run,
        "Follow-up delivered to the running child and will be read at the next safe model boundary.",
      );
    }

    const preferences = await loadAppPreferences();
    const role = preferences.subagents.roles.find((candidate) => candidate.id === run.roleId);
    if (!role?.enabled) throw new Error(`Subagent role ${run.roleId} is not enabled.`);
    const childSession = await getSession(run.childSessionId);
    const parentSession = run.parentSessionId === context.session.id
      ? context.session
      : await getSession(run.parentSessionId);
    const queuedAt = now();
    const queued = SubagentRunSchema.parse({
      ...run,
      status: "queued",
      completedAt: null,
      error: null,
      report: null,
      progress: SubagentProgressSchema.parse({
        ...run.progress,
        phase: "orient",
        latestMeaningfulActivity: "Follow-up task queued in the existing child conversation.",
        currentBlocker: null,
        updatedAt: queuedAt,
      }),
      metadata: {
        ...run.metadata,
        completionConsumedByParent: null,
        followup: { queuedAt, requestedBySessionId: context.session.id, requestedByTurnId: context.turnId },
      },
    });
    await runtime.upsertRun(queued);
    const childTurnPermissions = subagentChildTurnPermissions(context.turnPermissions, role);
    runtime.queue.enqueue(
      {
        label: `${role.id} follow-up: ${input.message.slice(0, 72)}`,
        metadata: { runId: run.id, childSessionId: childSession.id, parentSessionId: parentSession.id, followup: true },
      },
      () => runSubagentChildTurn({
        run: queued,
        role,
        childSession,
        parentSession,
        parentTurnId: context.turnId,
        contextPack: typeof run.metadata?.context === "string" ? run.metadata.context : null,
        childTurnPermissions,
        initialPrompt: input.message,
      }),
    );
    return subagentToolResultFromRun(queued, "Follow-up turn queued in the existing child conversation.");
  }

  async function runSubagentLifecycleAction(
    runId: string,
    payload: unknown,
  ): Promise<SubagentLifecycleActionResponse> {
    const input = SubagentLifecycleActionRequestSchema.parse(payload);
    const deps = requireSubagentDeps();
    const run = await deps.getRun(runId);
    if (!run) throw new Error(`Subagent run ${runId} was not found.`);
    const parentSession = await getSession(run.parentSessionId);
    const reason = input.reason ?? `Manual subagent ${input.action} requested.`;
    let nextRun = run;
    let workspaceCleanup: Record<string, unknown> | null = null;
    let sessionArchive: Record<string, unknown> | null = null;

    if (input.action === "cleanup" || input.action === "cleanup_and_archive") {
      const cleanup = await cleanupSubagentRun({
        run: nextRun,
        parentSession,
        parentTurnId: nextRun.parentTurnId ?? null,
        reason,
        policy: "manual_cleanup",
      });
      nextRun = cleanup.run;
      workspaceCleanup = cleanup.workspaceCleanup;
    }

    if (input.action === "archive" || input.action === "cleanup_and_archive") {
      const archived = await archiveSubagentChildSession({
        parentSession,
        parentTurnId: nextRun.parentTurnId ?? null,
        run: nextRun,
        reason,
        policy: "manual_archive",
      });
      nextRun = archived.run;
      sessionArchive = archived.sessionArchive;
    }

    return {
      action: input.action,
      run: nextRun,
      workspaceCleanup,
      sessionArchive,
      nextStep: subagentLifecycleActionNextStep(input.action, workspaceCleanup, sessionArchive),
    };
  }

  async function cleanupExpiredRetainedSubagentWorkspace(
    runId: string,
    payload: unknown = {},
  ): Promise<SubagentLifecycleActionResponse> {
    const input = recordFromUnknown(payload) ?? {};
    const deps = requireSubagentDeps();
    const run = await deps.getRun(runId);
    if (!run) throw new Error(`Subagent run ${runId} was not found.`);
    const parentSession = await getSession(run.parentSessionId);
    const checkedAt = stringFromRecord(input, "checkedAt") ?? now();
    const reason = stringFromRecord(input, "reason") ??
      `Retained subagent workspace retention expired at ${checkedAt}.`;
    const cleanup = await cleanupSubagentRun({
      run,
      parentSession,
      parentTurnId: run.parentTurnId ?? null,
      reason,
      policy: "retention_expired",
    });
    return {
      action: "cleanup",
      run: cleanup.run,
      workspaceCleanup: cleanup.workspaceCleanup,
      sessionArchive: null,
      nextStep: subagentLifecycleActionNextStep("cleanup", cleanup.workspaceCleanup, null),
    };
  }

  return {
    cancelSubagentFromModelTool,
    cleanupExpiredRetainedSubagentWorkspace,
    followupSubagentFromModelTool,
    joinSubagentFromModelTool,
    runSubagentLifecycleAction,
    startSubagentFromModelTool,
    statusSubagentsFromModelTool,
  };
}
