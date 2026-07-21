import {
  CreateImproveRunSchema,
  type CreateImproveRun,
  type RuntimeEvent,
} from "@openpond/contracts";
import type { GoalRuntimeStatus } from "./goal-runtime";
import type { OpenPondGoalStatusTone } from "./openpond-goal-status";

const ACTIVE_STATES = new Set<CreateImproveRun["state"]>([
  "planning",
  "applying_source",
  "running_checks",
  "evaluating",
  "pushing_hosted",
  "running_hosted_checks",
]);

const PENDING_STATES = new Set<CreateImproveRun["state"]>([
  "awaiting_questions",
  "awaiting_plan_approval",
  "paused",
]);

export function latestCreateImproveRuntimeFromEvents(
  events: RuntimeEvent[],
): GoalRuntimeStatus | null {
  const run = latestCreateImproveRunFromEvents(events);
  return run ? createImproveRuntimeStatus(run) : null;
}

export function latestCreateImproveRunFromEvents(
  events: RuntimeEvent[],
): CreateImproveRun | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (item?.name !== "create_improve.updated") continue;
    const run = createImproveRunFromRecord(asRecord(item.data));
    if (run) return run;
  }
  return null;
}

export function latestCreateImproveRunProjection(input: {
  events?: RuntimeEvent[];
  messages?: Array<{ createImproveRun?: CreateImproveRun | null }>;
}): CreateImproveRun | null {
  if (input.events) return latestCreateImproveRunFromEvents(input.events);
  const messages = input.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const run = messages[index]?.createImproveRun ?? null;
    if (run) return run;
  }
  return null;
}

export function createImproveConversationTitle(
  run: CreateImproveRun | null,
  fallback: string,
): string {
  const candidate = run?.target.displayName?.trim() ?? "";
  const normalized = candidate.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (
    candidate
    && !/^(?:create|creating|improve|improving|new) (?:an )?agent$/.test(normalized)
  ) {
    return candidate;
  }
  return fallback;
}

function createImproveRunFromRecord(
  record: Record<string, unknown> | null,
): CreateImproveRun | null {
  const parsed = CreateImproveRunSchema.safeParse(record?.createImproveRun);
  return parsed.success ? parsed.data : null;
}

function createImproveRuntimeStatus(run: CreateImproveRun): GoalRuntimeStatus | null {
  const presentation = presentationForState(run);
  if (!presentation) return null;
  const timeUsedSeconds = elapsedSeconds(run.createdAt, run.updatedAt);
  const detail = run.blockedReason ?? statusLabel(run.state);
  return {
    objective: run.objective,
    status: run.state,
    subagents: null,
    timeUsedSeconds,
    tokensUsed: null,
    tokenBudget: null,
    actionLabel: presentation.actionLabel,
    timeLabel: formatDuration(timeUsedSeconds),
    label: presentation.actionLabel,
    detail,
    tooltip: `${presentation.actionLabel}: ${detail}. ${run.objective}`,
    tone: presentation.tone,
  };
}

function presentationForState(run: CreateImproveRun): {
  tone: OpenPondGoalStatusTone;
  actionLabel: string;
} | null {
  const state = run.state;
  const subject = run.target.kind === "agent" ? "Agent" : "Work";
  if (ACTIVE_STATES.has(state)) return { tone: "active", actionLabel: `${subject} running` };
  if (PENDING_STATES.has(state)) return { tone: "active", actionLabel: `${subject} awaiting input` };
  if (state === "blocked") return { tone: "limited", actionLabel: `${subject} blocked` };
  if (state === "failed") return { tone: "limited", actionLabel: `${subject} failed` };
  if (state === "cancelled") return { tone: "limited", actionLabel: `${subject} cancelled` };
  if (state === "ready" || state === "ready_local") return { tone: "done", actionLabel: run.target.kind === "agent" ? "Agent ready" : "Workproduct ready" };
  if (state === "published_hosted") return { tone: "done", actionLabel: run.target.kind === "agent" ? "Agent published" : "Workproduct published" };
  return null;
}

function elapsedSeconds(startValue: string, endValue: string): number {
  const start = Date.parse(startValue);
  const end = Date.parse(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / 1000);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
