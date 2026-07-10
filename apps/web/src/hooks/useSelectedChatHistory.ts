import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Approval, RuntimeEvent, Session } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import {
  cachedCodexHistoryThreadPayload,
  CODEX_HISTORY_THREAD_FULL_PAGE_LIMIT,
  CODEX_HISTORY_THREAD_MAX_EVENT_LIMIT,
  CODEX_HISTORY_THREAD_TAIL_LIMIT,
  loadCodexHistoryThreadPayload,
} from "../lib/codex-history-thread-cache";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import {
  buildRuntimeIndexes,
  runtimeEventsForSession,
} from "../lib/runtime-indexes";
import {
  latestRuntimeEventSequence,
  mergeRuntimeEventLists,
  mergeRuntimeEventsIntoSessionPageCache,
} from "../lib/runtime-event-lists";
import { upsertSessionPreservingLocalSidebarStateAndRecency } from "../lib/session-state";

type ChatHistoryLoadState = {
  cursorSequence: number | null;
  hasMore: boolean;
  loading: boolean;
  totalMatchingEvents: number | null;
};

const EMPTY_RUNTIME_EVENTS: RuntimeEvent[] = [];
const CHAT_HISTORY_PAGE_LIMIT = 500;

export function useSelectedChatHistory(input: {
  approvals: Approval[];
  codexHistoryEvents: RuntimeEvent[];
  connection: ClientConnection | null;
  latestServerSequence: number | null | undefined;
  runtimeIndexes: ReturnType<typeof buildRuntimeIndexes>;
  selectedSessionId: string | null;
  serverId: string | null | undefined;
  setCodexHistoryEvents: Dispatch<SetStateAction<RuntimeEvent[]>>;
  setCodexHistorySessions: Dispatch<SetStateAction<Session[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setEvents: Dispatch<SetStateAction<RuntimeEvent[]>>;
}) {
  const {
    approvals,
    codexHistoryEvents,
    connection,
    latestServerSequence,
    runtimeIndexes,
    selectedSessionId,
    serverId,
    setCodexHistoryEvents,
    setCodexHistorySessions,
    setError,
    setEvents,
  } = input;
  const [pagedSessionEvents, setPagedSessionEvents] = useState<Record<string, RuntimeEvent[]>>({});
  const [chatHistoryLoadStates, setChatHistoryLoadStates] = useState<
    Record<string, ChatHistoryLoadState>
  >({});
  const chatHistoryLoadingSessionIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setPagedSessionEvents({});
    setChatHistoryLoadStates({});
    chatHistoryLoadingSessionIdsRef.current.clear();
  }, [serverId]);

  const loadMoreSelectedChatHistory = useCallback(async () => {
    if (!connection || !selectedSessionId) return false;
    if (chatHistoryLoadingSessionIdsRef.current.has(selectedSessionId)) return false;
    const currentState = chatHistoryLoadStates[selectedSessionId];
    if (currentState?.hasMore === false) return false;

    if (isCodexHistorySessionId(selectedSessionId)) {
      const currentLimit = Math.max(
        currentState?.totalMatchingEvents ?? 0,
        codexHistoryEvents.length,
        CODEX_HISTORY_THREAD_TAIL_LIMIT,
      );
      const nextLimit = Math.min(
        CODEX_HISTORY_THREAD_MAX_EVENT_LIMIT,
        Math.max(CODEX_HISTORY_THREAD_FULL_PAGE_LIMIT, currentLimit * 2),
      );

      chatHistoryLoadingSessionIdsRef.current.add(selectedSessionId);
      setChatHistoryLoadStates((current) => ({
        ...current,
        [selectedSessionId]: {
          cursorSequence: null,
          hasMore: true,
          loading: true,
          totalMatchingEvents:
            current[selectedSessionId]?.totalMatchingEvents ?? codexHistoryEvents.length,
        },
      }));

      try {
        const payload = await loadCodexHistoryThreadPayload(connection, selectedSessionId, {
          force: true,
          limit: nextLimit,
          tail: false,
        });
        setCodexHistoryEvents(payload.events);
        setCodexHistorySessions((current) =>
          upsertSessionPreservingLocalSidebarStateAndRecency(current, payload.session),
        );
        setChatHistoryLoadStates((current) => ({
          ...current,
          [selectedSessionId]: {
            cursorSequence: null,
            hasMore:
              payload.events.length >= nextLimit &&
              nextLimit < CODEX_HISTORY_THREAD_MAX_EVENT_LIMIT,
            loading: false,
            totalMatchingEvents: nextLimit,
          },
        }));
        return payload.events.length > codexHistoryEvents.length;
      } catch (historyError) {
        setError(historyError instanceof Error ? historyError.message : String(historyError));
        setChatHistoryLoadStates((current) => ({
          ...current,
          [selectedSessionId]: {
            cursorSequence: null,
            hasMore: current[selectedSessionId]?.hasMore ?? true,
            loading: false,
            totalMatchingEvents:
              current[selectedSessionId]?.totalMatchingEvents ?? codexHistoryEvents.length,
          },
        }));
        return false;
      } finally {
        chatHistoryLoadingSessionIdsRef.current.delete(selectedSessionId);
      }
    }

    const currentSessionEvents = mergeRuntimeEventLists(
      pagedSessionEvents[selectedSessionId] ?? EMPTY_RUNTIME_EVENTS,
      runtimeEventsForSession(runtimeIndexes, selectedSessionId),
    );
    const beforeSequence =
      currentState?.cursorSequence ?? oldestRuntimeEventSequence(currentSessionEvents);
    if (!beforeSequence) return false;

    chatHistoryLoadingSessionIdsRef.current.add(selectedSessionId);
    setChatHistoryLoadStates((current) => ({
      ...current,
      [selectedSessionId]: {
        cursorSequence: current[selectedSessionId]?.cursorSequence ?? beforeSequence,
        hasMore: current[selectedSessionId]?.hasMore ?? true,
        loading: true,
        totalMatchingEvents: current[selectedSessionId]?.totalMatchingEvents ?? null,
      },
    }));

    try {
      const page = await api.runtimeEventsPage(connection, {
        sessionId: selectedSessionId,
        beforeSequence,
        limit: CHAT_HISTORY_PAGE_LIMIT,
      });
      const pageEvents = page.events.map((entry) => entry.event);
      setPagedSessionEvents((current) => ({
        ...current,
        [selectedSessionId]: mergeRuntimeEventLists(
          pageEvents,
          current[selectedSessionId] ?? EMPTY_RUNTIME_EVENTS,
        ),
      }));
      setChatHistoryLoadStates((current) => ({
        ...current,
        [selectedSessionId]: {
          cursorSequence: page.previousSequence,
          hasMore: page.hasMore,
          loading: false,
          totalMatchingEvents: page.totalMatchingEvents,
        },
      }));
      return pageEvents.length > 0;
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : String(historyError));
      setChatHistoryLoadStates((current) => ({
        ...current,
        [selectedSessionId]: {
          cursorSequence: current[selectedSessionId]?.cursorSequence ?? beforeSequence,
          hasMore: current[selectedSessionId]?.hasMore ?? true,
          loading: false,
          totalMatchingEvents: current[selectedSessionId]?.totalMatchingEvents ?? null,
        },
      }));
      return false;
    } finally {
      chatHistoryLoadingSessionIdsRef.current.delete(selectedSessionId);
    }
  }, [
    chatHistoryLoadStates,
    codexHistoryEvents.length,
    connection,
    pagedSessionEvents,
    runtimeIndexes,
    selectedSessionId,
    setCodexHistoryEvents,
    setCodexHistorySessions,
    setError,
  ]);

  const selectedPagedSessionEvents = selectedSessionId
    ? (pagedSessionEvents[selectedSessionId] ?? EMPTY_RUNTIME_EVENTS)
    : EMPTY_RUNTIME_EVENTS;
  const selectedRuntimeEventCount = useMemo(
    () => runtimeEventsForSession(runtimeIndexes, selectedSessionId).length,
    [runtimeIndexes, selectedSessionId],
  );
  const selectedForwardEventSyncKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!connection || !selectedSessionId || isCodexHistorySessionId(selectedSessionId))
      return undefined;
    if (chatHistoryLoadingSessionIdsRef.current.has(selectedSessionId)) return undefined;
    if (selectedPagedSessionEvents.length > 0 || selectedRuntimeEventCount > 0) return undefined;

    const latestSequence = latestServerSequence;
    if (!latestSequence) return undefined;

    const historySessionId = selectedSessionId;
    const beforeSequence = latestSequence + 1;
    chatHistoryLoadingSessionIdsRef.current.add(historySessionId);
    setChatHistoryLoadStates((current) => ({
      ...current,
      [historySessionId]: {
        cursorSequence: current[historySessionId]?.cursorSequence ?? beforeSequence,
        hasMore: current[historySessionId]?.hasMore ?? true,
        loading: true,
        totalMatchingEvents: current[historySessionId]?.totalMatchingEvents ?? null,
      },
    }));

    void api
      .runtimeEventsPage(connection, {
        sessionId: historySessionId,
        beforeSequence,
        limit: CHAT_HISTORY_PAGE_LIMIT,
      })
      .then((page) => {
        const pageEvents = page.events.map((entry) => entry.event);
        setPagedSessionEvents((current) => ({
          ...current,
          [historySessionId]: mergeRuntimeEventLists(
            pageEvents,
            current[historySessionId] ?? EMPTY_RUNTIME_EVENTS,
          ),
        }));
        setChatHistoryLoadStates((current) => ({
          ...current,
          [historySessionId]: {
            cursorSequence: page.previousSequence,
            hasMore: page.hasMore,
            loading: false,
            totalMatchingEvents: page.totalMatchingEvents,
          },
        }));
      })
      .catch((historyError) => {
        setError(historyError instanceof Error ? historyError.message : String(historyError));
        setChatHistoryLoadStates((current) => ({
          ...current,
          [historySessionId]: {
            cursorSequence: current[historySessionId]?.cursorSequence ?? beforeSequence,
            hasMore: current[historySessionId]?.hasMore ?? true,
            loading: false,
            totalMatchingEvents: current[historySessionId]?.totalMatchingEvents ?? null,
          },
        }));
      })
      .finally(() => {
        chatHistoryLoadingSessionIdsRef.current.delete(historySessionId);
      });

    return undefined;
  }, [
    latestServerSequence,
    connection,
    selectedPagedSessionEvents.length,
    selectedRuntimeEventCount,
    selectedSessionId,
    setError,
  ]);
  useEffect(() => {
    if (!connection || !selectedSessionId || isCodexHistorySessionId(selectedSessionId))
      return undefined;
    if (chatHistoryLoadingSessionIdsRef.current.has(selectedSessionId)) return undefined;
    if (!latestServerSequence) return undefined;

    const selectedEvents = mergeRuntimeEventLists(
      selectedPagedSessionEvents,
      runtimeEventsForSession(runtimeIndexes, selectedSessionId),
    );
    const latestSelectedSequence = latestRuntimeEventSequence(selectedEvents);
    if (!latestSelectedSequence || latestSelectedSequence >= latestServerSequence) return undefined;

    const syncKey = `${selectedSessionId}:${latestSelectedSequence}:${latestServerSequence}`;
    if (selectedForwardEventSyncKeyRef.current === syncKey) return undefined;
    selectedForwardEventSyncKeyRef.current = syncKey;

    let cancelled = false;
    void api
      .runtimeEventsPage(connection, {
        sessionId: selectedSessionId,
        afterSequence: latestSelectedSequence,
        limit: CHAT_HISTORY_PAGE_LIMIT,
      })
      .then((page) => {
        if (cancelled) return;
        const pageEvents = page.events.map((entry) => entry.event);
        if (pageEvents.length === 0) return;
        setPagedSessionEvents((current) =>
          mergeRuntimeEventsIntoSessionPageCache(current, selectedSessionId, pageEvents),
        );
      })
      .catch((historyError) => {
        if (cancelled) return;
        selectedForwardEventSyncKeyRef.current = null;
        setError(historyError instanceof Error ? historyError.message : String(historyError));
      });

    return () => {
      cancelled = true;
    };
  }, [
    latestServerSequence,
    connection,
    runtimeIndexes,
    selectedPagedSessionEvents,
    selectedSessionId,
    setError,
  ]);
  const selectedRuntimeIndexes = useMemo(() => {
    if (isCodexHistorySessionId(selectedSessionId))
      return buildRuntimeIndexes(codexHistoryEvents, []);
    if (!selectedSessionId || selectedPagedSessionEvents.length === 0) return runtimeIndexes;
    return buildRuntimeIndexes(
      mergeRuntimeEventLists(
        selectedPagedSessionEvents,
        runtimeEventsForSession(runtimeIndexes, selectedSessionId),
      ),
      approvals,
    );
  }, [
    approvals,
    codexHistoryEvents,
    runtimeIndexes,
    selectedPagedSessionEvents,
    selectedSessionId,
  ]);

  return {
    chatHistoryLoadStates,
    loadMoreSelectedChatHistory,
    selectedPagedSessionEvents,
    selectedRuntimeIndexes,
  };
}

function oldestRuntimeEventSequence(events: RuntimeEvent[]): number | null {
  let oldest: number | null = null;
  for (const event of events) {
    if (event.sequence === undefined) continue;
    if (oldest === null || event.sequence < oldest) oldest = event.sequence;
  }
  return oldest;
}
