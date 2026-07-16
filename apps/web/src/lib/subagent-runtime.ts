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

export type SubagentEvidenceSummary = SubagentRef & { runId: string; roleId: string };

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
  objective: string;
  summary: string;
  findings: string[];
  changedFiles: string[];
  refs: SubagentRef[];
  testsRun: string[];
  validationAttempts: string[];
  blockers: string[];
  confidence: string | null;
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

export type SubagentRuntimeStatus = {
  sessionId: string;
  runs: SubagentRun[];
  activeRuns: SubagentRun[];
  completedRuns: SubagentRun[];
  failedRuns: SubagentRun[];
  cancelledRuns: SubagentRun[];
  needsResumeRuns: SubagentRun[];
  terminalRuns: SubagentRun[];
  latestRun: SubagentRun | null;
  latestMeaningfulUpdate: SubagentLatestUpdateSummary | null;
  activeCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  needsResumeCount: number;
  terminalCount: number;
  usage: SubagentUsageSummary;
  blockers: SubagentBlockerSummary[];
  evidenceRefs: SubagentEvidenceSummary[];
  finalResults: SubagentFinalResultSummary[];
  testsRunCount: number;
  label: string;
  tooltip: string;
};

export function latestSubagentRuntimeFromEvents(
  events: readonly RuntimeEvent[],
  sessionId: string | null,
): SubagentRuntimeStatus | null {
  if (!sessionId) return null;
  const runById = new Map<string, SubagentRun>();
  const messages: SubagentMessage[] = [];
  for (const item of events) {
    if (!item.name.startsWith("subagent.")) continue;
    const message = subagentMessageFromEvent(item);
    if (message) messages.push(message);
    const run = subagentRunFromEvent(item);
    if (run?.parentSessionId === sessionId) runById.set(run.id, run);
  }
  if (runById.size === 0) return null;
  const runs = [...runById.values()].sort((left, right) => runTimestamp(right).localeCompare(runTimestamp(left)));
  const activeRuns = runs.filter((run) => run.status === "queued" || run.status === "running");
  const completedRuns = runs.filter((run) => run.status === "completed");
  const failedRuns = runs.filter((run) => run.status === "failed");
  const cancelledRuns = runs.filter((run) => run.status === "cancelled");
  const needsResumeRuns = runs.filter((run) => run.status === "needs_resume");
  const terminalRuns = [...completedRuns, ...failedRuns, ...cancelledRuns]
    .sort((left, right) => runTimestamp(right).localeCompare(runTimestamp(left)));
  const usage = runs.reduce<SubagentUsageSummary>((total, run) => {
    const record = asRecord(run.metadata?.usage);
    total.totalTokens += numberValue(record?.totalTokens);
    total.promptTokens += numberValue(record?.promptTokens);
    total.completionTokens += numberValue(record?.completionTokens);
    total.requestCount += numberValue(record?.requestCount);
    return total;
  }, { totalTokens: 0, promptTokens: 0, completionTokens: 0, requestCount: 0 });
  const blockers = runs.flatMap((run) => uniqueStrings([
    ...(run.report?.blockers ?? []),
    run.error,
    run.progress.currentBlocker,
  ]).map((message) => ({ runId: run.id, roleId: run.roleId, status: run.status, message })));
  const evidenceRefs = runs.flatMap((run) => uniqueRefs([
    ...(run.report?.artifacts ?? []),
    run.report?.patchRef,
    run.report?.diffRef,
    ...run.progress.patchRefs,
  ]).map((ref) => ({ ...ref, runId: run.id, roleId: run.roleId })));
  const finalResults = terminalRuns.map((run) => finalResult(run, messages));
  const latestRun = runs[0] ?? null;
  const latestMeaningfulUpdate = latestRun ? {
    runId: latestRun.id,
    roleId: latestRun.roleId,
    status: latestRun.status,
    message: latestRun.progress.latestMeaningfulActivity || latestRun.report?.summary || latestRun.objective,
    updatedAt: runTimestamp(latestRun),
  } : null;
  const label = activeRuns.length > 0
    ? `${activeRuns.length} ${activeRuns.length === 1 ? "child" : "children"} running`
    : `${terminalRuns.length} ${terminalRuns.length === 1 ? "child" : "children"} finished`;
  const counts = [
    activeRuns.length ? `${activeRuns.length} active` : null,
    completedRuns.length ? `${completedRuns.length} completed` : null,
    failedRuns.length ? `${failedRuns.length} failed` : null,
    cancelledRuns.length ? `${cancelledRuns.length} cancelled` : null,
    needsResumeRuns.length ? `${needsResumeRuns.length} paused` : null,
  ].filter(Boolean).join(" · ");
  const latest = latestMeaningfulUpdate
    ? `${roleLabel(latestMeaningfulUpdate.roleId)}: ${latestMeaningfulUpdate.message}`
    : "";
  return {
    sessionId,
    runs,
    activeRuns,
    completedRuns,
    failedRuns,
    cancelledRuns,
    needsResumeRuns,
    terminalRuns,
    latestRun,
    latestMeaningfulUpdate,
    activeCount: activeRuns.length,
    completedCount: completedRuns.length,
    failedCount: failedRuns.length,
    cancelledCount: cancelledRuns.length,
    needsResumeCount: needsResumeRuns.length,
    terminalCount: terminalRuns.length,
    usage,
    blockers,
    evidenceRefs,
    finalResults,
    testsRunCount: runs.reduce((total, run) => total + run.progress.validationAttempts.length, 0),
    label,
    tooltip: [counts, latest].filter(Boolean).join(". "),
  };
}

