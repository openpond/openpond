import { useMemo } from "react";
import type { Session } from "@openpond/contracts";
import type { GoalRuntimeStatus } from "../lib/goal-runtime";
import type { RuntimeIndexes } from "../lib/runtime-indexes";
import type { SubagentRuntimeStatus } from "../lib/subagent-runtime";

export function useRunningSessionState({
  goalRuntime,
  goalRuntimeBySessionId,
  runtimeIndexes,
  selectedSession,
  selectedSessionId,
  sidebarSessions,
  subagentRuntimeBySessionId,
}: {
  goalRuntime: GoalRuntimeStatus | null;
  goalRuntimeBySessionId?: ReadonlyMap<string, GoalRuntimeStatus>;
  runtimeIndexes: RuntimeIndexes;
  selectedSession: Session | null;
  selectedSessionId: string | null;
  sidebarSessions: Session[];
  subagentRuntimeBySessionId?: ReadonlyMap<string, SubagentRuntimeStatus>;
}) {
  const sessionById = useMemo(
    () => new Map(sidebarSessions.map((session) => [session.id, session])),
    [sidebarSessions],
  );
  const goalRunningSessionIds = useMemo(() => {
    const next = new Set<string>();
    for (const [sessionId, runtime] of goalRuntimeBySessionId ?? []) {
      const session = sessionById.get(sessionId);
      if (runtime.tone === "active" && !session?.systemKind) next.add(sessionId);
    }
    for (const sessionId of runtimeIndexes.activeGoalSessionIds) {
      const session = sessionById.get(sessionId);
      if (!session?.systemKind) next.add(sessionId);
    }
    if (selectedSessionId && !selectedSession?.systemKind && goalRuntime?.tone === "active") {
      next.add(selectedSessionId);
    }
    return next;
  }, [goalRuntime, goalRuntimeBySessionId, runtimeIndexes, selectedSession, selectedSessionId, sessionById]);
  const runningSessionIds = useMemo(() => {
    const next = new Set(goalRunningSessionIds);
    for (const [sessionId, runtime] of subagentRuntimeBySessionId ?? []) {
      const session = sessionById.get(sessionId);
      if (runtime.activeCount > 0 && !session?.systemKind) next.add(sessionId);
    }
    for (const sessionId of runtimeIndexes.activeSubagentSessionIds) {
      const session = sessionById.get(sessionId);
      if (!session?.systemKind) next.add(sessionId);
    }
    for (const session of sidebarSessions) {
      if (session.systemKind) continue;
      if (session.status === "active") next.add(session.id);
    }
    return next;
  }, [goalRunningSessionIds, runtimeIndexes, sidebarSessions, sessionById, subagentRuntimeBySessionId]);
  const selectedSessionRunning = Boolean(
    selectedSession && !selectedSession.systemKind && runningSessionIds.has(selectedSession.id),
  );

  return {
    runningSessionIds,
    selectedSessionRunning,
  };
}
