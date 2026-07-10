import {
  SubagentProgressSchema,
  SubagentReviewStateSchema,
  SubagentRunSchema,
  type AppPreferences,
  type ModelUsageRecord,
  type RuntimeEvent,
  type SendTurnRequest,
  type Session,
  type SubagentProgress,
  type SubagentProgressPhase,
  type SubagentRoleSettings,
  type SubagentRun,
  type Turn,
  type UsageRequestAttribution,
} from "@openpond/contracts";
import {
  subagentReviewPacketQuality,
  subagentReviewRoutingRecommendation,
} from "./policies-and-prompts.js";
import {
  SUBAGENT_PROGRESS_PROJECTION_METADATA_KEY,
  subagentProgressProjectionFromRuntimeEvents,
  subagentProgressProjectionStateFromRun,
} from "./progress-reducer.js";
import { now } from "../../utils.js";
import {
  recordFromUnknown,
  stringFromRecord,
  uniqueNonEmptyStrings,
} from "../turns/value-utils.js";

export type SubagentTurnPermissions = Pick<
  SendTurnRequest,
  "approvalPolicy" | "sandbox" | "codexPermissionMode" | "codexReasoningEffort"
>;

type AppendSubagentReceipt = (input: {
  parentSession: Session;
  parentTurnId?: string | null;
  run: SubagentRun;
  childSession?: Session | null;
  eventName: Extract<RuntimeEvent["name"], `subagent.${string}`>;
  status: RuntimeEvent["status"];
  output: string;
}) => Promise<void>;

