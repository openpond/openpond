import type { RuntimeEvent } from "@openpond/contracts";
import { openPondGoalStatusPresentation, type OpenPondGoalStatusTone } from "./openpond-goal-status";

export type GoalRuntimeStatus = {
  objective: string;
  status: string;
  subagents: GoalRuntimeSubagentState | null;
  timeUsedSeconds: number;
  tokensUsed: number | null;
  tokenBudget: number | null;
  actionLabel: string;
  timeLabel: string;
  label: string;
  detail: string;
  tooltip: string;
  tone: OpenPondGoalStatusTone;
  observedAt?: string | null;
};

export type GoalRuntimeSubagentRunSummary = {
  id: string;
  childSessionId: string | null;
  roleId: string;
  status: string;
  required: boolean;
  objective: string;
  reviewStatus: string | null;
  updatedAt: string | null;
  cleanupStatus: string | null;
  archiveStatus: string | null;
  sessionArchived: boolean;
  blockerCount: number;
  validationAttemptCount: number;
  changedFileCount: number;
  followUpNeeded: boolean;
};

export type GoalRuntimeSubagentState = {
  source: string;
  updatedAt: string | null;
  totalCount: number;
  requiredCount: number;
  optionalCount: number;
  activeCount: number;
  submittedForReviewCount: number;
  needsRevisionCount: number;
  needsUserInputCount: number;
  acceptedCount: number;
  blockingCount: number;
  terminalCount: number;
  cleanupNeededCount: number;
  archivedCount: number;
  unresolvedCount: number;
  requiredActiveCount: number;
  requiredSubmittedForReviewCount: number;
  requiredNeedsRevisionCount: number;
  requiredNeedsUserInputCount: number;
  requiredAcceptedCount: number;
  requiredBlockingCount: number;
  requiredArchivedCount: number;
  requiredUnresolvedCount: number;
  runs: GoalRuntimeSubagentRunSummary[];
};

type ThreadGoalRecord = {
  objective: string;
  provider: string | null;
  status: string;
  statusLabel: string;
  subagents: GoalRuntimeSubagentState | null;
  timeUsedSeconds: number;
  tokensUsed: number | null;
  tokenBudget: number | null;
  observedAt: string | null;
};

export function latestGoalRuntimeFromEvents(events: RuntimeEvent[]): GoalRuntimeStatus | null {
  let terminalTurnAfterGoal = false;
  const observedAt = latestEventTimestamp(events);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (isTerminalTurnEvent(item)) {
      terminalTurnAfterGoal = true;
      continue;
    }
    const data = asRecord(item?.data);
    if (item?.name !== "diagnostic" || !data) continue;
    if (data.kind === "thread_goal_cleared") return null;
    if (data.kind === "thread_goal") {
      const goal = threadGoalFromRecord(asRecord(data.goal), stringValue(data.provider), observedAt);
      if (goal) {
        const status = goalRuntimeStatus(goal);
        if (terminalTurnAfterGoal && status.tone === "active") return null;
        return status;
      }
    }
    if (data.kind === "goal_context") {
      const goal = threadGoalFromGoalContext(item.output ?? "", stringValue(data.provider) ?? "codex", observedAt);
      if (goal) {
        const status = goalRuntimeStatus(goal);
        if (terminalTurnAfterGoal && status.tone === "active") return null;
        return status;
      }
    }
  }
  return null;
}

export function latestKnownActiveGoalRuntimeFromEvents(events: RuntimeEvent[]): GoalRuntimeStatus | null {
  const observedAt = latestEventTimestamp(events);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    const data = asRecord(item?.data);
    if (item?.name !== "diagnostic" || !data) continue;
    if (data.kind === "thread_goal_cleared" && !booleanValue(data.synthetic)) return null;
    if (data.kind === "thread_goal") {
      const goal = threadGoalFromRecord(asRecord(data.goal), stringValue(data.provider), observedAt);
      if (!goal) continue;
      const status = goalRuntimeStatus(goal);
      return status.tone === "active" ? status : null;
    }
    if (data.kind === "goal_context") {
      const goal = threadGoalFromGoalContext(item.output ?? "", stringValue(data.provider) ?? "codex", observedAt);
      if (!goal) continue;
      const status = goalRuntimeStatus(goal);
      return status.tone === "active" ? status : null;
    }
  }
  return null;
}

