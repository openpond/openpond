import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { Approval, RuntimeEvent, Session } from "@openpond/contracts";
import type { ClientConnection } from "../api";
import {
  activeGoalRuntimeFromSessionMetadata,
  latestGoalRuntimeFromEvents,
  latestKnownActiveGoalRuntimeFromEvents,
  projectGoalRuntimeTo,
} from "../lib/goal-runtime";
import { latestCreateImproveRuntimeFromEvents } from "../lib/create-pipeline-runtime";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import { upsertSessionPreservingLocalSidebarStateAndRecency } from "../lib/session-state";
import { SIDEBAR_SECTION_LIMIT } from "../lib/app-models";
import { latestSubagentRuntimeFromEvents } from "../lib/subagent-runtime";
import { latestTurnCompletionState } from "../lib/turn-completion-state";
import { buildRuntimeIndexes } from "../lib/runtime-indexes";
import { useRunningSessionState } from "./useRunningSessionState";
import type { useSidebarData } from "./useSidebarData";
import {
  codexHistoryPayloadWithLiveStatus,
  subscribeCodexHistoryLiveRefresh,
} from "../lib/codex-history-live-refresh";
import { useGoalRuntimeClock } from "./useGoalRuntimeClock";

export function useSidebarRuntimeState(input: {
  codexHistoryEvents: RuntimeEvent[];
  codexHistorySessions: Session[];
  connection: ClientConnection | null;
  expandedProjectIds: ReadonlySet<string>;
  goalRuntime: ReturnType<typeof latestGoalRuntimeFromEvents>;
  locallyActiveCodexHistorySessionIds: ReadonlySet<string>;
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
    locallyActiveCodexHistorySessionIds,
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

    for (const session of codexHistorySessions) {
      if (session.status === "active" || locallyActiveCodexHistorySessionIds.has(session.id)) {
        addSession(session);
      }
    }
    const activeCount = ids.length;

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

    return [...ids.slice(0, activeCount), ...ids.slice(activeCount, activeCount + 8)].join("\n");
  }, [
    codexHistorySessions,
    expandedProjectIds,
    locallyActiveCodexHistorySessionIds,
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
  const codexHistoryPrefetchActiveSessionKey = useMemo(() => {
    if (!codexHistoryPrefetchSessionKey) return "";
    const prefetchedIds = new Set(codexHistoryPrefetchSessionKey.split("\n").filter(Boolean));
    return sidebarSessions
      .filter((session) => prefetchedIds.has(session.id) && session.status === "active")
      .map((session) => session.id)
      .join("\n");
  }, [codexHistoryPrefetchSessionKey, sidebarSessions]);
  const codexHistoryPrefetchLocallyActiveSessionKey = useMemo(() => {
    if (!codexHistoryPrefetchSessionKey) return "";
    return codexHistoryPrefetchSessionKey
      .split("\n")
      .filter((sessionId) => locallyActiveCodexHistorySessionIds.has(sessionId))
      .join("\n");
  }, [codexHistoryPrefetchSessionKey, locallyActiveCodexHistorySessionIds]);
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
    const prefetchConnection = connection;
    const sessionIds = codexHistoryPrefetchSessionKey.split("\n").filter(Boolean);
    const reportedActiveSessionIds = new Set(
      codexHistoryPrefetchActiveSessionKey.split("\n").filter(Boolean),
    );
    const locallyActiveSessionIds = new Set(
      codexHistoryPrefetchLocallyActiveSessionKey.split("\n").filter(Boolean),
    );

    const unsubscribers = sessionIds.map((sessionId) =>
      subscribeCodexHistoryLiveRefresh({
        connection: prefetchConnection,
        locallyActive: locallyActiveSessionIds.has(sessionId),
        onPayload: (payload) =>
          applySidebarCodexHistoryPayload(
            codexHistoryPayloadWithLiveStatus(
              payload,
              locallyActiveSessionIds.has(sessionId),
            ),
          ),
        reportedActive: reportedActiveSessionIds.has(sessionId),
        sessionId,
        surface: "sidebar",
      }),
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [
    applySidebarCodexHistoryPayload,
    codexHistoryPrefetchActiveSessionKey,
    codexHistoryPrefetchLocallyActiveSessionKey,
    codexHistoryPrefetchSessionKey,
    connection,
  ]);
  const sidebarSessionById = useMemo(
    () => new Map(sidebarSessions.map((session) => [session.id, session])),
    [sidebarSessions],
  );
  const baseSidebarGoalRuntimeBySessionId = useMemo(() => {
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
          latestCreateImproveRuntimeFromEvents(historyEvents) ??
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
          latestCreateImproveRuntimeFromEvents(codexHistoryEvents) ??
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
  const hasLiveGoalRuntime = useMemo(
    () => [...baseSidebarGoalRuntimeBySessionId.values()].some(
      (runtime) => runtime.tone === "active" && Boolean(runtime.observedAt),
    ),
    [baseSidebarGoalRuntimeBySessionId],
  );
  const goalRuntimeObservedAt = useGoalRuntimeClock(hasLiveGoalRuntime);
  const sidebarGoalRuntimeBySessionId = useMemo(() => {
    if (!hasLiveGoalRuntime) return baseSidebarGoalRuntimeBySessionId;
    return new Map(
      [...baseSidebarGoalRuntimeBySessionId].map(([sessionId, runtime]) => [
        sessionId,
        projectGoalRuntimeTo(runtime, goalRuntimeObservedAt) ?? runtime,
      ]),
    );
  }, [baseSidebarGoalRuntimeBySessionId, goalRuntimeObservedAt, hasLiveGoalRuntime]);
  const liveGoalRuntime = selectedSessionId
    ? (sidebarGoalRuntimeBySessionId.get(selectedSessionId) ?? goalRuntime)
    : goalRuntime;
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
    goalRuntime: liveGoalRuntime,
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
    goalRuntime: liveGoalRuntime,
    runningSessionIds,
    selectedSessionRunning,
    selectedSteerAutoDispatchBlocked,
    selectedSteerAutoDispatchReady,
    sidebarGoalRuntimeBySessionId,
    sidebarSubagentRuntimeBySessionId,
  };
}
