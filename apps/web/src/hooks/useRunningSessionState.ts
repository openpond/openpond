import { useMemo } from "react";
import type { Session } from "@openpond/contracts";
import type { GoalRuntimeStatus } from "../lib/goal-runtime";
import type { RuntimeIndexes } from "../lib/runtime-indexes";

export function useRunningSessionState({
  goalRuntime,
  runtimeIndexes,
  selectedSession,
  selectedSessionId,
  sidebarSessions,
}: {
  goalRuntime: GoalRuntimeStatus | null;
  runtimeIndexes: RuntimeIndexes;
  selectedSession: Session | null;
  selectedSessionId: string | null;
  sidebarSessions: Session[];
}) {
  const goalRunningSessionIds = useMemo(() => {
    const next = new Set(runtimeIndexes.activeGoalSessionIds);
    if (selectedSessionId && goalRuntime?.tone === "active") next.add(selectedSessionId);
    return next;
  }, [goalRuntime, runtimeIndexes, selectedSessionId]);
  const runningSessionIds = useMemo(() => {
    const next = new Set(goalRunningSessionIds);
    for (const session of sidebarSessions) {
      if (session.status === "active") next.add(session.id);
    }
    return next;
  }, [goalRunningSessionIds, sidebarSessions]);
  const selectedSessionRunning = Boolean(selectedSession && runningSessionIds.has(selectedSession.id));

  return {
    runningSessionIds,
    selectedSessionRunning,
  };
}