export function createSubagentContinuationRuntime(deps: {
  requireSubagentDeps(): {
    getRun(runId: string): Promise<SubagentRun | null>;
    upsertRun(run: SubagentRun): Promise<unknown>;
    listRuns(input: { parentSessionId?: string; limit?: number }): Promise<SubagentRun[]>;
    listUsageRecords(input: { status?: ModelUsageRecord["status"] }): Promise<ModelUsageRecord[]>;
  };
  runtimeEventsForSession(
    sessionId: string,
    query?: {
      afterSequence?: number | null;
      names?: readonly RuntimeEvent["name"][];
      limit?: number | null;
    },
  ): Promise<RuntimeEvent[]>;
  countTurnsForSession(sessionId: string): Promise<number>;
  latestAssistantTextForSession(sessionId: string): Promise<string | null>;
  loadAppPreferences(): Promise<AppPreferences>;
  getTurn(turnId: string): Promise<Turn | null>;
  getSession(sessionId: string): Promise<Session>;
  appendSubagentReceipt: AppendSubagentReceipt;
}) {
  const requireSubagentDeps = deps.requireSubagentDeps;
  const loadAppPreferences = deps.loadAppPreferences;
  const getStoredTurn = deps.getTurn;
  const getSession = deps.getSession;
  const appendSubagentReceipt = deps.appendSubagentReceipt;
  const store = {
    runtimeEventsForSession: deps.runtimeEventsForSession,
    countTurnsForSession: deps.countTurnsForSession,
    latestAssistantTextForSession: deps.latestAssistantTextForSession,
  };
  async function subagentRuntimeDerivedProgress(input: {
    run: SubagentRun;
    childSessionId: string;
    phase?: SubagentProgressPhase | null;
    latestMeaningfulActivity?: string | null;
    currentBlocker?: string | null;
  }): Promise<SubagentProgress> {
    const batchLimit = 1_000;
    let state = subagentProgressProjectionStateFromRun(input.run);
    let progress = input.run.progress;
    let processedBatch = false;
    while (true) {
      const events = await store.runtimeEventsForSession(input.childSessionId, {
        afterSequence: state.afterSequence,
        names: ["tool.started", "tool.completed", "workspace_action_result", "command.output"],
        limit: batchLimit,
      });
      for (const runtimeEvent of events) {
        if (!Number.isSafeInteger(runtimeEvent.sequence) || Number(runtimeEvent.sequence) <= state.afterSequence) {
          throw new Error(
            `Subagent progress event ${runtimeEvent.id} is missing a monotonic persisted sequence after ${state.afterSequence}.`,
          );
        }
      }
      const projected = subagentProgressProjectionFromRuntimeEvents({
        run: { ...input.run, progress },
        events,
        state,
        phase: input.phase ?? null,
        latestMeaningfulActivity: input.latestMeaningfulActivity ?? null,
        currentBlocker: input.currentBlocker ?? null,
      });
      if (events.length > 0 && projected.state.afterSequence <= state.afterSequence) {
        throw new Error(`Subagent progress cursor did not advance after sequence ${state.afterSequence}.`);
      }
      state = projected.state;
      progress = projected.progress;
      processedBatch = true;
      if (events.length < batchLimit) break;
    }
    if (!processedBatch) return progress;
    input.run.metadata = {
      ...(input.run.metadata ?? {}),
      [SUBAGENT_PROGRESS_PROJECTION_METADATA_KEY]: state,
    };
    return progress;
  }

  async function refreshSubagentRuntimeDerivedProgress(input: {
    run: SubagentRun;
    childSessionId: string;
    phase?: SubagentProgressPhase | null;
    latestMeaningfulActivity?: string | null;
    currentBlocker?: string | null;
  }): Promise<SubagentRun> {
    const deps = requireSubagentDeps();
    const previousProjection = input.run.metadata?.[SUBAGENT_PROGRESS_PROJECTION_METADATA_KEY];
    const progress = await subagentRuntimeDerivedProgress(input);
    const projection = input.run.metadata?.[SUBAGENT_PROGRESS_PROJECTION_METADATA_KEY];
    if (
      JSON.stringify(progress) === JSON.stringify(input.run.progress) &&
      JSON.stringify(projection) === JSON.stringify(previousProjection)
    ) return input.run;
    const updated = SubagentRunSchema.parse({
      ...input.run,
      progress,
      metadata: input.run.metadata,
    });
    await deps.upsertRun(updated);
    return updated;
  }

  type SubagentUsageBudgetSnapshot = {
    totalTokens: number;
    roleTokens: number;
    totalMaxTokens: number | null;
    roleMaxTokens: number | null;
  };

  type SubagentContinuationTurnContext = {
    run: SubagentRun;
    role: SubagentRoleSettings;
    usageAttribution: UsageRequestAttribution;
    turnPermissions: SubagentTurnPermissions;
    priorTurnCount: number;
    maxTurns: number | null;
    managedBySubagentRunner: boolean;
  };

  async function subagentUsageBudgetForParent(input: {
    parentSessionId: string;
    roleId: string;
    preferences: AppPreferences;
  }): Promise<SubagentUsageBudgetSnapshot> {
    const deps = requireSubagentDeps();
    const runs = await deps.listRuns({ parentSessionId: input.parentSessionId, limit: 10_000 });
    const runIds = new Set(runs.map((run) => run.id));
    const roleRunIds = new Set(runs.filter((run) => run.roleId === input.roleId).map((run) => run.id));
    const records = await deps.listUsageRecords({ status: "completed" });
    const totalTokens = subagentUsageTotal(records, runIds);
    const roleTokens = subagentUsageTotal(records, roleRunIds);
    const role = input.preferences.subagents.roles.find((candidate) => candidate.id === input.roleId) ?? null;
    return {
      totalTokens,
      roleTokens,
      totalMaxTokens: input.preferences.subagents.maxTokens,
      roleMaxTokens: role?.maxTokens ?? null,
    };
  }

  async function subagentUsageTotalsForRun(runId: string): Promise<{
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    requestCount: number;
  }> {
    const deps = requireSubagentDeps();
    const records = await deps.listUsageRecords({ status: "completed" });
    const matching = records.filter((record) => record.attribution.subagentRunId === runId);
    return {
      totalTokens: sumUsageField(matching, "totalTokens"),
      promptTokens: sumUsageField(matching, "promptTokens"),
      completionTokens: sumUsageField(matching, "completionTokens"),
      requestCount: matching.length,
    };
  }

  function assertSubagentBudgetAvailable(input: {
    budget: SubagentUsageBudgetSnapshot;
    role: SubagentRoleSettings;
  }): void {
    const { budget, role } = input;
    if (budget.totalMaxTokens !== null && budget.totalTokens >= budget.totalMaxTokens) {
      throw new Error(
        `Subagent token budget reached: ${budget.totalTokens}/${budget.totalMaxTokens} tokens used across this parent conversation.`,
      );
    }
    if (budget.roleMaxTokens !== null && budget.roleTokens >= budget.roleMaxTokens) {
      throw new Error(
        `Subagent role ${role.id} token budget reached: ${budget.roleTokens}/${budget.roleMaxTokens} tokens used.`,
      );
    }
  }

  async function prepareSubagentContinuationTurn(input: {
    session: Session;
    request: SendTurnRequest;
    requestedTurnPermissions: SubagentTurnPermissions;
  }): Promise<SubagentContinuationTurnContext | null> {
    if (!input.session.subagentRunId) return null;
    const deps = requireSubagentDeps();
    const run = await deps.getRun(input.session.subagentRunId);
    if (!run) throw new Error(`Subagent run ${input.session.subagentRunId} was not found.`);
    if (run.childSessionId && run.childSessionId !== input.session.id) {
      throw new Error(`Subagent run ${run.id} is linked to a different child conversation.`);
    }
    const preferences = await loadAppPreferences();
    const role = preferences.subagents.roles.find((candidate) => candidate.id === run.roleId);
    if (!role?.enabled) throw new Error(`Subagent role ${run.roleId} is not enabled.`);
    const budget = await subagentUsageBudgetForParent({
      parentSessionId: run.parentSessionId,
      roleId: run.roleId,
      preferences,
    });
    assertSubagentBudgetAvailable({ budget, role });
    const priorTurnCount = await store.countTurnsForSession(input.session.id);
    const maxTurns = subagentMaxTurnsForRun(role, run);
    if (maxTurns !== null && priorTurnCount >= maxTurns) {
      throw new Error(
        `Subagent role ${role.id} turn budget reached: ${priorTurnCount}/${maxTurns} turns used for run ${run.id}.`,
      );
    }
    const metadata = recordFromUnknown(input.request.metadata);
    const managedBySubagentRunner = stringFromRecord(metadata ?? {}, "subagentRunId") === run.id;
    return {
      run,
      role,
      usageAttribution: input.request.usageAttribution ?? subagentUsageAttribution(run),
      turnPermissions: subagentTurnPermissionsFromRun(run) ??
        subagentChildTurnPermissions(input.requestedTurnPermissions, role),
      priorTurnCount,
      maxTurns,
      managedBySubagentRunner,
    };
  }

  function subagentMaxTurnsForRun(role: SubagentRoleSettings, run: SubagentRun): number | null {
    if (role.maxTurns !== null) return role.maxTurns;
    const tokenBudget = recordFromUnknown(recordFromUnknown(run.metadata)?.tokenBudget);
    const value = tokenBudget?.roleMaxTurns;
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
  }

  function subagentTurnPermissionsFromRun(run: SubagentRun): SubagentTurnPermissions | null {
    const permissions = recordFromUnknown(recordFromUnknown(run.metadata)?.childTurnPermissions);
    if (!permissions) return null;
    const approvalPolicy = stringFromRecord(permissions, "approvalPolicy");
    const sandbox = stringFromRecord(permissions, "sandbox");
    const codexPermissionMode = stringFromRecord(permissions, "codexPermissionMode");
    const codexReasoningEffort = stringFromRecord(permissions, "codexReasoningEffort");
    if (!isApprovalPolicy(approvalPolicy) || !isSandboxMode(sandbox) || !isCodexPermissionMode(codexPermissionMode)) {
      return null;
    }
    return {
      approvalPolicy,
      sandbox,
      codexPermissionMode,
      codexReasoningEffort: isCodexReasoningEffort(codexReasoningEffort) ? codexReasoningEffort : undefined,
    };
  }

  function isApprovalPolicy(value: string | null): value is SendTurnRequest["approvalPolicy"] {
    return value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never";
  }

  function isSandboxMode(value: string | null): value is SendTurnRequest["sandbox"] {
    return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
  }

  function isCodexPermissionMode(value: string | null): value is SendTurnRequest["codexPermissionMode"] {
    return value === "default" || value === "auto-review" || value === "full-access";
  }

  function isCodexReasoningEffort(value: string | null): value is NonNullable<SendTurnRequest["codexReasoningEffort"]> {
    return value === "low" || value === "medium" || value === "high" || value === "xhigh";
  }

  async function markSubagentContinuationRunning(input: {
    context: SubagentContinuationTurnContext | null;
    childTurnId: string;
  }): Promise<void> {
    if (!input.context || input.context.managedBySubagentRunner) return;
    const run = input.context.run;
    if (run.status === "queued" || run.status === "running") return;
    const deps = requireSubagentDeps();
    const updated = SubagentRunSchema.parse({
      ...run,
      status: "running",
      startedAt: run.startedAt ?? now(),
      completedAt: null,
      error: null,
      progress: SubagentProgressSchema.parse({
        ...(run.progress ?? {}),
        phase: "orient",
        latestMeaningfulActivity: "Child follow-up turn started.",
        currentBlocker: null,
        updatedAt: now(),
      }),
      metadata: {
        ...(run.metadata ?? {}),
        lastFollowUpTurnId: input.childTurnId,
        lastFollowUpStartedAt: now(),
        turnBudget: {
          usedBeforeTurn: input.context.priorTurnCount,
          maxTurns: input.context.maxTurns,
        },
      },
    });
    await deps.upsertRun(updated);
    input.context.run = updated;
    const parentSession = await getSession(run.parentSessionId).catch(() => null);
    if (parentSession) {
      await appendSubagentReceipt({
        parentSession,
        parentTurnId: run.parentTurnId ?? input.childTurnId,
        run: updated,
        eventName: "subagent.started",
        status: "started",
        output: `${run.roleId} subagent follow-up is running.`,
      });
    }
  }

  async function finalizeSubagentContinuationTurn(input: {
    context: SubagentContinuationTurnContext | null;
    childSession: Session;
    childTurnId: string;
  }): Promise<void> {
    const context = input.context;
    if (!context || context.managedBySubagentRunner) return;
    const turn = await getStoredTurn(input.childTurnId);
    if (!turn || turn.status === "in_progress") return;
    const deps = requireSubagentDeps();
    const latestRun = await deps.getRun(context.run.id);
    if (!latestRun) return;
    const usage = await subagentUsageTotalsForRun(latestRun.id);
    const summary = await store.latestAssistantTextForSession(input.childSession.id);
    const completed = turn.status === "completed";
    const interrupted = turn.status === "interrupted";
    const message = turn.error || (completed ? null : "Subagent follow-up failed.");
    const submittedAt = now();
    const derivedProgress = await subagentRuntimeDerivedProgress({
      run: latestRun,
      childSessionId: input.childSession.id,
      phase: completed ? "submitted" : interrupted ? null : "report",
      latestMeaningfulActivity: completed
        ? "Child follow-up submitted a review packet."
        : interrupted
          ? "Child follow-up was interrupted and needs resume."
        : "Child follow-up failed.",
      currentBlocker: completed ? null : message,
    });
    const followUpReport = {
      findings: latestRun.report?.findings ?? [],
      artifacts: latestRun.report?.artifacts ?? [],
      patchRef: latestRun.report?.patchRef ?? null,
      diffRef: latestRun.report?.diffRef ?? null,
      testsRun: latestRun.report?.testsRun ?? [],
      confidence: latestRun.report?.confidence ?? null,
      summary: summary || latestRun.report?.summary || (completed ? "Child conversation completed." : "Subagent follow-up did not complete."),
      blockers: completed
        ? latestRun.report?.blockers ?? []
        : uniqueNonEmptyStrings([...(latestRun.report?.blockers ?? []), message ?? "Subagent follow-up did not complete."]),
      followUpNeeded: !completed,
    };
    const followUpProgress = SubagentProgressSchema.parse({
      ...derivedProgress,
      phase: completed ? "submitted" : interrupted ? latestRun.progress.phase : "report",
      latestMeaningfulActivity: completed
        ? "Child follow-up submitted a review packet."
        : interrupted
          ? "Child follow-up was interrupted and needs resume."
          : "Child follow-up failed.",
      currentBlocker: completed ? derivedProgress.currentBlocker : message,
      updatedAt: submittedAt,
    });
    const packetQuality = completed
      ? subagentReviewPacketQuality({
          run: latestRun,
          finalSummary: summary,
          report: followUpReport,
          progress: followUpProgress,
        })
      : latestRun.review.packetQuality;
    const followUpReviewReport: NonNullable<SubagentRun["report"]> = {
      ...followUpReport,
      confidence: followUpReport.confidence ?? (packetQuality.status === "weak" ? "low" : null),
      followUpNeeded: followUpReport.followUpNeeded || packetQuality.status !== "reviewable",
    };
    const reviewRouting = completed
      ? subagentReviewRoutingRecommendation({
          run: latestRun,
          reviewRoutingPolicy: context.role.reviewRouting,
          packetQuality,
          report: followUpReviewReport,
          progress: followUpProgress,
        })
      : null;
    const packetIncomplete = completed && packetQuality.status === "incomplete";
    const packetBlocker = packetQuality.issues[0] ?? "Child review packet is incomplete.";
    const updated = SubagentRunSchema.parse({
      ...latestRun,
      status: packetIncomplete ? "blocked" : completed ? "submitted_for_review" : interrupted ? "needs_resume" : "failed",
      completedAt: packetIncomplete ? submittedAt : null,
      error: packetIncomplete ? packetBlocker : completed ? null : message,
      report: {
        ...followUpReviewReport,
        blockers: packetIncomplete
          ? uniqueNonEmptyStrings([...(followUpReviewReport.blockers ?? []), ...packetQuality.issues])
          : followUpReviewReport.blockers,
      },
      progress: SubagentProgressSchema.parse({
        ...followUpProgress,
        phase: packetIncomplete ? "report" : followUpProgress.phase,
        latestMeaningfulActivity: packetIncomplete
          ? "Child follow-up finished without a reviewable final report."
          : followUpProgress.latestMeaningfulActivity,
        currentBlocker: packetIncomplete ? packetBlocker : followUpProgress.currentBlocker,
      }),
      review: completed
        ? SubagentReviewStateSchema.parse({
            ...(latestRun.review ?? {}),
            status: packetIncomplete ? "needs_user_input" : "submitted_for_review",
            submittedAt,
            summary: summary || followUpReport.summary,
            issues: packetIncomplete
              ? uniqueNonEmptyStrings([...(latestRun.review?.issues ?? []), ...packetQuality.issues])
              : latestRun.review?.issues ?? [],
            humanReviewRecommended: packetQuality.status !== "reviewable" || Boolean(latestRun.report?.patchRef ?? latestRun.report?.diffRef),
            ...(reviewRouting ?? {}),
            packetQuality,
          })
        : latestRun.review,
      metadata: {
        ...(latestRun.metadata ?? {}),
        usage,
        lastFollowUpTurnId: input.childTurnId,
        lastFollowUpCompletedAt: submittedAt,
        turnBudget: {
          usedTurns: context.priorTurnCount + 1,
          maxTurns: context.maxTurns,
        },
      },
    });
    await deps.upsertRun(updated);
    const parentSession = await getSession(updated.parentSessionId).catch(() => null);
    if (parentSession) {
      await appendSubagentReceipt({
        parentSession,
        parentTurnId: updated.parentTurnId ?? input.childTurnId,
        run: updated,
        eventName: packetIncomplete ? "subagent.blocked" : completed ? "subagent.submitted" : "subagent.failed",
        status: completed && !packetIncomplete ? "pending" : "failed",
        output: packetIncomplete
          ? `${updated.roleId} subagent follow-up submitted an incomplete review packet: ${packetBlocker}`
          : completed
            ? `${updated.roleId} subagent follow-up submitted for review.`
          : `${updated.roleId} subagent follow-up failed: ${message}`,
      });
    }
  }

  function subagentUsageAttribution(run: SubagentRun): UsageRequestAttribution {
    return {
      surface: run.parentGoalId ? "goal" : "chat",
      workflowKind: "subagent",
      goalId: run.parentGoalId,
      subagentRunId: run.id,
      subagentRoleId: run.roleId,
    };
  }

  function subagentUsageTotal(records: ModelUsageRecord[], runIds: ReadonlySet<string>): number {
    if (runIds.size === 0) return 0;
    return sumUsageField(
      records.filter((record) => {
        const runId = record.attribution.subagentRunId;
        return Boolean(runId && runIds.has(runId));
      }),
      "totalTokens",
    );
  }

  function sumUsageField(
    records: ModelUsageRecord[],
    field: "totalTokens" | "promptTokens" | "completionTokens",
  ): number {
    return records.reduce((total, record) => {
      const value = record[field];
      return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
    }, 0);
  }

  function turnPermissionsFromSendTurnInput(input: SendTurnRequest): SubagentTurnPermissions {
    return {
      approvalPolicy: input.approvalPolicy,
      sandbox: input.sandbox,
      codexPermissionMode: input.codexPermissionMode,
      codexReasoningEffort: input.codexReasoningEffort,
    };
  }

  function subagentChildTurnPermissions(
    parent: SubagentTurnPermissions,
    role: SubagentRoleSettings,
  ): SubagentTurnPermissions {
    return {
      ...parent,
      sandbox: clampSandboxToRole(parent.sandbox, role.toolPolicy),
    };
  }

  function clampSandboxToRole(
    parentSandbox: SendTurnRequest["sandbox"],
    toolPolicy: SubagentRoleSettings["toolPolicy"],
  ): SendTurnRequest["sandbox"] {
    const roleSandbox = toolPolicy === "read_only"
      ? "read-only"
      : toolPolicy === "workspace_write"
        ? "workspace-write"
        : "danger-full-access";
    return sandboxRank(parentSandbox) <= sandboxRank(roleSandbox) ? parentSandbox : roleSandbox;
  }

  function sandboxRank(sandbox: SendTurnRequest["sandbox"]): number {
    if (sandbox === "read-only") return 0;
    if (sandbox === "workspace-write") return 1;
    return 2;
  }


  return {
    assertSubagentBudgetAvailable,
    finalizeSubagentContinuationTurn,
    markSubagentContinuationRunning,
    prepareSubagentContinuationTurn,
    refreshSubagentRuntimeDerivedProgress,
    subagentChildTurnPermissions,
    subagentRuntimeDerivedProgress,
    subagentUsageAttribution,
    subagentUsageBudgetForParent,
    subagentUsageTotalsForRun,
    turnPermissionsFromSendTurnInput,
  };
}
