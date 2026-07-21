import { useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import type { Session } from "@openpond/contracts";
import type { ClientConnection } from "../api";
import type { RightChatPanel } from "../app/app-state";
import {
  codexHistoryPayloadWithLiveStatus,
  subscribeCodexHistoryLiveRefresh,
} from "../lib/codex-history-live-refresh";
import { loadCodexHistoryThreadPayload } from "../lib/codex-history-thread-cache";
import { isCodexHistorySessionId } from "../lib/sidebar-session-projects";

export function useRightChatHistorySubscriptions(input: {
  applyPayload: (
    payload: Awaited<ReturnType<typeof loadCodexHistoryThreadPayload>>,
  ) => void;
  connection: ClientConnection | null;
  locallyActiveSessionIds: ReadonlySet<string>;
  panels: RightChatPanel[];
  sessions: Session[];
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    applyPayload,
    connection,
    locallyActiveSessionIds,
    panels,
    sessions,
    setError,
  } = input;
  const sessionKey = useMemo(() => {
    const seen = new Set<string>();
    const sessionIds: string[] = [];
    for (const panel of panels) {
      if (
        !isCodexHistorySessionId(panel.sessionId)
        || !panel.sessionId
        || seen.has(panel.sessionId)
      ) continue;
      seen.add(panel.sessionId);
      sessionIds.push(panel.sessionId);
    }
    return sessionIds.join("\n");
  }, [panels]);
  const activeSessionKey = useMemo(() => {
    if (!sessionKey) return "";
    const panelSessionIds = new Set(sessionKey.split("\n").filter(Boolean));
    return sessions
      .filter((session) => panelSessionIds.has(session.id) && session.status === "active")
      .map((session) => session.id)
      .join("\n");
  }, [sessionKey, sessions]);
  const locallyActiveSessionKey = useMemo(() => {
    if (!sessionKey) return "";
    return sessionKey
      .split("\n")
      .filter((sessionId) => locallyActiveSessionIds.has(sessionId))
      .join("\n");
  }, [locallyActiveSessionIds, sessionKey]);

  useEffect(() => {
    if (!connection || !sessionKey) return undefined;
    const sessionIds = sessionKey.split("\n").filter(Boolean);
    const reportedActiveSessionIds = new Set(activeSessionKey.split("\n").filter(Boolean));
    const localSessionIds = new Set(locallyActiveSessionKey.split("\n").filter(Boolean));
    const unsubscribers = sessionIds.map((sessionId) =>
      subscribeCodexHistoryLiveRefresh({
        connection,
        locallyActive: localSessionIds.has(sessionId),
        onError: (error) =>
          setError(error instanceof Error ? error.message : String(error)),
        onPayload: (payload) => applyPayload(
          codexHistoryPayloadWithLiveStatus(payload, localSessionIds.has(sessionId)),
        ),
        reportedActive: reportedActiveSessionIds.has(sessionId),
        sessionId,
        surface: "thread",
      }),
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [
    activeSessionKey,
    applyPayload,
    connection,
    locallyActiveSessionKey,
    sessionKey,
    setError,
  ]);
}
