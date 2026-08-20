import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import type { ClientConnection } from "../api";
import type { CodexHistoryThreadPayload } from "../lib/codex-history-thread-cache";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import { upsertSessionPreservingLocalSidebarStateAndRecency } from "../lib/session-state";
import {
  codexHistoryPayloadWithLiveStatus,
  subscribeCodexHistoryLiveRefresh,
} from "../lib/codex-history-live-refresh";
import { mergeLiveRuntimeEventLists } from "../lib/runtime-event-lists";

export function useCodexHistoryEvents({
  connection,
  selectedSessionId,
  selectedSessionLocallyActive,
  selectedSessionStatus,
  setCodexHistorySessions,
  setError,
}: {
  connection: ClientConnection | null;
  selectedSessionId: string | null;
  selectedSessionLocallyActive: boolean;
  selectedSessionStatus: Session["status"] | null | undefined;
  setCodexHistorySessions: Dispatch<SetStateAction<Session[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const [historyState, setHistoryState] = useState<{
    events: RuntimeEvent[];
    sessionId: string | null;
  }>({ events: [], sessionId: null });
  const historySessionId = isCodexHistorySessionId(selectedSessionId)
    ? selectedSessionId
    : null;
  const codexHistoryEvents =
    historySessionId && historyState.sessionId === historySessionId
      ? historyState.events
      : [];
  const setCodexHistoryEvents = useCallback<
    Dispatch<SetStateAction<RuntimeEvent[]>>
  >(
    (action) => {
      setHistoryState((current) => {
        if (!historySessionId) return { events: [], sessionId: null };
        const currentEvents =
          current.sessionId === historySessionId ? current.events : [];
        const events =
          typeof action === "function" ? action(currentEvents) : action;
        return { events, sessionId: historySessionId };
      });
    },
    [historySessionId],
  );

  useEffect(() => {
    if (!connection || !historySessionId) {
      setHistoryState((current) =>
        current.sessionId === null && current.events.length === 0
          ? current
          : { events: [], sessionId: null },
      );
      return undefined;
    }

    setError((current) => (current === "Session not found" ? null : current));
    const locallyActive = selectedSessionLocallyActive;

    const applyPayload = (payload: CodexHistoryThreadPayload) => {
      const livePayload = codexHistoryPayloadWithLiveStatus(payload, locallyActive);
      setHistoryState((current) => {
        if (current.sessionId !== historySessionId) {
          return { events: livePayload.events, sessionId: historySessionId };
        }
        return {
          events: mergeLiveRuntimeEventLists(current.events, livePayload.events),
          sessionId: historySessionId,
        };
      });
      setError((current) => (current === "Session not found" ? null : current));
      setCodexHistorySessions((current) =>
        upsertSessionPreservingLocalSidebarStateAndRecency(current, livePayload.session),
      );
    };

    return subscribeCodexHistoryLiveRefresh({
      connection,
      locallyActive,
      onError: (historyError) =>
        setError(historyError instanceof Error ? historyError.message : String(historyError)),
      onPayload: applyPayload,
      reportedActive: selectedSessionStatus === "active",
      sessionId: historySessionId,
      surface: "thread",
    });
  }, [
    connection,
    historySessionId,
    selectedSessionLocallyActive,
    selectedSessionStatus,
    setCodexHistorySessions,
    setError,
  ]);

  return {
    codexHistoryEvents,
    setCodexHistoryEvents,
  };
}
