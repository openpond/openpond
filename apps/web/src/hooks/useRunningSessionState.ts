import { useMemo } from "react";
import type { Session } from "@openpond/contracts";
import type { GoalRuntimeStatus } from "../lib/goal-runtime";
import { runtimeEventsForSession, type RuntimeIndexes } from "../lib/runtime-indexes";
import type { SubagentRuntimeStatus } from "../lib/subagent-runtime";
import { latestTurnCompletionState } from "../lib/turn-completion-state";

function hasPendingTurn(session: Session, runtimeIndexes: RuntimeIndexes): boolean {
  if (session.systemKind || session.status !== "active") return false;
  const events = runtimeEventsForSession(runtimeIndexes, session.id);
  if (events.length === 0) return false;
  const completion = latestTurnCompletionState(events);
  return completion === "pending" || (completion === "none" && !latestTurnEvidenceIsTerminal(events));
}

function shouldShowActiveSessionStatus(session: Session, runtimeIndexes: RuntimeIndexes): boolean {
  if (session.systemKind || session.status !== "active") return false;
  const events = runtimeEventsForSession(runtimeIndexes, session.id);
  if (events.length === 0) return true;
  const completion = latestTurnCompletionState(events);
  return completion === "pending" || (completion === "none" && !latestTurnEvidenceIsTerminal(events));
}

function latestTurnEvidenceIsTerminal(events: ReturnType<typeof runtimeEventsForSession>): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (
      event.name === "turn.completed" ||
      event.name === "turn.failed" ||
      event.name === "turn.interrupted"
    ) {
      return true;
    }
    if (
      event.name === "assistant.delta" ||
      event.name === "assistant.reasoning.delta" ||
      event.name === "tool.started" ||
      event.name === "tool.completed" ||
      event.name === "skill.selected" ||
      event.name === "skill.loaded" ||
      event.name === "skill.load_failed" ||
      event.name === "approval.requested" ||
      event.name === "approval.resolved" ||
      event.name === "command.output" ||
      event.name === "workspace_action" ||
      event.name === "workspace_action_result"
    ) {
      return false;
    }
  }
  return false;
}

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
  const eventBackedRunningSessionIds = useMemo(() => {
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
      if (hasPendingTurn(session, runtimeIndexes)) next.add(session.id);
    }
    if (selectedSession && hasPendingTurn(selectedSession, runtimeIndexes)) {
      next.add(selectedSession.id);
    }
    return next;
  }, [goalRunningSessionIds, runtimeIndexes, selectedSession, sidebarSessions, sessionById, subagentRuntimeBySessionId]);
  const runningSessionIds = useMemo(() => {
    const next = new Set(eventBackedRunningSessionIds);
    for (const session of sidebarSessions) {
      if (shouldShowActiveSessionStatus(session, runtimeIndexes)) next.add(session.id);
    }
    if (selectedSession && shouldShowActiveSessionStatus(selectedSession, runtimeIndexes)) {
      next.add(selectedSession.id);
    }
    return next;
  }, [eventBackedRunningSessionIds, runtimeIndexes, selectedSession, sidebarSessions]);
  const selectedSessionRunning = Boolean(
    selectedSession && !selectedSession.systemKind && eventBackedRunningSessionIds.has(selectedSession.id),
  );

  return {
    runningSessionIds,
    selectedSessionRunning,
  };
}
