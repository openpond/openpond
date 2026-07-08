import {
  CreatePipelineSnapshotSchema,
  type CreatePipelineSnapshot,
  type RuntimeEvent,
} from "@openpond/contracts";
import type { GoalRuntimeStatus } from "./goal-runtime";
import type { OpenPondGoalStatusTone } from "./openpond-goal-status";

const ACTIVE_CREATE_PIPELINE_STATES = new Set<CreatePipelineSnapshot["state"]>([
  "planning",
  "applying_source",
  "running_checks",
  "pushing_hosted",
  "running_hosted_checks",
]);

const PENDING_CREATE_PIPELINE_STATES = new Set<CreatePipelineSnapshot["state"]>([
  "awaiting_questions",
  "awaiting_plan_approval",
]);

export function latestCreatePipelineRuntimeFromEvents(events: RuntimeEvent[]): GoalRuntimeStatus | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index];
    if (item?.name !== "create_pipeline.updated") continue;
    const snapshot = createPipelineSnapshotFromRecord(asRecord(item.data));
    if (!snapshot) continue;
    return createPipelineRuntimeStatus(snapshot);
  }
  return null;
}

function createPipelineSnapshotFromRecord(record: Record<string, unknown> | null): CreatePipelineSnapshot | null {
  const parsed = CreatePipelineSnapshotSchema.safeParse(record?.createPipeline);
  return parsed.success ? parsed.data : null;
}

function createPipelineRuntimeStatus(snapshot: CreatePipelineSnapshot): GoalRuntimeStatus | null {
  const presentation = createPipelinePresentation(snapshot.state);
  if (!presentation) return null;
  const timeUsedSeconds = elapsedSeconds(snapshot.createdAt, snapshot.updatedAt);
  const timeLabel = formatDuration(timeUsedSeconds);
  const objective = snapshot.request.objective;
  const detail = createPipelineDetail(snapshot);
  return {
    objective,
    status: snapshot.state,
    timeUsedSeconds,
    tokensUsed: null,
    tokenBudget: null,
    actionLabel: presentation.actionLabel,
    timeLabel,
    label: presentation.actionLabel,
    detail,
    tooltip: `${presentation.actionLabel}: ${detail}. ${objective}`,
    tone: presentation.tone,
  };
}

function createPipelinePresentation(state: CreatePipelineSnapshot["state"]): {
  tone: OpenPondGoalStatusTone;
  actionLabel: string;
} | null {
  if (ACTIVE_CREATE_PIPELINE_STATES.has(state)) {
    return { tone: "active", actionLabel: "Create running" };
  }
  if (PENDING_CREATE_PIPELINE_STATES.has(state)) {
    return { tone: "active", actionLabel: "Create awaiting input" };
  }
  if (state === "blocked") return { tone: "limited", actionLabel: "Create blocked" };
  if (state === "failed") return { tone: "limited", actionLabel: "Create failed" };
  if (state === "cancelled") return { tone: "limited", actionLabel: "Create cancelled" };
  if (state === "ready_local") return { tone: "done", actionLabel: "Create ready locally" };
  if (state === "published_hosted") return { tone: "done", actionLabel: "Create published" };
  return null;
}

function createPipelineDetail(snapshot: CreatePipelineSnapshot): string {
  if (snapshot.blockedReason && (snapshot.state === "blocked" || snapshot.state === "failed")) {
    return snapshot.blockedReason;
  }
  return statusLabel(snapshot.state);
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
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
