import type { Approval, ContextUsageSnapshot, RuntimeEvent } from "@openpond/contracts";
import { latestContextUsageFromEvents } from "./context-window";
import { latestGoalRuntimeFromEvents, type GoalRuntimeStatus } from "./goal-runtime";

export type ApprovalStatus = Approval["status"];

export type RuntimeIndexes = {
  eventsBySessionId: Map<string, RuntimeEvent[]>;
  latestContextUsageBySessionId: Map<string, ContextUsageSnapshot>;
  latestGoalRuntimeBySessionId: Map<string, GoalRuntimeStatus>;
  activeGoalSessionIds: Set<string>;
  approvalsById: Map<string, Approval>;
  approvalsByStatus: Map<ApprovalStatus, Approval[]>;
  pendingApprovalsBySessionId: Map<string, Approval[]>;
  latestPendingApprovalBySessionId: Map<string, Approval>;
};

const EMPTY_RUNTIME_EVENTS: RuntimeEvent[] = [];
const EMPTY_APPROVALS: Approval[] = [];

export function buildRuntimeIndexes(events: RuntimeEvent[], approvals: Approval[]): RuntimeIndexes {
  const eventsBySessionId = new Map<string, RuntimeEvent[]>();
  for (const item of events) {
    if (!item.sessionId) continue;
    const sessionEvents = eventsBySessionId.get(item.sessionId);
    if (sessionEvents) {
      sessionEvents.push(item);
    } else {
      eventsBySessionId.set(item.sessionId, [item]);
    }
  }

  const latestContextUsageBySessionId = new Map<string, ContextUsageSnapshot>();
  const latestGoalRuntimeBySessionId = new Map<string, GoalRuntimeStatus>();
  const activeGoalSessionIds = new Set<string>();
  for (const [sessionId, sessionEvents] of eventsBySessionId) {
    const contextUsage = latestContextUsageFromEvents(sessionEvents);
    if (contextUsage) latestContextUsageBySessionId.set(sessionId, contextUsage);

    const goalRuntime = latestGoalRuntimeFromEvents(sessionEvents);
    if (!goalRuntime) continue;
    latestGoalRuntimeBySessionId.set(sessionId, goalRuntime);
    if (goalRuntime.tone === "active") activeGoalSessionIds.add(sessionId);
  }

  const approvalsById = new Map<string, Approval>();
  const approvalsByStatus = new Map<ApprovalStatus, Approval[]>();
  const pendingApprovalsBySessionId = new Map<string, Approval[]>();
  const latestPendingApprovalBySessionId = new Map<string, Approval>();
  for (const approval of approvals) {
    approvalsById.set(approval.id, approval);

    const statusApprovals = approvalsByStatus.get(approval.status);
    if (statusApprovals) {
      statusApprovals.push(approval);
    } else {
      approvalsByStatus.set(approval.status, [approval]);
    }

    if (approval.status !== "pending") continue;
    const sessionApprovals = pendingApprovalsBySessionId.get(approval.sessionId);
    if (sessionApprovals) {
      sessionApprovals.push(approval);
    } else {
      pendingApprovalsBySessionId.set(approval.sessionId, [approval]);
    }

    const currentLatest = latestPendingApprovalBySessionId.get(approval.sessionId);
    if (!currentLatest || approvalCreatedAtMs(approval.createdAt) > approvalCreatedAtMs(currentLatest.createdAt)) {
      latestPendingApprovalBySessionId.set(approval.sessionId, approval);
    }
  }

  return {
    eventsBySessionId,
    latestContextUsageBySessionId,
    latestGoalRuntimeBySessionId,
    activeGoalSessionIds,
    approvalsById,
    approvalsByStatus,
    pendingApprovalsBySessionId,
    latestPendingApprovalBySessionId,
  };
}

export function runtimeEventsForSession(indexes: RuntimeIndexes, sessionId: string | null): RuntimeEvent[] {
  if (!sessionId) return EMPTY_RUNTIME_EVENTS;
  return indexes.eventsBySessionId.get(sessionId) ?? EMPTY_RUNTIME_EVENTS;
}

export function latestContextUsageForSession(
  indexes: RuntimeIndexes,
  sessionId: string | null,
): ContextUsageSnapshot | null {
  if (!sessionId) return null;
  return indexes.latestContextUsageBySessionId.get(sessionId) ?? null;
}

export function latestGoalRuntimeForSession(
  indexes: RuntimeIndexes,
  sessionId: string | null,
): GoalRuntimeStatus | null {
  if (!sessionId) return null;
  return indexes.latestGoalRuntimeBySessionId.get(sessionId) ?? null;
}

export function approvalsWithStatus(indexes: RuntimeIndexes, status: ApprovalStatus): Approval[] {
  return indexes.approvalsByStatus.get(status) ?? EMPTY_APPROVALS;
}

export function latestPendingApprovalForSession(indexes: RuntimeIndexes, sessionId: string | null): Approval | null {
  if (!sessionId) return null;
  return indexes.latestPendingApprovalBySessionId.get(sessionId) ?? null;
}

function approvalCreatedAtMs(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}
