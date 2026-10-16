import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { api } from "../../api";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { connectionQueryScope } from "../../lib/query-scope";
import { IncrementalChatProjector } from "../../lib/incremental-chat-projector";
import { usePonderSession } from "./usePonderSession";

const EMPTY_EVENTS: RuntimeEvent[] = [];

/** Native transcripts use their provider acquisition path; inspection never launches a turn. */
export function useAgentTranscript(connection: ClientConnection, session?: Session) {
  const codexHistory = session?.id.startsWith("codex_history_") === true;
  const historyId = session?.metadata?.nativeHistoryId;
  const native = codexHistory || typeof historyId === "string";
  const managed = usePonderSession(connection, !native ? session?.id ?? null : null);
  const [window, setWindow] = useState({ sessionId: session?.id, limit: 500 });
  const limit = window.sessionId === session?.id ? window.limit : 500;
  const projector = useRef(new IncrementalChatProjector());
  const history = useQuery({
    queryKey: ["native-agent-transcript", connectionQueryScope(connection), session?.id, limit],
    enabled: Boolean(session && native), staleTime: 2000, gcTime: 10 * 60 * 1000, refetchInterval: 3000,
    queryFn: async () => {
      if (codexHistory) {
        const payload = await api.codexHistoryThread(connection, session!.id, { limit, tail: true });
        return { events: payload.events, hasMore: payload.events.length >= limit };
      }
      await apiFetch(connection, "/v1/native-history/open", { method: "POST", body: JSON.stringify({ id: historyId }) });
      const events: RuntimeEvent[] = [];
      let beforeSequence: number | null = Number.MAX_SAFE_INTEGER;
      let hasMore = false;
      do {
        const page = await api.runtimeEventsPage(connection, { sessionId: session!.id, beforeSequence, limit: Math.min(200, limit - events.length) });
        events.unshift(...page.events.map(row => row.event));
        hasMore = page.hasMore;
        if (!hasMore || page.previousSequence === beforeSequence) break;
        beforeSequence = page.previousSequence;
      } while (events.length < limit);
      return { events, hasMore };
    },
  });
  const events = history.data?.events ?? EMPTY_EVENTS;
  const messages = useMemo(() => projector.current.project(events), [events]);
  const latest = [...events].reverse().find(event => ["turn.started", "turn.completed", "turn.failed", "turn.interrupted"].includes(event.name));
  return native ? { events, messages, error: history.error?.message ?? null, loading: history.isPending,
    hasMore: history.data?.hasMore ?? false,
    loadOlder: async () => { setWindow({ sessionId: session?.id, limit: limit + 500 }); },
    running: latest?.name === "turn.started" } : managed;
}
