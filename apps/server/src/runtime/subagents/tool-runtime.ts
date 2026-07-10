import { randomUUID } from "node:crypto";
import {
  SubagentLifecycleActionRequestSchema,
  SubagentProgressSchema,
  SubagentReviewStateSchema,
  SubagentRunSchema,
  type AppPreferences,
  type RuntimeEvent,
  type Session,
  type SubagentLifecycleActionResponse,
  type SubagentMessage,
  type SubagentRoleSettings,
  type SubagentRun,
  type SubagentWorkerBrief,
  type Turn,
} from "@openpond/contracts";
import type {
  OpenPondSubagentCancelToolInput,
  OpenPondSubagentJoinToolInput,
  OpenPondSubagentReviewToolInput,
  OpenPondSubagentStartToolInput,
  OpenPondSubagentStatusToolInput,
  OpenPondSubagentStatusToolResult,
  OpenPondSubagentToolResult,
} from "../../openpond/capability-tool-registry.js";
import type { ModelToolExecutionContext } from "../../openpond/model-tool-registry.js";
import {
  assertSubagentRunAccessible,
  subagentChildSystemContext,
  subagentDismissable,
  subagentReviewable,
  subagentRunAccepted,
  subagentWorkerBriefForStart,
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
  subagentUsageBudgetForParent(input: {
    parentSessionId: string;
    roleId: string;
    preferences: AppPreferences;
  }): Promise<{ totalTokens: number; roleTokens: number; totalMaxTokens: number | null; roleMaxTokens: number | null }>;
  assertSubagentBudgetAvailable(input: {
    budget: { totalTokens: number; roleTokens: number; totalMaxTokens: number | null; roleMaxTokens: number | null };
    role: SubagentRoleSettings;
  }): void;
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
    workerBrief: SubagentWorkerBrief;
    childTurnPermissions: SubagentTurnPermissions;
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
  appendSubagentReviewCorrectionMessage(input: {
    context: ModelToolExecutionContext;
    run: SubagentRun;
    summary: string | null;
    issues: string[];
    requiredCorrections: string[];
    priority: "normal" | "interrupt";
  }): Promise<SubagentMessage | null>;
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
  const workspaceWriteStartReservations = new Set<string>();
  const requireSubagentDeps = deps.requireSubagentDeps;
  const loadAppPreferences = deps.loadAppPreferences;
  const getSession = deps.getSession;
  const appendSubagentReceipt = deps.appendSubagentReceipt;
  const subagentWorkspaceTargetKeyForSession = deps.subagentWorkspaceTargetKeyForSession;
  const subagentWorkspaceTargetKeyFromRun = deps.subagentWorkspaceTargetKeyFromRun;
  const subagentUsageBudgetForParent = deps.subagentUsageBudgetForParent;
  const assertSubagentBudgetAvailable = deps.assertSubagentBudgetAvailable;
  const subagentChildTurnPermissions = deps.subagentChildTurnPermissions;
  const prepareSubagentWorkspaceIsolation = deps.prepareSubagentWorkspaceIsolation;
  const runSubagentChildTurn = deps.runSubagentChildTurn;
  const subagentToolResultFromRun = deps.subagentToolResultFromRun;
  const subagentRoleLabel = deps.subagentRoleLabel;
  const interruptSessionTurn = deps.interruptSessionTurn;
  const cleanupSubagentRun = deps.cleanupSubagentRun;
  const appendSubagentReviewCorrectionMessage = deps.appendSubagentReviewCorrectionMessage;
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
    const parentGoalId = stringFromRecord(
      (await store.currentOpenPondThreadGoal(context.session.id)) ?? {},
      "id",
    );
    const budget = await subagentUsageBudgetForParent({
      parentSessionId: context.session.id,
      roleId: role.id,
      preferences,
    });
    assertSubagentBudgetAvailable({ budget, role });
    const runId = randomUUID();
    const createdAt = now();
    const childTurnPermissions = subagentChildTurnPermissions(context.turnPermissions, role);
    const isolation = await prepareSubagentWorkspaceIsolation({
      parentSession: context.session,
      role,
      runId,
    });
    const childSessionWorkspace = isolation.sessionWorkspace ?? {};
    const workerBrief = subagentWorkerBriefForStart({
      role,
      objective: input.objective,
      provided: input.workerBrief ?? null,
    });
    const childSystemContext = subagentChildSystemContext({
      role,
      objective: input.objective,
      parentSession: context.session,
      contextPack: input.context ?? null,
      workerBrief,
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
        workerBrief,
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
      status: isolationBlocker ? "blocked" : "queued",
      required: input.required ?? true,
      workerBrief,
      progress: SubagentProgressSchema.parse({
        phase: isolationBlocker ? "report" : "orient",
        currentBlocker: isolationBlocker,
        latestMeaningfulActivity: isolationBlocker
          ? "Subagent blocked before execution because isolation is unavailable."
          : "Subagent run created with a structured worker brief.",
        updatedAt: createdAt,
      }),
      review: SubagentReviewStateSchema.parse({
        status: "pending",
      }),
      createdAt,
      startedAt: null,
      completedAt: isolationBlocker ? createdAt : null,
      error: isolationBlocker,
      report: isolationBlocker
        ? {
            summary: "Subagent blocked before execution because write-capable child isolation is not available yet.",
            blockers: [isolationBlocker],
            followUpNeeded: true,
          }
        : null,
      metadata: {
        context: input.context ?? null,
        workerBrief,
        childTurnPermissions,
        tokenBudget: {
          totalMaxTokens: preferences.subagents.maxTokens,
          roleMaxTokens: role.maxTokens,
          roleMaxTurns: role.maxTurns,
          totalTokensUsedBeforeStart: budget.totalTokens,
          roleTokensUsedBeforeStart: budget.roleTokens,
        },
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
      eventName: isolationBlocker ? "subagent.blocked" : "subagent.started",
      status: isolationBlocker ? "failed" : "pending",
      output: isolationBlocker
        ? `Subagent ${role.id} blocked: ${isolationBlocker}`
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
          contextPack: input.context ?? null,
          workerBrief,
          childTurnPermissions,
        }),
      );
    }
    return subagentToolResultFromRun(run, isolationBlocker
      ? "Open the child conversation or wait for workspace isolation support before retrying write-capable work."
      : "Subagent queued in the background. This start call does not wait for completion; continue parent work and use pushed receipts, or call openpond_subagent_join only when an explicit blocking/diagnostic check is needed.");
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
    const run = await deps.getRun(input.runId);
    if (!run) throw new Error(`Subagent run ${input.runId} was not found.`);
    assertSubagentRunAccessible(context.session, run);
    return subagentToolResultFromRun(run, subagentRunAccepted(run)
      ? "Subagent accepted; use its report and child conversation as evidence."
      : run.status === "submitted_for_review"
        ? "Subagent submitted a review packet; parent/reviewer should evaluate before treating it as accepted."
        : "Subagent has not been accepted yet; continue parent work, review the packet, or check again later.");
  }

  async function cancelSubagentFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentCancelToolInput,
  ): Promise<OpenPondSubagentToolResult> {
    const deps = requireSubagentDeps();
    const run = await deps.getRun(input.runId);
    if (!run) throw new Error(`Subagent run ${input.runId} was not found.`);
    assertSubagentRunAccessible(context.session, run);
    if (subagentRunAccepted(run)) {
      return subagentToolResultFromRun(run, "Subagent already accepted; no cancellation was applied.");
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

  async function reviewSubagentFromModelTool(
    context: ModelToolExecutionContext,
    input: OpenPondSubagentReviewToolInput,
  ): Promise<OpenPondSubagentToolResult> {
    const deps = requireSubagentDeps();
    const run = await deps.getRun(input.runId);
    if (!run) throw new Error(`Subagent run ${input.runId} was not found.`);
    assertSubagentRunAccessible(context.session, run);
    if (context.session.id === run.childSessionId || context.session.subagentRunId === run.id) {
      throw new Error("Child subagents cannot review their own submission.");
    }
    const dismissed = input.decision === "dismiss";
    if (dismissed) {
      if (!subagentDismissable(run)) {
        throw new Error(`Subagent run ${run.id} is ${run.status}; only blocked, failed, or cancelled runs can be dismissed.`);
      }
    } else if (!subagentReviewable(run)) {
      throw new Error(`Subagent run ${run.id} is ${run.status}; only submitted or revision-state runs can be reviewed.`);
    }

    const decidedAt = now();
    const summary = input.summary?.trim() || run.report?.summary || run.review.summary || null;
    const issues = uniqueNonEmptyStrings([...(run.review.issues ?? []), ...(input.issues ?? [])]);
    const requiredCorrections = input.decision === "needs_revision"
      ? uniqueNonEmptyStrings([
          ...(run.review.requiredCorrections ?? []),
          ...(input.requiredCorrections ?? []),
          ...((input.requiredCorrections?.length ?? 0) === 0 && (input.issues?.length ?? 0) === 0
            ? ["Revise the submitted work and submit a new review packet before acceptance."]
            : []),
        ])
      : run.review.requiredCorrections;
    const accepted = input.decision === "accept";
    const needsRevision = input.decision === "needs_revision";
    const needsUserInput = input.decision === "needs_user_input";
    const latestMeaningfulActivity = accepted
      ? "Parent/reviewer accepted the child review packet."
      : needsRevision
        ? "Parent/reviewer requested child revision."
        : dismissed
          ? "Parent/reviewer dismissed the child run after acknowledgement."
          : "Parent/reviewer requested user input before accepting the child review packet.";
    let nextRun = SubagentRunSchema.parse({
      ...run,
      status: accepted ? "accepted" : needsRevision ? "needs_revision" : needsUserInput ? "needs_user_input" : run.status,
      completedAt: accepted ? decidedAt : dismissed ? run.completedAt ?? decidedAt : null,
      report: run.report
        ? {
            ...run.report,
            followUpNeeded: !accepted && !dismissed,
          }
        : run.report,
      progress: SubagentProgressSchema.parse({
        ...(run.progress ?? {}),
        latestMeaningfulActivity,
        currentBlocker: needsUserInput ? summary ?? latestMeaningfulActivity : null,
        updatedAt: decidedAt,
      }),
      review: SubagentReviewStateSchema.parse({
        ...(run.review ?? {}),
        status: accepted ? "accepted" : needsRevision ? "needs_revision" : needsUserInput ? "needs_user_input" : "dismissed",
        decidedAt,
        reviewerSessionId: context.session.id,
        summary,
        issues,
        requiredCorrections,
        humanReviewRecommended: !accepted && !dismissed,
      }),
      metadata: {
        ...(run.metadata ?? {}),
        reviewDecision: {
          decision: input.decision,
          decidedAt,
          reviewerSessionId: context.session.id,
          reviewerRunId: context.session.subagentRunId ?? null,
          messageChild: needsRevision ? input.messageChild !== false : false,
        },
      },
    });
    await deps.upsertRun(nextRun);

    let correctionMessage: SubagentMessage | null = null;
    if (needsRevision && input.messageChild !== false) {
      correctionMessage = await appendSubagentReviewCorrectionMessage({
        context,
        run: nextRun,
        summary,
        issues,
        requiredCorrections,
        priority: input.priority ?? "interrupt",
      });
    }

    const parentSession = run.parentSessionId === context.session.id
      ? context.session
      : await getSession(run.parentSessionId).catch(() => context.session);
    await appendSubagentReceipt({
      parentSession,
      parentTurnId: run.parentTurnId ?? context.turnId,
      run: nextRun,
      eventName: accepted ? "subagent.accepted" : dismissed ? "subagent.dismissed" : "subagent.needs_revision",
      status: accepted || dismissed ? "completed" : "failed",
      output: accepted
        ? `${run.roleId} subagent review packet accepted.`
        : dismissed
          ? `${run.roleId} subagent run dismissed after parent acknowledgement.`
        : needsRevision
          ? `${run.roleId} subagent needs revision.`
          : `${run.roleId} subagent needs user input before acceptance.`,
    });
    if (accepted) {
      const cleanup = await cleanupSubagentRun({
        run: nextRun,
        parentSession,
        parentTurnId: run.parentTurnId ?? context.turnId,
        reason: "accepted_review",
        policy: "auto_after_acceptance",
      });
      nextRun = cleanup.run;
    }

    return subagentToolResultFromRun(
      nextRun,
      accepted
        ? "Subagent accepted; use its report and child conversation as evidence."
        : dismissed
          ? "Subagent dismissed after explicit parent acknowledgement; it will not count as accepted work."
        : needsRevision
          ? correctionMessage
            ? "Subagent marked needs_revision and corrective message delivered to the child."
            : "Subagent marked needs_revision; corrective message was not delivered."
          : "Subagent marked needs_user_input; ask the user for the missing decision before accepting.",
    );
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
    joinSubagentFromModelTool,
    reviewSubagentFromModelTool,
    runSubagentLifecycleAction,
    startSubagentFromModelTool,
    statusSubagentsFromModelTool,
  };
}