function finalResult(run: SubagentRun, messages: SubagentMessage[]): SubagentFinalResultSummary {
  return {
    runId: run.id,
    roleId: run.roleId,
    status: run.status,
    objective: run.objective,
    summary: run.report?.summary || run.error || "Child conversation finished.",
    findings: run.report?.findings ?? [],
    changedFiles: run.progress.changedFiles,
    refs: uniqueRefs([...(run.report?.artifacts ?? []), run.report?.patchRef, run.report?.diffRef]),
    testsRun: run.report?.testsRun ?? [],
    validationAttempts: run.progress.validationAttempts.map((attempt) => attempt.command),
    blockers: uniqueStrings([...(run.report?.blockers ?? []), run.error]),
    confidence: run.report?.confidence ?? null,
    importantMessages: messages
      .filter((message) => message.fromRunId === run.id)
      .map((message) => ({
        id: message.id,
        runId: run.id,
        fromRunId: message.fromRunId,
        kind: message.kind,
        body: message.body,
        createdAt: message.createdAt,
      })),
    workspaceRetention: workspaceRetention(run),
    updatedAt: runTimestamp(run),
  };
}

function subagentRunFromEvent(event: RuntimeEvent): SubagentRun | null {
  const data = asRecord(event.data);
  const candidates = [data?.run, asRecord(data?.message)?.run];
  for (const candidate of candidates) {
    const parsed = SubagentRunSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function subagentMessageFromEvent(event: RuntimeEvent): SubagentMessage | null {
  const parsed = SubagentMessageSchema.safeParse(asRecord(event.data)?.message);
  return parsed.success ? parsed.data : null;
}

function workspaceRetention(run: SubagentRun): SubagentWorkspaceRetentionSummary | null {
  const retention = asRecord(asRecord(run.metadata?.workspaceHandoff)?.workspaceRetention);
  if (retention?.status !== "retained") return null;
  return {
    status: "retained",
    reason: stringValue(retention.reason),
    retainedAt: stringValue(retention.retainedAt),
    expiresAt: stringValue(retention.expiresAt),
    retentionDays: nullableNumber(retention.retentionDays),
    trigger: stringValue(retention.trigger),
    cleanupAfterExpiry: retention.cleanupAfterExpiry === true,
  };
}

function runTimestamp(run: SubagentRun): string {
  return run.updatedAt ?? run.completedAt ?? run.startedAt ?? run.createdAt;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function uniqueRefs(values: Array<SubagentRef | null | undefined>): SubagentRef[] {
  const refs = new Map<string, SubagentRef>();
  for (const ref of values) if (ref) refs.set(`${ref.kind}:${ref.id}`, ref);
  return [...refs.values()];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roleLabel(roleId: string): string {
  return roleId.slice(0, 1).toUpperCase() + roleId.slice(1).replace(/[-_]+/g, " ");
}
