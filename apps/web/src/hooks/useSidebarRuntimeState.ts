import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { Approval, RuntimeEvent, Session } from "@openpond/contracts";
import type { ClientConnection } from "../api";
import {
  cachedCodexHistoryThreadPayload,
  loadCodexHistoryThreadPayload,
} from "../lib/codex-history-thread-cache";
import {
  activeGoalRuntimeFromSessionMetadata,
  latestGoalRuntimeFromEvents,
  latestKnownActiveGoalRuntimeFromEvents,
} from "../lib/goal-runtime";
import { latestCreatePipelineRuntimeFromEvents } from "../lib/create-pipeline-runtime";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import { upsertSessionPreservingLocalSidebarStateAndRecency } from "../lib/session-state";
import { SIDEBAR_SECTION_LIMIT } from "../lib/app-models";
import { latestSubagentRuntimeFromEvents } from "../lib/subagent-runtime";
import { latestTurnCompletionState } from "../lib/turn-completion-state";
import { buildRuntimeIndexes } from "../lib/runtime-indexes";
import { useRunningSessionState } from "./useRunningSessionState";
import type { useSidebarData } from "./useSidebarData";

export function useSidebarRuntimeState(input: {
  codexHistoryEvents: RuntimeEvent[];
  codexHistorySessions: Session[];
  connection: ClientConnection | null;
  expandedProjectIds: ReadonlySet<string>;
  goalRuntime: ReturnType<typeof latestGoalRuntimeFromEvents>;
  pendingApproval: Approval | null;
  pinnedSessions: ReturnType<typeof useSidebarData>["pinnedSessions"];
  projectSessionRowsByProjectId: ReturnType<typeof useSidebarData>["projectSessionRowsByProjectId"];
  rightChatHistoryEvents: Record<string, RuntimeEvent[]>;
  runtimeIndexes: ReturnType<typeof buildRuntimeIndexes>;
  selectedSession: Session | null;
  selectedSessionId: string | null;
  serverId: string | null | undefined;
  sessionEvents: RuntimeEvent[];
  setCodexHistorySessions: Dispatch<SetStateAction<Session[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  sidebarSessions: Session[];
  subagentRuntime: ReturnType<typeof latestSubagentRuntimeFromEvents>;
  visibleChatRows: ReturnType<typeof useSidebarData>["visibleChatRows"];
  visibleProjectRows: ReturnType<typeof useSidebarData>["visibleProjectRows"];
}) {
  const {
    codexHistoryEvents,
    codexHistorySessions,
    connection,
    expandedProjectIds,
    goalRuntime,
    pendingApproval,
    pinnedSessions,
    projectSessionRowsByProjectId,
    rightChatHistoryEvents,
    runtimeIndexes,
    selectedSession,
    selectedSessionId,
    serverId,
    sessionEvents,
    setCodexHistorySessions,
    setError,
    sidebarSessions,
    subagentRuntime,
    visibleChatRows,
    visibleProjectRows,
  } = input;
  const [codexHistorySidebarEvents, setCodexHistorySidebarEvents] = useState<
    Record<string, RuntimeEvent[]>
  >({});

  useEffect(() => {
    setCodexHistorySidebarEvents({});
  }, [serverId]);

  const codexHistoryPrefetchSessionKey = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    const addSession = (session: { id: string } | null | undefined) => {
      if (
        !session ||
        session.id === selectedSessionId ||
        !isCodexHistorySessionId(session.id) ||
        seen.has(session.id)
      ) {
        return;
      }
      seen.add(session.id);
      ids.push(session.id);
    };

    for (const item of visibleProjectRows) {
      for (const session of (projectSessionRowsByProjectId[item.id] ?? []).slice(0, 2)) {
        addSession(session);
      }
    }

    for (const projectId of expandedProjectIds) {
      for (const session of (projectSessionRowsByProjectId[projectId] ?? []).slice(
        0,
        SIDEBAR_SECTION_LIMIT,
      )) {
        addSession(session);
      }
    }

    for (const session of pinnedSessions) addSession(session);
    for (const session of visibleChatRows) addSession(session);

    return ids.slice(0, 8).join("\n");
  }, [
    expandedProjectIds,
    pinnedSessions,
    projectSessionRowsByProjectId,
    selectedSessionId,
    visibleChatRows,
    visibleProjectRows,
  ]);
  const applySidebarCodexHistoryPayload = useCallback(
    (payload: { session: Session; events: RuntimeEvent[] }) => {
      setCodexHistorySidebarEvents((current) =>
        current[payload.session.id] === payload.events
          ? current
          : { ...current, [payload.session.id]: payload.events },
      );
      setCodexHistorySessions((current) =>
        upsertSessionPreservingLocalSidebarStateAndRecency(current, payload.session),
      );
    },
    [setCodexHistorySessions],
  );
  useEffect(() => {
    if (
      !selectedSession ||
      !selectedSessionId ||
      !isCodexHistorySessionId(selectedSessionId) ||
      codexHistoryEvents.length === 0
    ) {
      return;
    }
    applySidebarCodexHistoryPayload({
      session: selectedSession,
      events: codexHistoryEvents,
    });
  }, [applySidebarCodexHistoryPayload, codexHistoryEvents, selectedSession, selectedSessionId]);
  useEffect(() => {
    if (!connection || !codexHistoryPrefetchSessionKey) return undefined;
    let cancelled = false;
    const timers: number[] = [];
    const prefetchConnection = connection;
    const sessionIds = codexHistoryPrefetchSessionKey.split("\n").filter(Boolean);

    const loadSidebarThread = (sessionId: string) => {
      void loadCodexHistoryThreadPayload(prefetchConnection, sessionId)
        .then((payload) => {
          if (cancelled) return;
          applySidebarCodexHistoryPayload(payload);
        })
        .catch(() => undefined);
    };

    sessionIds.forEach((sessionId, index) => {
      const prefetch = () => {
        const cachedPayload = cachedCodexHistoryThreadPayload(prefetchConnection, sessionId);
        if (cachedPayload) applySidebarCodexHistoryPayload(cachedPayload);
        if (!cachedPayload) loadSidebarThread(sessionId);
      };
      if (index === 0) {
        prefetch();
      } else {
        timers.push(window.setTimeout(prefetch, Math.min(index * 250, 1000)));
      }
    });

    return () => {
      cancelled = true;
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [applySidebarCodexHistoryPayload, codexHistoryPrefetchSessionKey, connection]);
  const sidebarSessionById = useMemo(
    () => new Map(sidebarSessions.map((session) => [session.id, session])),
    [sidebarSessions],
  );
  const sidebarGoalRuntimeBySessionId = useMemo(() => {
    const next = new Map(runtimeIndexes.latestGoalRuntimeBySessionId);
    for (const session of sidebarSessions) {
      const metadataGoalRuntime =
        session.status === "active" ? activeGoalRuntimeFromSessionMetadata(session.metadata) : null;
      if (metadataGoalRuntime) next.set(session.id, metadataGoalRuntime);
    }
    for (const historyEventsBySessionId of [codexHistorySidebarEvents, rightChatHistoryEvents]) {
      for (const [sessionId, historyEvents] of Object.entries(historyEventsBySessionId)) {
        const historySession = sidebarSessionById.get(sessionId);
        const metadataGoalRuntime =
          historySession?.status === "active"
            ? activeGoalRuntimeFromSessionMetadata(historySession.metadata)
            : null;
        const historyGoalRuntime =
          latestCreatePipelineRuntimeFromEvents(historyEvents) ??
          latestGoalRuntimeFromEvents(historyEvents) ??
          (historySession?.status === "active"
            ? (latestKnownActiveGoalRuntimeFromEvents(historyEvents) ?? metadataGoalRuntime)
            : null);
        if (historyGoalRuntime) {
          next.set(sessionId, historyGoalRuntime);
        } else {
          next.delete(sessionId);
        }
      }
    }
    if (selectedSessionId) {
      if (goalRuntime) {
        next.set(selectedSessionId, goalRuntime);
      } else if (selectedSession?.status === "active" && codexHistoryEvents.length > 0) {
        const knownActiveGoalRuntime =
          latestCreatePipelineRuntimeFromEvents(codexHistoryEvents) ??
          latestKnownActiveGoalRuntimeFromEvents(codexHistoryEvents) ??
          activeGoalRuntimeFromSessionMetadata(selectedSession.metadata);
        if (knownActiveGoalRuntime) {
          next.set(selectedSessionId, knownActiveGoalRuntime);
        } else {
          next.delete(selectedSessionId);
        }
      } else if (!isCodexHistorySessionId(selectedSessionId) || codexHistoryEvents.length > 0) {
        next.delete(selectedSessionId);
      }
    }
    return next;
  }, [
    codexHistoryEvents.length,
    codexHistorySidebarEvents,
    goalRuntime,
    rightChatHistoryEvents,
    runtimeIndexes.latestGoalRuntimeBySessionId,
    selectedSession?.status,
    selectedSession?.metadata,
    selectedSessionId,
    sidebarSessionById,
    sidebarSessions,
  ]);
  const sidebarSubagentRuntimeBySessionId = useMemo(() => {
    const next = new Map(runtimeIndexes.latestSubagentRuntimeBySessionId);
    if (selectedSessionId) {
      if (subagentRuntime) {
        next.set(selectedSessionId, subagentRuntime);
      } else {
        next.delete(selectedSessionId);
      }
    }
    return next;
  }, [runtimeIndexes.latestSubagentRuntimeBySessionId, selectedSessionId, subagentRuntime]);
  const { runningSessionIds, selectedSessionRunning } = useRunningSessionState({
    goalRuntime,
    goalRuntimeBySessionId: sidebarGoalRuntimeBySessionId,
    runtimeIndexes,
    selectedSession,
    selectedSessionId,
    sidebarSessions,
    subagentRuntimeBySessionId: sidebarSubagentRuntimeBySessionId,
  });
  const selectedTurnCompletionState = useMemo(
    () => latestTurnCompletionState(sessionEvents),
    [sessionEvents],
  );
  const selectedSteerAutoDispatchReady =
    selectedTurnCompletionState === "completed" && !pendingApproval && !selectedSessionRunning;
  const selectedSteerAutoDispatchBlocked =
    Boolean(pendingApproval) || selectedTurnCompletionState === "blocked";

  return {
    runningSessionIds,
    selectedSessionRunning,
    selectedSteerAutoDispatchBlocked,
    selectedSteerAutoDispatchReady,
    sidebarGoalRuntimeBySessionId,
    sidebarSubagentRuntimeBySessionId,
  };
}
