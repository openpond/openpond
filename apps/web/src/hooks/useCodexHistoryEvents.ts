import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import type { ClientConnection } from "../api";
import {
  cachedCodexHistoryThreadPayload,
  loadCodexHistoryThreadPayload,
  type CodexHistoryThreadPayload,
} from "../lib/codex-history-thread-cache";
import { latestGoalRuntimeFromEvents } from "../lib/goal-runtime";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import { upsertSessionPreservingLocalSidebarStateAndRecency } from "../lib/session-state";

export function useCodexHistoryEvents({
  connection,
  selectedSessionId,
  setCodexHistorySessions,
  setError,
}: {
  connection: ClientConnection | null;
  selectedSessionId: string | null;
  setCodexHistorySessions: Dispatch<SetStateAction<Session[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const [codexHistoryEvents, setCodexHistoryEvents] = useState<RuntimeEvent[]>([]);

  useEffect(() => {
    if (!connection || !isCodexHistorySessionId(selectedSessionId)) {
      setCodexHistoryEvents([]);
      return undefined;
    }

    const historySessionId = selectedSessionId;
    if (!historySessionId) return undefined;
    setError((current) => (current === "Session not found" ? null : current));
    let cancelled = false;
    let refreshTimer: number | null = null;
    let loadedThread = false;

    const applyPayload = (payload: CodexHistoryThreadPayload) => {
      setCodexHistoryEvents(payload.events);
      setError((current) => (current === "Session not found" ? null : current));
      setCodexHistorySessions((current) =>
        upsertSessionPreservingLocalSidebarStateAndRecency(current, payload.session),
      );
    };

    const cachedPayload = cachedCodexHistoryThreadPayload(connection, historySessionId);
    if (cachedPayload) {
      loadedThread = true;
      applyPayload(cachedPayload);
    } else {
      setCodexHistoryEvents([]);
    }

    const loadThread = async () => {
      try {
        const payload = await loadCodexHistoryThreadPayload(connection, historySessionId, {
          force: loadedThread,
        });
        if (cancelled) return;
        loadedThread = true;
        applyPayload(payload);
        if (payload.session.status === "active" || latestGoalRuntimeFromEvents(payload.events)?.tone === "active") {
          refreshTimer = window.setTimeout(loadThread, 2500);
        }
      } catch (historyError) {
        if (!cancelled) setError(historyError instanceof Error ? historyError.message : String(historyError));
      }
    };

    void loadThread();
    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [connection, selectedSessionId, setCodexHistorySessions, setError]);

  return {
    codexHistoryEvents,
    setCodexHistoryEvents,
  };
}
