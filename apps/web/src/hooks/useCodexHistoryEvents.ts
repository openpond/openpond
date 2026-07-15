import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import type { ClientConnection } from "../api";
import type { CodexHistoryThreadPayload } from "../lib/codex-history-thread-cache";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";
import { upsertSessionPreservingLocalSidebarStateAndRecency } from "../lib/session-state";
import {
  codexHistoryPayloadWithLiveStatus,
  subscribeCodexHistoryLiveRefresh,
} from "../lib/codex-history-live-refresh";

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
  const [codexHistoryEvents, setCodexHistoryEvents] = useState<RuntimeEvent[]>([]);

  useEffect(() => {
    if (!connection || !isCodexHistorySessionId(selectedSessionId)) {
      setCodexHistoryEvents([]);
      return undefined;
    }

    const historySessionId = selectedSessionId;
    if (!historySessionId) return undefined;
    setError((current) => (current === "Session not found" ? null : current));
    const locallyActive = selectedSessionLocallyActive;

    const applyPayload = (payload: CodexHistoryThreadPayload) => {
      const livePayload = codexHistoryPayloadWithLiveStatus(payload, locallyActive);
      setCodexHistoryEvents(livePayload.events);
      setError((current) => (current === "Session not found" ? null : current));
      setCodexHistorySessions((current) =>
        upsertSessionPreservingLocalSidebarStateAndRecency(current, livePayload.session),
      );
    };

    setCodexHistoryEvents([]);
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
    selectedSessionId,
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
