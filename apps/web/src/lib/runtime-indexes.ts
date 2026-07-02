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

export type RuntimeIndexReuseState = {
  events: RuntimeEvent[];
  indexes: RuntimeIndexes;
};

const EMPTY_RUNTIME_EVENTS: RuntimeEvent[] = [];
const EMPTY_APPROVALS: Approval[] = [];

export function buildRuntimeIndexes(events: RuntimeEvent[], approvals: Approval[]): RuntimeIndexes {
  return buildRuntimeIndexesWithReuse(events, approvals, null);
}

export function buildRuntimeIndexesWithReuse(
  events: RuntimeEvent[],
  approvals: Approval[],
  previous: RuntimeIndexReuseState | null,
): RuntimeIndexes {
  const eventIndexes =
    previous && canReuseAppendOnlyEvents(previous.events, events)
      ? appendRuntimeEventIndexes(previous.indexes, previous.events.length, events)
      : buildRuntimeEventIndexes(events);
  const approvalIndexes = buildApprovalIndexes(approvals);
  return {
    ...eventIndexes,
    ...approvalIndexes,
  };
}

function buildRuntimeEventIndexes(events: RuntimeEvent[]): Pick<
  RuntimeIndexes,
  "eventsBySessionId" | "latestContextUsageBySessionId" | "latestGoalRuntimeBySessionId" | "activeGoalSessionIds"
> {
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

  return runtimeEventDerivedIndexes(eventsBySessionId);
}

function appendRuntimeEventIndexes(
  previous: RuntimeIndexes,
  previousEventCount: number,
  events: RuntimeEvent[],
): Pick<
  RuntimeIndexes,
  "eventsBySessionId" | "latestContextUsageBySessionId" | "latestGoalRuntimeBySessionId" | "activeGoalSessionIds"
> {
  const eventsBySessionId = new Map(previous.eventsBySessionId);
  const latestContextUsageBySessionId = new Map(previous.latestContextUsageBySessionId);
  const latestGoalRuntimeBySessionId = new Map(previous.latestGoalRuntimeBySessionId);
  const activeGoalSessionIds = new Set(previous.activeGoalSessionIds);
  const changedSessionIds = new Set<string>();

  for (let index = previousEventCount; index < events.length; index += 1) {
    const item = events[index]!;
    if (!item.sessionId) continue;
    if (changedSessionIds.has(item.sessionId)) {
      eventsBySessionId.get(item.sessionId)!.push(item);
      continue;
    }
    const currentSessionEvents = eventsBySessionId.get(item.sessionId);
    eventsBySessionId.set(item.sessionId, currentSessionEvents ? [...currentSessionEvents, item] : [item]);
    changedSessionIds.add(item.sessionId);
  }

  for (const sessionId of changedSessionIds) {
    const sessionEvents = eventsBySessionId.get(sessionId) ?? EMPTY_RUNTIME_EVENTS;
    const contextUsage = latestContextUsageFromEvents(sessionEvents);
    if (contextUsage) {
      latestContextUsageBySessionId.set(sessionId, contextUsage);
    } else {
      latestContextUsageBySessionId.delete(sessionId);
    }

    const goalRuntime = latestGoalRuntimeFromEvents(sessionEvents);
    if (goalRuntime) {
      latestGoalRuntimeBySessionId.set(sessionId, goalRuntime);
      if (goalRuntime.tone === "active") {
        activeGoalSessionIds.add(sessionId);
      } else {
        activeGoalSessionIds.delete(sessionId);
      }
    } else {
      latestGoalRuntimeBySessionId.delete(sessionId);
      activeGoalSessionIds.delete(sessionId);
    }
  }

  return {
    eventsBySessionId,
    latestContextUsageBySessionId,
    latestGoalRuntimeBySessionId,
    activeGoalSessionIds,
  };
}

function runtimeEventDerivedIndexes(
  eventsBySessionId: Map<string, RuntimeEvent[]>,
): Pick<
  RuntimeIndexes,
  "eventsBySessionId" | "latestContextUsageBySessionId" | "latestGoalRuntimeBySessionId" | "activeGoalSessionIds"
> {
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

  return {
    eventsBySessionId,
    latestContextUsageBySessionId,
    latestGoalRuntimeBySessionId,
    activeGoalSessionIds,
  };
}

function buildApprovalIndexes(approvals: Approval[]): Pick<
  RuntimeIndexes,
  "approvalsById" | "approvalsByStatus" | "pendingApprovalsBySessionId" | "latestPendingApprovalBySessionId"
> {
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
    approvalsById,
    approvalsByStatus,
    pendingApprovalsBySessionId,
    latestPendingApprovalBySessionId,
  };
}

function canReuseAppendOnlyEvents(previous: RuntimeEvent[], next: RuntimeEvent[]): boolean {
  if (previous === next) return true;
  if (previous.length > next.length) return false;
  if (previous.length === next.length) return false;
  if (previous.length === 0) return true;
  return previous[0] === next[0] && previous[previous.length - 1] === next[previous.length - 1];
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
