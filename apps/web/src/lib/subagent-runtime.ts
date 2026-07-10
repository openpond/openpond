import {
  SubagentMessageSchema,
  SubagentRunSchema,
  type RuntimeEvent,
  type SubagentMessage,
  type SubagentRef,
  type SubagentRun,
} from "@openpond/contracts";

export type SubagentUsageSummary = {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
};

export type SubagentBlockerSummary = {
  runId: string;
  roleId: string;
  status: SubagentRun["status"];
  message: string;
};

export type SubagentEvidenceSummary = SubagentRef & {
  runId: string;
  roleId: string;
};

export type SubagentImportantMessageSummary = {
  id: string;
  runId: string;
  fromRunId: string;
  kind: SubagentMessage["kind"];
  body: string;
  createdAt: string;
};

export type SubagentWorkspaceRetentionSummary = {
  status: "retained";
  reason: string | null;
  retainedAt: string | null;
  expiresAt: string | null;
  retentionDays: number | null;
  trigger: string | null;
  cleanupAfterExpiry: boolean;
};

export type SubagentFinalResultSummary = {
  runId: string;
  roleId: string;
  status: SubagentRun["status"];
  required: boolean;
  objective: string;
  summary: string;
  findings: string[];
  changedFiles: string[];
  refs: SubagentRef[];
  testsRun: string[];
  validationAttempts: string[];
  blockers: string[];
  confidence: string | null;
  packetQualityStatus: SubagentRun["review"]["packetQuality"]["status"];
  packetQualityEvidence: SubagentRun["review"]["packetQuality"]["evidence"];
  independentReviewRecommended: boolean;
  reviewerRoutingReasons: SubagentRun["review"]["reviewerRoutingReasons"];
  reviewerRoutingEvidence: SubagentRun["review"]["reviewerRoutingEvidence"];
  importantMessages: SubagentImportantMessageSummary[];
  workspaceRetention: SubagentWorkspaceRetentionSummary | null;
  updatedAt: string;
};

export type SubagentLatestUpdateSummary = {
  runId: string;
  roleId: string;
  status: SubagentRun["status"];
  message: string;
  updatedAt: string;
};

export type SubagentWatcherRuntimeStatus = {
  checkedAt: string;
  activeCount: number;
  staleCount: number;
  wakeQueued: boolean;
  wakePolicy: string | null;
};

