import { useEffect, useMemo, useRef, useState } from "react";
import { SessionSchema, type RuntimeEvent, type Session } from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import { apiFetch } from "../../api/api-client";

export function useNativeConversationAvailability({
  connection, sessionId, events, fallbackReason,
}: {
  connection: ClientConnection | null;
  sessionId: string | null;
  events: readonly RuntimeEvent[];
  fallbackReason: string | null;
}) {
  const latest = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.sessionId !== sessionId || !["session.started", "session.updated", "session.title.updated"].includes(event.name)) continue;
      const data = event.data;
      const session = SessionSchema.safeParse(data && typeof data === "object" && "session" in data ? data.session : null);
      if (session.success) return { session: session.data, eventId: event.id };
    }
    return null;
  }, [events, sessionId]);
  const [rechecked, setRechecked] = useState<{ connection: ClientConnection | null; eventId: string | undefined; session: Session } | null>(null);
  const session = rechecked?.connection === connection && rechecked.session.id === sessionId && rechecked.eventId === latest?.eventId
    ? rechecked.session : latest?.session ?? null;
  const reason = session ? (typeof session.metadata?.nativeReadOnlyReason === "string" ? session.metadata.nativeReadOnlyReason : null) : fallbackReason;
  return { session, reason, acceptSession: (value: Session) => setRechecked({ connection, eventId: latest?.eventId, session: value }) };
}

export function NativeConversationUnavailable({
  connection, session, reason, onRechecked,
}: {
  connection: ClientConnection | null;
  session: Session | null;
  reason: string;
  onRechecked: (session: Session) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setBusy(false); setError(null); return () => { generation.current++; }; }, [connection, session?.id]);
  const historyId = !session?.metadata?.nativeBranch && session?.metadata?.nativeHistoryId;
  return <div className="composer dock native-conversation-unavailable">
    <p role="status">{error ?? reason}</p>
    {connection && typeof historyId === "string" ? <button type="button" disabled={busy} onClick={async () => {
      const current = generation.current;
      setBusy(true); setError(null);
      try {
        const value = await apiFetch<Session>(connection, "/v1/native-history/open", { method: "POST", body: JSON.stringify({ id: historyId, retryWorkspace: true }) });
        if (current === generation.current) onRechecked(SessionSchema.parse(value));
      } catch (error) {
        if (current === generation.current) setError(error instanceof Error ? error.message : "Could not reconnect to this conversation.");
      } finally { if (current === generation.current) setBusy(false); }
    }}>{busy ? "Checking…" : "Check again"}</button> : null}
  </div>;
}
