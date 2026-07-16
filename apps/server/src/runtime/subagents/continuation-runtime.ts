import {
  SubagentProgressSchema,
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
import { now } from "../../utils.js";
import {
  recordFromUnknown,
  stringFromRecord,
  truncateForModelAside,
  uniqueNonEmptyStrings,
} from "../turns/value-utils.js";
import {
  SUBAGENT_PROGRESS_PROJECTION_METADATA_KEY,
  subagentProgressProjectionFromRuntimeEvents,
  subagentProgressProjectionStateFromRun,
} from "./progress-reducer.js";

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

type SubagentContinuationTurnContext = {
  run: SubagentRun;
  role: SubagentRoleSettings;
  usageAttribution: UsageRequestAttribution;
  turnPermissions: SubagentTurnPermissions;
  managedBySubagentRunner: boolean;
};

const SUBAGENT_REPORT_SUMMARY_MAX_CHARS = 20_000;

export function createSubagentContinuationRuntime(deps: {
  requireSubagentDeps(): {
    getRun(runId: string): Promise<SubagentRun | null>;
    upsertRun(run: SubagentRun): Promise<unknown>;
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
  latestAssistantTextForSession(sessionId: string): Promise<string | null>;
  loadAppPreferences(): Promise<AppPreferences>;
  getTurn(turnId: string): Promise<Turn | null>;
  getSession(sessionId: string): Promise<Session>;
  appendSubagentReceipt: AppendSubagentReceipt;
}) {
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
      const events = await deps.runtimeEventsForSession(input.childSessionId, {
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
    const runtime = deps.requireSubagentDeps();
    const previousProjection = input.run.metadata?.[SUBAGENT_PROGRESS_PROJECTION_METADATA_KEY];
    const progress = await subagentRuntimeDerivedProgress(input);
    const projection = input.run.metadata?.[SUBAGENT_PROGRESS_PROJECTION_METADATA_KEY];
    if (
      JSON.stringify(progress) === JSON.stringify(input.run.progress) &&
      JSON.stringify(projection) === JSON.stringify(previousProjection)
    ) return input.run;
    const updated = SubagentRunSchema.parse({ ...input.run, progress, metadata: input.run.metadata });
    await runtime.upsertRun(updated);
    return updated;
  }

  async function subagentUsageTotalsForRun(runId: string): Promise<{
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    requestCount: number;
  }> {
    const records = await deps.requireSubagentDeps().listUsageRecords({ status: "completed" });
    const matching = records.filter((record) => record.attribution.subagentRunId === runId);
    return {
      totalTokens: sumUsageField(matching, "totalTokens"),
      promptTokens: sumUsageField(matching, "promptTokens"),
      completionTokens: sumUsageField(matching, "completionTokens"),
      requestCount: matching.length,
    };
  }

  async function prepareSubagentContinuationTurn(input: {
    session: Session;
    request: SendTurnRequest;
    requestedTurnPermissions: SubagentTurnPermissions;
  }): Promise<SubagentContinuationTurnContext | null> {
    if (!input.session.subagentRunId) return null;
    const runtime = deps.requireSubagentDeps();
    const run = await runtime.getRun(input.session.subagentRunId);
    if (!run) throw new Error(`Subagent run ${input.session.subagentRunId} was not found.`);
    if (run.childSessionId && run.childSessionId !== input.session.id) {
      throw new Error(`Subagent run ${run.id} is linked to a different child conversation.`);
    }
    const preferences = await deps.loadAppPreferences();
    const role = preferences.subagents.roles.find((candidate) => candidate.id === run.roleId);
    if (!role?.enabled) throw new Error(`Subagent role ${run.roleId} is not enabled.`);
    const metadata = recordFromUnknown(input.request.metadata);
    return {
      run,
      role,
      usageAttribution: input.request.usageAttribution ?? subagentUsageAttribution(run),
      turnPermissions: subagentTurnPermissionsFromRun(run) ??
        subagentChildTurnPermissions(input.requestedTurnPermissions, role),
      managedBySubagentRunner: stringFromRecord(metadata ?? {}, "subagentRunId") === run.id,
    };
  }

  async function markSubagentContinuationRunning(input: {
    context: SubagentContinuationTurnContext | null;
    childTurnId: string;
  }): Promise<void> {
    if (!input.context || input.context.managedBySubagentRunner) return;
    const run = input.context.run;
    if (run.status === "queued" || run.status === "running") return;
    const updated = SubagentRunSchema.parse({
      ...run,
      status: "running",
      startedAt: run.startedAt ?? now(),
      completedAt: null,
      error: null,
      progress: {
        ...run.progress,
        phase: "orient",
        latestMeaningfulActivity: "Child follow-up turn started.",
        currentBlocker: null,
        updatedAt: now(),
      },
      metadata: { ...(run.metadata ?? {}), lastFollowUpTurnId: input.childTurnId },
    });
    await deps.requireSubagentDeps().upsertRun(updated);
    input.context.run = updated;
    const parentSession = await deps.getSession(run.parentSessionId).catch(() => null);
    if (parentSession) {
      await deps.appendSubagentReceipt({
        parentSession,
        parentTurnId: run.parentTurnId ?? input.childTurnId,
        run: updated,
        eventName: "subagent.started",
        status: "started",
        output: `${run.roleId} child follow-up is running.`,
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
    const turn = await deps.getTurn(input.childTurnId);
    if (!turn || turn.status === "in_progress") return;
    const runtime = deps.requireSubagentDeps();
    const run = await runtime.getRun(context.run.id);
    if (!run) return;
    const completed = turn.status === "completed";
    const interrupted = turn.status === "interrupted";
    const error = completed ? null : turn.error || (interrupted ? "Child follow-up was interrupted." : "Child follow-up failed.");
    const summary = await deps.latestAssistantTextForSession(input.childSession.id);
    const progress = await subagentRuntimeDerivedProgress({
      run,
      childSessionId: input.childSession.id,
      phase: completed ? "report" : null,
      latestMeaningfulActivity: completed
        ? "Child follow-up completed."
        : interrupted
          ? "Child follow-up was interrupted."
          : "Child follow-up failed.",
      currentBlocker: error,
    });
    const updated = SubagentRunSchema.parse({
      ...run,
      status: completed ? "completed" : interrupted ? "needs_resume" : "failed",
      completedAt: completed || !interrupted ? now() : null,
      error,
      report: {
        findings: run.report?.findings ?? [],
        artifacts: run.report?.artifacts ?? [],
        patchRef: run.report?.patchRef ?? null,
        diffRef: run.report?.diffRef ?? null,
        testsRun: run.report?.testsRun ?? [],
        confidence: run.report?.confidence ?? null,
        summary: truncateForModelAside(
          summary || run.report?.summary || (completed ? "Child conversation completed." : "Child follow-up did not complete."),
          SUBAGENT_REPORT_SUMMARY_MAX_CHARS,
        ),
        blockers: completed
          ? run.report?.blockers ?? []
          : uniqueNonEmptyStrings([...(run.report?.blockers ?? []), error ?? "Child follow-up did not complete."]),
        followUpNeeded: !completed,
      },
      progress: SubagentProgressSchema.parse({ ...progress, phase: "report", updatedAt: now() }),
      metadata: {
        ...(run.metadata ?? {}),
        usage: await subagentUsageTotalsForRun(run.id),
        lastFollowUpTurnId: input.childTurnId,
        lastFollowUpCompletedAt: now(),
      },
    });
    await runtime.upsertRun(updated);
    const parentSession = await deps.getSession(updated.parentSessionId).catch(() => null);
    if (parentSession) {
      await deps.appendSubagentReceipt({
        parentSession,
        parentTurnId: updated.parentTurnId ?? input.childTurnId,
        run: updated,
        eventName: completed ? "subagent.completed" : "subagent.failed",
        status: completed ? "completed" : "failed",
        output: completed
          ? `${updated.roleId} child follow-up completed.`
          : `${updated.roleId} child follow-up failed: ${error}`,
      });
    }
  }

  function subagentTurnPermissionsFromRun(run: SubagentRun): SubagentTurnPermissions | null {
    const permissions = recordFromUnknown(run.metadata?.childTurnPermissions);
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

  function subagentUsageAttribution(run: SubagentRun): UsageRequestAttribution {
    return {
      surface: run.parentGoalId ? "goal" : "chat",
      workflowKind: "subagent",
      goalId: run.parentGoalId,
      subagentRunId: run.id,
      subagentRoleId: run.roleId,
    };
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
    return { ...parent, sandbox: clampSandboxToRole(parent.sandbox, role.toolPolicy) };
  }

  return {
    finalizeSubagentContinuationTurn,
    markSubagentContinuationRunning,
    prepareSubagentContinuationTurn,
    refreshSubagentRuntimeDerivedProgress,
    subagentChildTurnPermissions,
    subagentRuntimeDerivedProgress,
    subagentUsageAttribution,
    subagentUsageTotalsForRun,
    turnPermissionsFromSendTurnInput,
  };
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