export function activeGoalRuntimeFromSessionMetadata(metadata: unknown): GoalRuntimeStatus | null {
  const record = asRecord(asRecord(metadata)?.codexGoalRuntime);
  const goal = threadGoalFromRecord(record, stringValue(record?.provider) ?? "codex");
  if (!goal) return null;
  const status = goalRuntimeStatus(goal);
  return status.tone === "active" ? status : null;
}

function isTerminalTurnEvent(item: RuntimeEvent | undefined): boolean {
  return item?.name === "turn.completed" || item?.name === "turn.interrupted" || item?.name === "turn.failed";
}

function goalRuntimeStatus(goal: ThreadGoalRecord): GoalRuntimeStatus {
  const presentation = goalStatusPresentation(goal.status, goal.provider);
  const timeLabel = formatDuration(goal.timeUsedSeconds);
  const label = `Goal ${timeLabel}`;
  const tokens =
    goal.tokensUsed === null
      ? null
      : goal.tokenBudget === null
        ? `${formatTokenCount(goal.tokensUsed)} tokens`
        : `${formatTokenCount(goal.tokensUsed)} / ${formatTokenCount(goal.tokenBudget)} tokens`;
  const detail = tokens ? `${goal.statusLabel} · ${tokens}` : goal.statusLabel;
  return {
    objective: goal.objective,
    status: goal.status,
    subagents: goal.subagents,
    timeUsedSeconds: goal.timeUsedSeconds,
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
    actionLabel: presentation.actionLabel,
    timeLabel,
    label,
    detail,
    tooltip: `Goal runtime: ${formatDurationLong(goal.timeUsedSeconds)}. ${detail}. ${goal.objective}`,
    tone: presentation.tone,
    observedAt: goal.observedAt,
  };
}

export function projectGoalRuntimeTo(
  goalRuntime: GoalRuntimeStatus | null,
  observedAt: string,
): GoalRuntimeStatus | null {
  if (!goalRuntime || goalRuntime.tone !== "active" || !goalRuntime.observedAt) return goalRuntime;
  const additionalSeconds = elapsedSecondsBetween(goalRuntime.observedAt, observedAt);
  if (additionalSeconds <= 0) return goalRuntime;
  const timeUsedSeconds = goalRuntime.timeUsedSeconds + additionalSeconds;
  const timeLabel = formatDuration(timeUsedSeconds);
  return {
    ...goalRuntime,
    timeUsedSeconds,
    timeLabel,
    label: `Goal ${timeLabel}`,
    tooltip: `Goal runtime: ${formatDurationLong(timeUsedSeconds)}. ${goalRuntime.detail}. ${goalRuntime.objective}`,
    observedAt,
  };
}

