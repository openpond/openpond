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
  blockedRuns: SubagentRun[];
  completedRuns: SubagentRun[];
  latestRun: SubagentRun | null;
  activeCount: number;
  blockedCount: number;
  completedCount: number;
  requiredOpenCount: number;
  usage: SubagentUsageSummary;
  blockers: SubagentBlockerSummary[];
  evidenceRefs: SubagentEvidenceSummary[];
  testsRunCount: number;
  taskGraph: SubagentTaskGraph;
  label: string;
  tooltip: string;
};

const ACTIVE_SUBAGENT_STATUSES = new Set<SubagentRun["status"]>(["queued", "running", "needs_resume"]);
const BLOCKED_SUBAGENT_STATUSES = new Set<SubagentRun["status"]>(["blocked", "failed", "cancelled"]);

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
  const blockedRuns = runs.filter((run) => BLOCKED_SUBAGENT_STATUSES.has(run.status));
  const completedRuns = runs.filter((run) => run.status === "completed");
  const requiredOpenCount = runs.filter((run) => run.required && run.status !== "completed").length;
  const latestRun = runs[0] ?? null;
  return {
    sessionId,
    runs,
    activeRuns,
    blockedRuns,
    completedRuns,
    latestRun,
    activeCount: activeRuns.length,
    blockedCount: blockedRuns.length,
    completedCount: completedRuns.length,
    requiredOpenCount,
    usage: subagentUsageSummary(runs),
    blockers: subagentBlockers(runs),
    evidenceRefs: subagentEvidenceRefs(runs),
    testsRunCount: runs.reduce((total, run) => total + (run.report?.testsRun.length ?? 0), 0),
    taskGraph: subagentTaskGraph(sessionId, runs, deliveredMessages),
    label: subagentRuntimeLabel(activeRuns, blockedRuns, completedRuns),
    tooltip: subagentRuntimeTooltip(activeRuns, blockedRuns, completedRuns),
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
  return Date.parse(run.completedAt ?? run.startedAt ?? run.createdAt) || 0;
}

function subagentRuntimeLabel(
  activeRuns: SubagentRun[],
  blockedRuns: SubagentRun[],
  completedRuns: SubagentRun[],
): string {
  if (activeRuns.length > 0) return `${activeRuns.length} ${plural(activeRuns.length, "subagent")} running`;
  if (blockedRuns.length > 0) return `${blockedRuns.length} ${plural(blockedRuns.length, "subagent")} blocked`;
  return `${completedRuns.length} ${plural(completedRuns.length, "subagent")} completed`;
}

function subagentRuntimeTooltip(
  activeRuns: SubagentRun[],
  blockedRuns: SubagentRun[],
  completedRuns: SubagentRun[],
): string {
  const primary = activeRuns.length > 0 ? activeRuns : blockedRuns.length > 0 ? blockedRuns : completedRuns;
  const details = primary.slice(0, 4).map((run) => `${subagentRoleLabel(run.roleId)} ${run.status}`);
  const hidden = primary.length - details.length;
  return `Subagents: ${details.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}`;
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

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return parsed;
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