export type SubagentTaskGraphNode = {
  runId: string;
  roleId: string;
  status: SubagentRun["status"];
  objective: string;
  required: boolean;
  childSessionId: string | null;
  modelLabel: string;
  isolationLabel: string;
  summary: string | null;
  blockerCount: number;
  evidenceCount: number;
  testsRunCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type SubagentTaskGraphEdge = {
  id: string;
  fromRunId: string;
  toRunId: string;
  kind: "started" | SubagentMessage["kind"];
  label: string;
  createdAt: string | null;
};

export type SubagentTaskGraph = {
  rootId: string;
  nodes: SubagentTaskGraphNode[];
  edges: SubagentTaskGraphEdge[];
};

export type SubagentRuntimeStatus = {
  sessionId: string;
  runs: SubagentRun[];
  activeRuns: SubagentRun[];
  submittedRuns: SubagentRun[];
  needsRevisionRuns: SubagentRun[];
  needsUserInputRuns: SubagentRun[];
  acceptedRuns: SubagentRun[];
  failedWithArtifactsRuns: SubagentRun[];
  blockedRuns: SubagentRun[];
  completedRuns: SubagentRun[];
  unresolvedRuns: SubagentRun[];
  terminalRuns: SubagentRun[];
  archivedRuns: SubagentRun[];
  latestRun: SubagentRun | null;
  latestMeaningfulUpdate: SubagentLatestUpdateSummary | null;
  watcher: SubagentWatcherRuntimeStatus | null;
  activeCount: number;
  submittedCount: number;
  needsRevisionCount: number;
  needsUserInputCount: number;
  acceptedCount: number;
  failedWithArtifactsCount: number;
  blockedCount: number;
  completedCount: number;
  unresolvedCount: number;
  terminalCount: number;
  archivedCount: number;
  requiredActiveCount: number;
  requiredSubmittedForReviewCount: number;
  requiredNeedsRevisionCount: number;
  requiredNeedsUserInputCount: number;
  requiredBlockingCount: number;
  requiredAcceptedCount: number;
  requiredTerminalCount: number;
  requiredArchivedCount: number;
  requiredUnresolvedCount: number;
  requiredOpenCount: number;
  usage: SubagentUsageSummary;
  blockers: SubagentBlockerSummary[];
  evidenceRefs: SubagentEvidenceSummary[];
  finalResults: SubagentFinalResultSummary[];
  testsRunCount: number;
  taskGraph: SubagentTaskGraph;
  label: string;
  tooltip: string;
};

const ACTIVE_SUBAGENT_STATUSES = new Set<SubagentRun["status"]>(["queued", "running", "needs_resume"]);
const SUBMITTED_SUBAGENT_STATUSES = new Set<SubagentRun["status"]>(["submitted_for_review"]);
const NEEDS_REVISION_SUBAGENT_STATUSES = new Set<SubagentRun["status"]>(["needs_revision"]);
const NEEDS_USER_INPUT_SUBAGENT_STATUSES = new Set<SubagentRun["status"]>(["needs_user_input"]);
const ACCEPTED_SUBAGENT_STATUSES = new Set<SubagentRun["status"]>(["accepted", "completed"]);
const FAILED_WITH_ARTIFACTS_SUBAGENT_STATUSES = new Set<SubagentRun["status"]>(["failed_with_artifacts"]);
const BLOCKED_SUBAGENT_STATUSES = new Set<SubagentRun["status"]>(["blocked"]);
const TERMINAL_SUBAGENT_STATUSES = new Set<SubagentRun["status"]>([
  "accepted",
  "completed",
  "failed_with_artifacts",
  "failed",
  "cancelled",
  "superseded",
]);

export function latestSubagentRuntimeFromEvents(
  events: readonly RuntimeEvent[],
  sessionId: string | null,
): SubagentRuntimeStatus | null {
  if (!sessionId) return null;
  const runById = new Map<string, SubagentRun>();
  const deliveredMessages: DeliveredSubagentMessage[] = [];
  for (const item of events) {
    if (!item.name.startsWith("subagent.")) continue;
    const deliveredMessage = deliveredSubagentMessageFromEvent(item);
    if (deliveredMessage) deliveredMessages.push(deliveredMessage);
    const run = subagentRunFromEvent(item);
    if (!run || run.parentSessionId !== sessionId) continue;
    runById.set(run.id, run);
  }
  if (runById.size === 0) return null;
  const runs = [...runById.values()].sort(compareSubagentRuns);
  const activeRuns = runs.filter((run) => ACTIVE_SUBAGENT_STATUSES.has(run.status));
  const submittedRuns = runs.filter((run) => SUBMITTED_SUBAGENT_STATUSES.has(run.status));
  const needsRevisionRuns = runs.filter((run) => NEEDS_REVISION_SUBAGENT_STATUSES.has(run.status));
  const needsUserInputRuns = runs.filter((run) => NEEDS_USER_INPUT_SUBAGENT_STATUSES.has(run.status));
  const acceptedRuns = runs.filter(subagentRunAccepted);
  const failedWithArtifactsRuns = runs.filter((run) => FAILED_WITH_ARTIFACTS_SUBAGENT_STATUSES.has(run.status));
  const blockedRuns = runs.filter((run) => BLOCKED_SUBAGENT_STATUSES.has(run.status) && !subagentRunResolved(run));
  const completedRuns = runs.filter((run) => ACCEPTED_SUBAGENT_STATUSES.has(run.status) || run.review?.status === "accepted");
  const terminalRuns = runs.filter(subagentRunTerminal);
  const unresolvedRuns = runs.filter((run) => !subagentRunResolved(run));
  const archivedRuns = runs.filter(subagentRunArchived);
  const requiredRuns = runs.filter((run) => run.required);
  const requiredActiveCount = requiredRuns.filter((run) => ACTIVE_SUBAGENT_STATUSES.has(run.status)).length;
  const requiredSubmittedForReviewCount = requiredRuns.filter((run) => SUBMITTED_SUBAGENT_STATUSES.has(run.status)).length;
  const requiredNeedsRevisionCount = requiredRuns.filter((run) => NEEDS_REVISION_SUBAGENT_STATUSES.has(run.status)).length;
  const requiredNeedsUserInputCount = requiredRuns.filter((run) => NEEDS_USER_INPUT_SUBAGENT_STATUSES.has(run.status)).length;
  const requiredBlockingCount = requiredRuns.filter((run) => BLOCKED_SUBAGENT_STATUSES.has(run.status) && !subagentRunDismissed(run)).length;
  const requiredAcceptedCount = requiredRuns.filter(subagentRunAccepted).length;
  const requiredTerminalCount = requiredRuns.filter(subagentRunTerminal).length;
  const requiredArchivedCount = requiredRuns.filter(subagentRunArchived).length;
  const requiredUnresolvedCount = requiredRuns.filter((run) => !subagentRunResolved(run)).length;
  const requiredOpenCount = requiredUnresolvedCount;
  const latestRun = runs[0] ?? null;
  const latestMeaningfulUpdate = subagentLatestMeaningfulUpdate(runs);
  const watcher = subagentWatcherRuntimeStatus(events);
  return {
    sessionId,
    runs,
    activeRuns,
    submittedRuns,
    needsRevisionRuns,
    needsUserInputRuns,
    acceptedRuns,
    failedWithArtifactsRuns,
    blockedRuns,
    completedRuns,
    unresolvedRuns,
    terminalRuns,
    archivedRuns,
    latestRun,
    latestMeaningfulUpdate,
    watcher,
    activeCount: activeRuns.length,
    submittedCount: submittedRuns.length,
    needsRevisionCount: needsRevisionRuns.length,
    needsUserInputCount: needsUserInputRuns.length,
    acceptedCount: acceptedRuns.length,
    failedWithArtifactsCount: failedWithArtifactsRuns.length,
    blockedCount: blockedRuns.length,
    completedCount: completedRuns.length,
    unresolvedCount: unresolvedRuns.length,
    terminalCount: terminalRuns.length,
    archivedCount: archivedRuns.length,
    requiredActiveCount,
    requiredSubmittedForReviewCount,
    requiredNeedsRevisionCount,
    requiredNeedsUserInputCount,
    requiredBlockingCount,
    requiredAcceptedCount,
    requiredTerminalCount,
    requiredArchivedCount,
    requiredUnresolvedCount,
    requiredOpenCount,
    usage: subagentUsageSummary(runs),
    blockers: subagentBlockers(runs),
    evidenceRefs: subagentEvidenceRefs(runs),
    finalResults: subagentFinalResults(runs, deliveredMessages),
    testsRunCount: runs.reduce((total, run) => total + (run.report?.testsRun.length ?? 0), 0),
    taskGraph: subagentTaskGraph(sessionId, runs, deliveredMessages),
    label: subagentRuntimeLabel(activeRuns, submittedRuns, needsRevisionRuns, blockedRuns, completedRuns, terminalRuns),
    tooltip: subagentRuntimeTooltip(activeRuns, submittedRuns, needsRevisionRuns, blockedRuns, completedRuns, terminalRuns),
  };
}

type DeliveredSubagentMessage = {
  message: SubagentMessage;
  deliveredRunIds: string[];
};

function subagentRunFromEvent(event: RuntimeEvent): SubagentRun | null {
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const run = (data as Record<string, unknown>).run;
  const parsed = SubagentRunSchema.safeParse(run);
  return parsed.success ? parsed.data : null;
}

function deliveredSubagentMessageFromEvent(event: RuntimeEvent): DeliveredSubagentMessage | null {
  if (event.name !== "subagent.message") return null;
  const data = asRecord(event.data);
  const parsed = SubagentMessageSchema.safeParse(data?.message);
  if (!parsed.success) return null;
  const deliveredRunIds = stringArrayValue(data?.deliveredRunIds);
  const deliveredToRunId = typeof data?.deliveredToRunId === "string" ? data.deliveredToRunId : null;
  return {
    message: parsed.data,
    deliveredRunIds: deliveredRunIds.length > 0 ? deliveredRunIds : deliveredToRunId ? [deliveredToRunId] : [],
  };
}

function compareSubagentRuns(left: SubagentRun, right: SubagentRun): number {
  return subagentRunTime(right) - subagentRunTime(left);
}

function subagentRunTime(run: SubagentRun): number {
  return Date.parse(run.updatedAt ?? run.completedAt ?? run.startedAt ?? run.createdAt) || 0;
}

function subagentRuntimeLabel(
  activeRuns: SubagentRun[],
  submittedRuns: SubagentRun[],
  needsRevisionRuns: SubagentRun[],
  blockedRuns: SubagentRun[],
  completedRuns: SubagentRun[],
  terminalRuns: SubagentRun[],
): string {
  if (activeRuns.length > 0) return `${activeRuns.length} ${plural(activeRuns.length, "subagent")} running`;
  if (needsRevisionRuns.length > 0) return `${needsRevisionRuns.length} ${plural(needsRevisionRuns.length, "subagent")} needs revision`;
  if (submittedRuns.length > 0) return `${submittedRuns.length} ${plural(submittedRuns.length, "subagent")} submitted`;
  if (blockedRuns.length > 0) return `${blockedRuns.length} ${plural(blockedRuns.length, "subagent")} blocked`;
  const failedRuns = terminalRuns.filter((run) => run.status === "failed" || run.status === "failed_with_artifacts");
  if (failedRuns.length > 0) return `${failedRuns.length} ${plural(failedRuns.length, "subagent")} failed`;
  const cancelledRuns = terminalRuns.filter((run) => run.status === "cancelled");
  if (cancelledRuns.length > 0) return `${cancelledRuns.length} ${plural(cancelledRuns.length, "subagent")} cancelled`;
  if (completedRuns.length === 0 && terminalRuns.length > 0) return `${terminalRuns.length} ${plural(terminalRuns.length, "subagent")} terminal`;
  return `${completedRuns.length} ${plural(completedRuns.length, "subagent")} accepted`;
}

function subagentRuntimeTooltip(
  activeRuns: SubagentRun[],
  submittedRuns: SubagentRun[],
  needsRevisionRuns: SubagentRun[],
  blockedRuns: SubagentRun[],
  completedRuns: SubagentRun[],
  terminalRuns: SubagentRun[],
): string {
  const primary = activeRuns.length > 0
    ? activeRuns
    : needsRevisionRuns.length > 0
      ? needsRevisionRuns
      : submittedRuns.length > 0
        ? submittedRuns
        : blockedRuns.length > 0
          ? blockedRuns
          : completedRuns.length > 0
            ? completedRuns
            : terminalRuns;
  const details = primary.slice(0, 4).map((run) => `${subagentRoleLabel(run.roleId)} ${run.status}`);
  const hidden = primary.length - details.length;
  return `Subagents: ${details.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}`;
}

function subagentRunAccepted(run: SubagentRun): boolean {
  if (run.status === "superseded") return false;
  return ACCEPTED_SUBAGENT_STATUSES.has(run.status) || run.review?.status === "accepted";
}

function subagentRunResolved(run: SubagentRun): boolean {
  return subagentRunAccepted(run) ||
    subagentRunDismissed(run) ||
    run.status === "superseded" ||
    subagentRunCancelledByParentGoal(run) ||
    (!run.required && subagentRunTerminal(run));
}

function subagentRunCancelledByParentGoal(run: SubagentRun): boolean {
  if (run.status !== "cancelled") return false;
  const lifecycle = asRecord(run.metadata.goalLifecycle);
  return stringValue(lifecycle?.action) === "cancelled_by_parent_goal";
}

function subagentRunTerminal(run: SubagentRun): boolean {
  return TERMINAL_SUBAGENT_STATUSES.has(run.status) || run.review?.status === "accepted" || subagentRunDismissed(run);
}

function subagentRunDismissed(run: SubagentRun): boolean {
  return run.review?.status === "dismissed";
}

function subagentRunArchived(run: SubagentRun): boolean {
  const archive = asRecord(run.metadata.childSessionArchive);
  const status = stringValue(archive?.status);
  return status === "archived" || status === "already_archived";
}

function subagentUsageSummary(runs: SubagentRun[]): SubagentUsageSummary {
  return runs.reduce<SubagentUsageSummary>(
    (summary, run) => {
      const usage = usageFromRun(run);
      summary.totalTokens += usage.totalTokens;
      summary.promptTokens += usage.promptTokens;
      summary.completionTokens += usage.completionTokens;
      summary.requestCount += usage.requestCount;
      return summary;
    },
    { totalTokens: 0, promptTokens: 0, completionTokens: 0, requestCount: 0 },
  );
}

function usageFromRun(run: SubagentRun): SubagentUsageSummary {
  const usage = asRecord(run.metadata.usage);
  return {
    totalTokens: numberValue(usage?.totalTokens),
    promptTokens: numberValue(usage?.promptTokens),
    completionTokens: numberValue(usage?.completionTokens),
    requestCount: numberValue(usage?.requestCount),
  };
}

function subagentLatestMeaningfulUpdate(runs: SubagentRun[]): SubagentLatestUpdateSummary | null {
  for (const run of runs) {
    const message =
      run.progress?.latestMeaningfulActivity ||
      run.report?.summary ||
      run.progress?.currentBlocker ||
      run.error ||
      null;
    const updatedAt = run.progress?.updatedAt ?? run.updatedAt ?? run.completedAt ?? run.startedAt ?? run.createdAt;
    if (!message || !updatedAt) continue;
    return {
      runId: run.id,
      roleId: run.roleId,
      status: run.status,
      message,
      updatedAt,
    };
  }
  return null;
}

function subagentWatcherRuntimeStatus(events: readonly RuntimeEvent[]): SubagentWatcherRuntimeStatus | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]!;
    if (item.name !== "diagnostic") continue;
    const data = asRecord(item.data);
    if (data?.kind !== "subagent_lifecycle_watcher_tick") continue;
    const checkedAt = stringValue(data.checkedAt) ?? item.timestamp;
    if (!checkedAt) continue;
    return {
      checkedAt,
      activeCount: numberValue(data.activeCount),
      staleCount: numberValue(data.staleCount),
      wakeQueued: data.wakeQueued === true,
      wakePolicy: stringValue(data.wakePolicy),
    };
  }
  return null;
}