function threadGoalFromRecord(
  record: Record<string, unknown> | null,
  provider: string | null = null,
  observedAt: string | null = null,
): ThreadGoalRecord | null {
  if (!record) return null;
  const objective = stringValue(record.objective) ?? "Active goal";
  const status = stringValue(record.status) ?? "active";
  const normalizedProvider = normalizeProvider(provider) ?? normalizeProvider(stringValue(record.provider));
  const observation = observedAt ??
    stringValue(record.updatedAt) ??
    stringValue(record.updated_at) ??
    null;
  const reportedTimeUsedSeconds = numberValue(record.timeUsedSeconds) ?? numberValue(record.time_used_seconds) ?? 0;
  const activeSinceAt = stringValue(record.activeSinceAt) ?? stringValue(record.active_since_at);
  const projectedTimeUsedSeconds = goalStatusPresentation(status, normalizedProvider).tone === "active"
    ? elapsedSecondsBetween(activeSinceAt ?? stringValue(record.createdAt) ?? stringValue(record.created_at), observation)
    : 0;
  const timeUsedSeconds = activeSinceAt
    ? reportedTimeUsedSeconds + projectedTimeUsedSeconds
    : Math.max(reportedTimeUsedSeconds, projectedTimeUsedSeconds);
  const tokensUsed = numberValue(record.tokensUsed) ?? numberValue(record.tokens_used);
  const tokenBudget = numberValue(record.tokenBudget) ?? numberValue(record.token_budget);
  const subagents = goalSubagentStateFromRecord(asRecord(record.subagents));
  return {
    objective,
    provider: normalizedProvider,
    status,
    statusLabel: statusLabel(status),
    subagents,
    timeUsedSeconds: Math.max(0, Math.floor(timeUsedSeconds)),
    tokensUsed: tokensUsed === null ? null : Math.max(0, Math.floor(tokensUsed)),
    tokenBudget: tokenBudget === null ? null : Math.max(0, Math.floor(tokenBudget)),
    observedAt: observation,
  };
}

function latestEventTimestamp(events: readonly RuntimeEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const timestamp = events[index]?.timestamp;
    if (timestamp && Number.isFinite(Date.parse(timestamp))) return timestamp;
  }
  return null;
}

