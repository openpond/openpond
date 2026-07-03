import type { RuntimeEvent } from "@openpond/contracts";
import { openPondGoalStatusPresentation, type OpenPondGoalStatusTone } from "./openpond-goal-status";

export type GoalRuntimeStatus = {
  objective: string;
  status: string;
  timeUsedSeconds: number;
  tokensUsed: number | null;
  tokenBudget: number | null;
  actionLabel: string;
  timeLabel: string;
  label: string;
  detail: string;
  tooltip: string;
  tone: OpenPondGoalStatusTone;
};

type ThreadGoalRecord = {
  objective: string;
  status: string;
  statusLabel: string;
  timeUsedSeconds: number;
  tokensUsed: number | null;
  tokenBudget: number | null;
};

export function latestGoalRuntimeFromEvents(events: RuntimeEvent[]): GoalRuntimeStatus | null {
  let terminalTurnAfterGoal = false;
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
      const goal = threadGoalFromRecord(asRecord(data.goal));
      if (goal) {
        const status = goalRuntimeStatus(goal);
        if (terminalTurnAfterGoal && status.tone === "active") return null;
        return status;
      }
    }
    if (data.kind === "goal_context") {
      const goal = threadGoalFromGoalContext(item.output ?? "");
      if (goal) {
        const status = goalRuntimeStatus(goal);
        if (terminalTurnAfterGoal && status.tone === "active") return null;
        return status;
      }
    }
  }
  return null;
}

function isTerminalTurnEvent(item: RuntimeEvent | undefined): boolean {
  return item?.name === "turn.completed" || item?.name === "turn.interrupted" || item?.name === "turn.failed";
}

function goalRuntimeStatus(goal: ThreadGoalRecord): GoalRuntimeStatus {
  const presentation = openPondGoalStatusPresentation(goal.status);
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
    timeUsedSeconds: goal.timeUsedSeconds,
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget,
    actionLabel: presentation.actionLabel,
    timeLabel,
    label,
    detail,
    tooltip: `Goal runtime: ${formatDurationLong(goal.timeUsedSeconds)}. ${detail}. ${goal.objective}`,
    tone: presentation.tone,
  };
}

function threadGoalFromRecord(record: Record<string, unknown> | null): ThreadGoalRecord | null {
  if (!record) return null;
  const objective = stringValue(record.objective) ?? "Active goal";
  const status = stringValue(record.status) ?? "active";
  const timeUsedSeconds = numberValue(record.timeUsedSeconds) ?? numberValue(record.time_used_seconds) ?? 0;
  const tokensUsed = numberValue(record.tokensUsed) ?? numberValue(record.tokens_used);
  const tokenBudget = numberValue(record.tokenBudget) ?? numberValue(record.token_budget);
  return {
    objective,
    status,
    statusLabel: statusLabel(status),
    timeUsedSeconds: Math.max(0, Math.floor(timeUsedSeconds)),
    tokensUsed: tokensUsed === null ? null : Math.max(0, Math.floor(tokensUsed)),
    tokenBudget: tokenBudget === null ? null : Math.max(0, Math.floor(tokenBudget)),
  };
}

function threadGoalFromGoalContext(value: string): ThreadGoalRecord | null {
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
    status,
    statusLabel: statusLabel(status),
    timeUsedSeconds: Math.max(0, Math.floor(timeUsedSeconds)),
    tokensUsed,
    tokenBudget,
  };
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
  const value = tokens / 1000;
  if (value >= 10 || Number.isInteger(value)) return `${Math.round(value)}k`;
  return `${value.toFixed(1)}k`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