function subagentBlockers(runs: SubagentRun[]): SubagentBlockerSummary[] {
  const blockers: SubagentBlockerSummary[] = [];
  for (const run of runs) {
    const messages = uniqueStrings([
      ...(run.report?.blockers ?? []),
      run.error,
      BLOCKED_SUBAGENT_STATUSES.has(run.status) && run.report?.summary ? run.report.summary : null,
    ]);
    for (const message of messages) {
      blockers.push({
        runId: run.id,
        roleId: run.roleId,
        status: run.status,
        message,
      });
    }
  }
  return blockers;
}

function subagentEvidenceRefs(runs: SubagentRun[]): SubagentEvidenceSummary[] {
  const refs: SubagentEvidenceSummary[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    for (const ref of [
      ...(run.report?.artifacts ?? []),
      run.report?.patchRef ?? null,
      run.report?.diffRef ?? null,
    ]) {
      if (!ref) continue;
      const key = `${run.id}:${ref.kind}:${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        ...ref,
        runId: run.id,
        roleId: run.roleId,
      });
    }
  }
  return refs;
}

function subagentFinalResults(
  runs: SubagentRun[],
  deliveredMessages: DeliveredSubagentMessage[],
): SubagentFinalResultSummary[] {
  const messagesByRunId = subagentImportantMessagesByRunId(deliveredMessages);
  const results: SubagentFinalResultSummary[] = [];
  for (const run of runs) {
    if (!subagentRunHasFinalResult(run)) continue;
    const packetQualityEvidence = normalizedSubagentPacketQualityEvidence(run.review.packetQuality.evidence);
    const reviewerRoutingEvidence = normalizedSubagentReviewRoutingEvidence(run.review.reviewerRoutingEvidence);
    const summary =
      run.report?.summary ||
      run.review.summary ||
      run.progress.latestMeaningfulActivity ||
      run.error ||
      "No summary";
    results.push({
      runId: run.id,
      roleId: run.roleId,
      status: run.status,
      required: run.required,
      objective: run.objective,
      summary,
      findings: uniqueStrings(run.report?.findings ?? []).slice(0, 8),
      changedFiles: uniqueStrings(run.progress.changedFiles).slice(0, 12),
      refs: uniqueSubagentRefs([
        ...(run.report?.artifacts ?? []),
        run.report?.patchRef ?? null,
        run.report?.diffRef ?? null,
        ...run.progress.patchRefs,
      ]).slice(0, 10),
      testsRun: uniqueStrings(run.report?.testsRun ?? []).slice(0, 8),
      validationAttempts: run.progress.validationAttempts.map(subagentValidationAttemptLabel).slice(0, 8),
      blockers: uniqueStrings([
        ...(run.report?.blockers ?? []),
        ...run.review.issues,
        ...run.review.requiredCorrections,
        ...run.review.packetQuality.issues,
        ...run.review.packetQuality.warnings,
        run.progress.currentBlocker,
        run.error,
      ]).slice(0, 8),
      confidence: run.report?.confidence ?? null,
      packetQualityStatus: run.review.packetQuality.status,
      packetQualityEvidence,
      independentReviewRecommended: Boolean(run.review.independentReviewRecommended),
      reviewerRoutingReasons: Array.from(new Set(run.review.reviewerRoutingReasons ?? [])).slice(0, 8),
      reviewerRoutingEvidence,
      importantMessages: messagesByRunId.get(run.id)?.slice(0, 4) ?? [],
      workspaceRetention: subagentWorkspaceRetention(run),
      updatedAt: run.progress.updatedAt ?? run.updatedAt ?? run.completedAt ?? run.startedAt ?? run.createdAt,
    });
  }
  return results;
}

function subagentWorkspaceRetention(run: SubagentRun): SubagentWorkspaceRetentionSummary | null {
  const metadata = asRecord(run.metadata);
  const lifecycleCleanup = asRecord(metadata?.lifecycleCleanup);
  const cleanupRetention = asRecord(lifecycleCleanup?.workspaceCleanup);
  const workspaceHandoff = asRecord(metadata?.workspaceHandoff);
  const applyResult = asRecord(workspaceHandoff?.applyResult);
  const patchRetention = asRecord(applyResult?.workspaceRetention);
  return subagentWorkspaceRetentionFromRecord(patchRetention) ?? subagentWorkspaceRetentionFromRecord(cleanupRetention);
}

function subagentWorkspaceRetentionFromRecord(record: Record<string, unknown> | null): SubagentWorkspaceRetentionSummary | null {
  if (!record || stringValue(record.status) !== "retained") return null;
  const policy = asRecord(record.retentionPolicy);
  return {
    status: "retained",
    reason: stringValue(record.reason),
    retainedAt: stringValue(record.retainedAt),
    expiresAt: stringValue(policy?.expiresAt),
    retentionDays: nullableNumberValue(policy?.retentionDays),
    trigger: stringValue(policy?.trigger),
    cleanupAfterExpiry: policy?.cleanupAfterExpiry === true,
  };
}

function subagentRunHasFinalResult(run: SubagentRun): boolean {
  if (run.report) return true;
  if (run.review.status !== "pending") return true;
  return subagentRunTerminal(run);
}

function uniqueSubagentRefs(values: Array<SubagentRef | null | undefined>): SubagentRef[] {
  const seen = new Set<string>();
  const refs: SubagentRef[] = [];
  for (const ref of values) {
    if (!ref) continue;
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function subagentValidationAttemptLabel(attempt: SubagentRun["progress"]["validationAttempts"][number]): string {
  const exit = attempt.exitCode === null ? "" : ` exit ${attempt.exitCode}`;
  const output = attempt.outputSummary ? ` · ${attempt.outputSummary}` : "";
  return `${attempt.command} · ${attempt.status}${exit}${output}`;
}

function normalizedSubagentPacketQualityEvidence(
  evidence: SubagentRun["review"]["packetQuality"]["evidence"] | undefined,
): SubagentRun["review"]["packetQuality"]["evidence"] {
  return {
    finalSummaryPresent: evidence?.finalSummaryPresent ?? false,
    finalSummaryLength: evidence?.finalSummaryLength ?? 0,
    requestedValidationCommandCount: evidence?.requestedValidationCommandCount ?? 0,
    validationAttemptCount: evidence?.validationAttemptCount ?? 0,
    failedValidationCount: evidence?.failedValidationCount ?? 0,
    testsRunCount: evidence?.testsRunCount ?? 0,
    changedFileCount: evidence?.changedFileCount ?? 0,
    patchRefPresent: evidence?.patchRefPresent ?? false,
    diffRefPresent: evidence?.diffRefPresent ?? false,
    artifactCount: evidence?.artifactCount ?? 0,
    findingCount: evidence?.findingCount ?? 0,
    blockerCount: evidence?.blockerCount ?? 0,
    unvalidatedWorkspaceChanges: evidence?.unvalidatedWorkspaceChanges ?? false,
  };
}

function normalizedSubagentReviewRoutingEvidence(
  evidence: SubagentRun["review"]["reviewerRoutingEvidence"] | undefined,
): SubagentRun["review"]["reviewerRoutingEvidence"] {
  return {
    packetQualityStatus: evidence?.packetQualityStatus ?? "reviewable",
    confidence: evidence?.confidence ?? null,
    changedFileCount: evidence?.changedFileCount ?? 0,
    highRiskFileCount: evidence?.highRiskFileCount ?? 0,
    validationAttemptCount: evidence?.validationAttemptCount ?? 0,
    failedValidationCount: evidence?.failedValidationCount ?? 0,
    missingRequestedValidation: evidence?.missingRequestedValidation ?? false,
    providerFailureAfterChanges: evidence?.providerFailureAfterChanges ?? false,
    userRequestedIndependentReview: evidence?.userRequestedIndependentReview ?? false,
  };
}

function subagentImportantMessagesByRunId(
  deliveredMessages: DeliveredSubagentMessage[],
): Map<string, SubagentImportantMessageSummary[]> {
  const byRunId = new Map<string, SubagentImportantMessageSummary[]>();
  for (const delivery of deliveredMessages) {
    if (!subagentMessageImportantForFinalResult(delivery.message)) continue;
    const relatedRunIds = uniqueStrings([
      delivery.message.fromRunId,
      delivery.message.toRunId,
      ...delivery.deliveredRunIds,
    ]);
    for (const runId of relatedRunIds) {
      const bucket = byRunId.get(runId) ?? [];
      bucket.push({
        id: delivery.message.id,
        runId,
        fromRunId: delivery.message.fromRunId,
        kind: delivery.message.kind,
        body: delivery.message.body,
        createdAt: delivery.message.createdAt,
      });
      byRunId.set(runId, bucket);
    }
  }
  return byRunId;
}

function subagentMessageImportantForFinalResult(message: SubagentMessage): boolean {
  if (message.kind !== "status") return true;
  return message.priority === "interrupt" || message.refs.length > 0;
}

function subagentTaskGraph(
  sessionId: string,
  runs: SubagentRun[],
  deliveredMessages: DeliveredSubagentMessage[],
): SubagentTaskGraph {
  const rootId = `parent:${sessionId}`;
  const orderedRuns = [...runs].sort((left, right) => subagentRunTime(left) - subagentRunTime(right));
  const runIds = new Set(orderedRuns.map((run) => run.id));
  const nodes = orderedRuns.map(subagentTaskGraphNode);
  const edges: SubagentTaskGraphEdge[] = orderedRuns.map((run) => ({
    id: `start:${run.id}`,
    fromRunId: rootId,
    toRunId: run.id,
    kind: "started",
    label: "Started",
    createdAt: run.createdAt,
  }));
  const seenEdges = new Set(edges.map((edge) => edge.id));
  for (const delivery of deliveredMessages) {
    const recipients = delivery.deliveredRunIds.length > 0
      ? delivery.deliveredRunIds
      : delivery.message.toRunId
        ? [delivery.message.toRunId]
        : [];
    for (const toRunId of recipients) {
      if (!runIds.has(toRunId)) continue;
      const edgeId = `message:${delivery.message.id}:${delivery.message.fromRunId}:${toRunId}`;
      if (seenEdges.has(edgeId)) continue;
      seenEdges.add(edgeId);
      edges.push({
        id: edgeId,
        fromRunId: delivery.message.fromRunId,
        toRunId,
        kind: delivery.message.kind,
        label: subagentMessageKindLabel(delivery.message.kind),
        createdAt: delivery.message.createdAt,
      });
    }
  }
  return { rootId, nodes, edges };
}

function subagentTaskGraphNode(run: SubagentRun): SubagentTaskGraphNode {
  const evidenceCount =
    (run.report?.artifacts.length ?? 0) +
    (run.report?.patchRef ? 1 : 0) +
    (run.report?.diffRef ? 1 : 0);
  return {
    runId: run.id,
    roleId: run.roleId,
    status: run.status,
    objective: run.objective,
    required: run.required,
    childSessionId: run.childSessionId,
    modelLabel: run.modelRef ? `${run.modelRef.providerId}/${run.modelRef.modelId}` : "default model",
    isolationLabel: `${compactLabel(run.isolationMode)} · ${compactLabel(run.toolPolicy)}`,
    summary: run.report?.summary || null,
    blockerCount: (run.report?.blockers.length ?? 0) + (run.error ? 1 : 0),
    evidenceCount,
    testsRunCount: run.report?.testsRun.length ?? 0,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

function subagentMessageKindLabel(kind: SubagentMessage["kind"]): string {
  return kind.slice(0, 1).toUpperCase() + kind.slice(1).replace(/[-_]+/g, " ");
}

function subagentRoleLabel(roleId: string): string {
  return roleId.slice(0, 1).toUpperCase() + roleId.slice(1).replace(/[-_]+/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return parsed;
}

function nullableNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function uniqueStrings(values: Array<string | null | undefined | false>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function compactLabel(value: string): string {
  return value.replace(/[-_]+/g, " ");
}