function elapsedSecondsBetween(startValue: string | null, endValue: string | null): number {
  if (!startValue || !endValue) return 0;
  const start = Date.parse(startValue);
  const end = Date.parse(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.floor((end - start) / 1_000);
}

function threadGoalFromGoalContext(
  value: string,
  provider: string | null = null,
  observedAt: string | null = null,
): ThreadGoalRecord | null {
  if (!value.trim()) return null;
  const status = lineValue(value, "Status") ?? "active";
  const tokensUsed = numberFromLine(value, "Tokens used");
  const tokenBudget = numberFromLine(value, "Token budget");
  const timeUsedSeconds =
    numberFromLine(value, "Time used seconds") ??
    numberFromLine(value, "Time spent pursuing goal") ??
    numberFromLine(value, "Elapsed seconds") ??
    0;
  const objective = xmlBlock(value, "objective") ?? xmlBlock(value, "untrusted_objective") ?? "Active goal";
  return {
    objective,
    provider: normalizeProvider(provider),
    status,
    statusLabel: statusLabel(status),
    subagents: null,
    timeUsedSeconds: Math.max(0, Math.floor(timeUsedSeconds)),
    tokensUsed,
    tokenBudget,
    observedAt,
  };
}

function goalSubagentStateFromRecord(record: Record<string, unknown> | null): GoalRuntimeSubagentState | null {
  if (!record) return null;
  return {
    source: stringValue(record.source) ?? "subagent_runs",
    updatedAt: stringValue(record.updatedAt),
    totalCount: countValue(record.totalCount),
    requiredCount: countValue(record.requiredCount),
    optionalCount: countValue(record.optionalCount),
    activeCount: countValue(record.activeCount),
    submittedForReviewCount: countValue(record.submittedForReviewCount),
    needsRevisionCount: countValue(record.needsRevisionCount),
    needsUserInputCount: countValue(record.needsUserInputCount),
    acceptedCount: countValue(record.acceptedCount),
    blockingCount: countValue(record.blockingCount),
    terminalCount: countValue(record.terminalCount),
    cleanupNeededCount: countValue(record.cleanupNeededCount),
    archivedCount: countValue(record.archivedCount),
    unresolvedCount: countValue(record.unresolvedCount),
    requiredActiveCount: countValue(record.requiredActiveCount),
    requiredSubmittedForReviewCount: countValue(record.requiredSubmittedForReviewCount),
    requiredNeedsRevisionCount: countValue(record.requiredNeedsRevisionCount),
    requiredNeedsUserInputCount: countValue(record.requiredNeedsUserInputCount),
    requiredAcceptedCount: countValue(record.requiredAcceptedCount),
    requiredBlockingCount: countValue(record.requiredBlockingCount),
    requiredArchivedCount: countValue(record.requiredArchivedCount),
    requiredUnresolvedCount: countValue(record.requiredUnresolvedCount),
    runs: Array.isArray(record.runs)
      ? record.runs
        .map((item) => goalSubagentRunSummaryFromRecord(asRecord(item)))
        .filter((item): item is GoalRuntimeSubagentRunSummary => Boolean(item))
      : [],
  };
}

function goalSubagentRunSummaryFromRecord(
  record: Record<string, unknown> | null,
): GoalRuntimeSubagentRunSummary | null {
  if (!record) return null;
  const id = stringValue(record.id);
  const roleId = stringValue(record.roleId);
  const status = stringValue(record.status);
  const objective = stringValue(record.objective);
  if (!id || !roleId || !status || !objective) return null;
  return {
    id,
    childSessionId: stringValue(record.childSessionId),
    roleId,
    status,
    required: booleanValue(record.required),
    objective,
    reviewStatus: stringValue(record.reviewStatus),
    updatedAt: stringValue(record.updatedAt),
    cleanupStatus: stringValue(record.cleanupStatus),
    archiveStatus: stringValue(record.archiveStatus),
    sessionArchived: booleanValue(record.sessionArchived),
    blockerCount: countValue(record.blockerCount),
    validationAttemptCount: countValue(record.validationAttemptCount),
    changedFileCount: countValue(record.changedFileCount),
    followUpNeeded: booleanValue(record.followUpNeeded),
  };
}

function goalStatusPresentation(
  status: string,
  provider: string | null,
): { tone: OpenPondGoalStatusTone; actionLabel: string } {
  if (provider === "codex") {
    const codexPresentation = codexGoalStatusPresentation(status);
    if (codexPresentation) return codexPresentation;
  }
  return openPondGoalStatusPresentation(status);
}

function codexGoalStatusPresentation(status: string): { tone: OpenPondGoalStatusTone; actionLabel: string } | null {
  switch (statusKey(status)) {
    case "active":
    case "running":
      return { tone: "active", actionLabel: "Pursuing goal" };
    case "paused":
      return { tone: "paused", actionLabel: "Goal paused" };
    case "blocked":
      return { tone: "limited", actionLabel: "Goal blocked" };
    case "complete":
    case "completed":
    case "achieved":
      return { tone: "done", actionLabel: "Goal achieved" };
    case "failed":
      return { tone: "limited", actionLabel: "Goal failed" };
    case "cancelled":
    case "canceled":
    case "stopped":
      return { tone: "limited", actionLabel: "Goal cancelled" };
    case "budget_limited":
      return { tone: "limited", actionLabel: "Goal budget limited" };
    default:
      return null;
  }
}

function statusKey(value: string): string {
  return value.trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function lineValue(value: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*-?\\s*${escaped}:\\s*(.+?)\\s*$`, "im").exec(value);
  return match?.[1]?.trim() || null;
}

function numberFromLine(value: string, label: string): number | null {
  const raw = lineValue(value, label);
  if (!raw) return null;
  const normalized = raw.replace(/,/g, "");
  const match = /-?\d+(?:\.\d+)?/.exec(normalized);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function xmlBlock(value: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, "i").exec(value);
  return match?.[1]?.trim() || null;
}

function statusLabel(status: string): string {
  return status
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatDurationLong(seconds: number): string {
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `${hours}h ${remainingMinutes}m`;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    if (value < 10) return `${trimFixed(value, 2)}M`;
    if (value < 100) return `${trimFixed(value, 1)}M`;
    return `${Math.round(value)}M`;
  }
  const value = tokens / 1000;
  if (value >= 10 || Number.isInteger(value)) return `${Math.round(value)}k`;
  return `${value.toFixed(1)}k`;
}

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function normalizeProvider(value: string | null): string | null {
  return value?.trim().toLowerCase() || null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function countValue(value: unknown): number {
  const parsed = numberValue(value);
  return parsed === null ? 0 : Math.max(0, Math.floor(parsed));
}
