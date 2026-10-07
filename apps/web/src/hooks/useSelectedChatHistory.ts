import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Approval, RuntimeEvent, Session } from "@openpond/contracts";
import { api, type ClientConnection } from "../api";
import {
  CODEX_HISTORY_THREAD_FULL_PAGE_LIMIT,
  CODEX_HISTORY_THREAD_MAX_EVENT_LIMIT,
  CODEX_HISTORY_THREAD_TAIL_LIMIT,
  loadCodexHistoryThreadPayload,
} from "../lib/codex-history-thread-cache";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import {
  buildRuntimeIndexes,
} from "../lib/runtime-indexes";
import type { RuntimeEventStore } from "../lib/runtime-event-store";
import {
  mergeRuntimeEventLists,
} from "../lib/runtime-event-lists";
import { upsertSessionPreservingLocalSidebarStateAndRecency } from "../lib/session-state";
import { createSessionEventSync } from "../lib/session-event-sync";

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
  runtimeIndexes: ReturnType<typeof buildRuntimeIndexes>;
  runtimeEventStore: RuntimeEventStore;
  selectedSessionId: string | null;
  serverId: string | null | undefined;
  setCodexHistoryEvents: Dispatch<SetStateAction<RuntimeEvent[]>>;
  setCodexHistorySessions: Dispatch<SetStateAction<Session[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    approvals,
    codexHistoryEvents,
    connection,
    runtimeIndexes,
    runtimeEventStore,
    selectedSessionId,
    serverId,
    setCodexHistoryEvents,
    setCodexHistorySessions,
    setError,
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
      runtimeEventStore.getSessionEvents(selectedSessionId),
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
    runtimeEventStore,
    selectedSessionId,
    setCodexHistoryEvents,
    setCodexHistorySessions,
    setError,
  ]);

  const selectedPagedSessionEvents = selectedSessionId
    ? (pagedSessionEvents[selectedSessionId] ?? EMPTY_RUNTIME_EVENTS)
    : EMPTY_RUNTIME_EVENTS;
  useEffect(() => {
    if (!connection || !selectedSessionId || isCodexHistorySessionId(selectedSessionId)) return;
    const historySessionId = selectedSessionId;
    const sync = createSessionEventSync({
      sessionId: historySessionId,
      store: runtimeEventStore,
      fetchPage: (request) => api.runtimeEventsPage(connection, request),
      onPage: (page, initial) => {
        if (!initial) return;
        setChatHistoryLoadStates((current) => {
          const prior = current[historySessionId];
          const hasOlderPage = prior?.cursorSequence != null && prior.cursorSequence < page.previousSequence;
          return { ...current, [historySessionId]: {
            cursorSequence: hasOlderPage ? prior.cursorSequence : page.previousSequence,
            hasMore: hasOlderPage ? prior.hasMore : page.hasMore,
            loading: prior?.loading ?? false,
            totalMatchingEvents: page.totalMatchingEvents,
          } };
        });
      },
      onError: (error) => setError(error instanceof Error ? error.message : String(error)),
    });
    const refresh = () => { if (document.visibilityState === "visible") void sync.refresh(); };
    void sync.refresh();
    // A task can outlive a disconnected or suspended renderer. Reconcile its
    // persisted events even when the global stream still appears connected.
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("openpond-runtime-connected", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      sync.close();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("openpond-runtime-connected", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [connection, runtimeEventStore, selectedSessionId, serverId, setError]);
  const selectedRuntimeIndexes = useMemo(() => {
    if (isCodexHistorySessionId(selectedSessionId))
      return buildRuntimeIndexes(codexHistoryEvents, []);
    if (!selectedSessionId || selectedPagedSessionEvents.length === 0) return runtimeIndexes;
    return buildRuntimeIndexes(
      mergeRuntimeEventLists(
        selectedPagedSessionEvents,
        runtimeEventStore.getSessionEvents(selectedSessionId),
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
