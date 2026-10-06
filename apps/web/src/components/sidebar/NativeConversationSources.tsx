import { NativeSetupTerminal } from "../terminal/NativeSetupTerminal";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { RefreshCw, Loader2, CircleAlert } from "../icons";
import type { CollectorStatus, NativeBranchChoice, NativeBranchInspection } from "@openpond/evals/native-conversations";
import { NativeImporterStatus, type ImporterControl, type ImporterConnectionControl } from "./NativeImporterStatus";
import { NativeBranchPicker } from "./NativeBranchPicker";

type HistoryPayload = {
  items: Array<{ id: string; source: string; title: string; cwd: string | null; updatedAt: string }>;
  nextCursors: Record<string, string>;
  warnings: string[];
  collector: CollectorStatus;
};
export function useNativeConversationHistory({ connection, selectedSessionId, selectedSession, active = true, onOpen }: { connection: ClientConnection | null; active?: boolean; selectedSessionId: string | null; selectedSession?: Session | null; onOpen(session: Session): boolean | Promise<boolean> }) {
  const selectionRef = useRef({ selectedSessionId, active });
  selectionRef.current = { selectedSessionId, active };
  const autoSelection = useRef<string | null>(null);
  const generation = useRef(0);
  const refreshing = useRef<number | null>(null);
  useEffect(() => { generation.current++; autoSelection.current = null; setBusy(null); setHistory(null); setError(null); setCommand(null); setBranchSelection(null); setFollowing(null); return () => { generation.current++; }; }, [connection]);
  const [following, setFollowing] = useState<{ id: string; sessionId: string } | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [branchSelection, setBranchSelection] = useState<{ id: string; inspection: NativeBranchInspection; originSessionId?: string | null } | null>(null);
  const refresh = useCallback(async () => {
    if (!connection || refreshing.current === generation.current) return;
    const currentGeneration = generation.current;
    refreshing.current = currentGeneration;
    setBusy("refresh");
    try { const value = await apiFetch<HistoryPayload>(connection, "/v1/native-history/list", { method: "POST", body: JSON.stringify({ retain: true }) }); if (currentGeneration === generation.current) { setHistory(value); setError(null); } }
    catch (error) { if (currentGeneration === generation.current) setError(error instanceof Error ? error.message : "Local history is unavailable."); }
    finally { if (refreshing.current === currentGeneration) refreshing.current = null; if (currentGeneration === generation.current) setBusy(null); }
  }, [connection]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!active || !connection || !following || following.sessionId !== selectedSessionId) return;
    const currentGeneration = generation.current;
    const timer = window.setInterval(() => {
      if (!document.hidden) void apiFetch(connection, "/v1/native-history/open", { method: "POST", body: JSON.stringify({ id: following.id }) }).catch((error: Error) => { if (currentGeneration === generation.current) setError(error.message); });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [active, connection, following, selectedSessionId]);
  async function more() {
    const currentGeneration = generation.current;
    if (!connection || !history) return;
    setBusy("more");
    try {
      const next = await apiFetch<HistoryPayload>(connection, "/v1/native-history/list", { method: "POST", body: JSON.stringify({ cursors: history.nextCursors, retain: true }) });
      if (currentGeneration !== generation.current) return;
      setHistory((previous) => ({ ...next, items: [...new Map([...(previous?.items ?? []), ...next.items].map((item) => [item.id, item])).values()] }));
    } catch (error) { if (currentGeneration === generation.current) setError(error instanceof Error ? error.message : "Could not load more conversations."); }
    finally { if (currentGeneration === generation.current) setBusy(null); }
  }
  async function open(id: string, branch?: NativeBranchChoice, originSessionId: string | null = selectionRef.current.selectedSessionId) {
    const currentGeneration = generation.current;
    if (!connection) return;
    if (busy !== null) return;
    setBusy(id);
    try {
      if (!branch) {
        const inspection = await apiFetch<NativeBranchInspection>(connection, "/v1/native-history/branches", { method: "POST", body: JSON.stringify({ id }) });
        if (currentGeneration !== generation.current) return;
        if (inspection.branches.length > 1) { if (selectionRef.current.active && selectionRef.current.selectedSessionId === originSessionId) setBranchSelection({ id, inspection, originSessionId }); setError(null); return; }
      }
      const session = await apiFetch<Session>(connection, "/v1/native-history/open", { method: "POST", body: JSON.stringify({ id, branch }) });
      if (currentGeneration !== generation.current) return;
      setFollowing(branch ? null : { id, sessionId: session.id }); setBranchSelection(null);
      setError(session.metadata?.nativeHistoryProjection && !session.nativeAgent ? typeof session.metadata.nativeReadOnlyReason === "string" ? session.metadata.nativeReadOnlyReason : "Read-only history: the native source does not report its original working directory." : null);
      if (selectionRef.current.active && selectionRef.current.selectedSessionId === originSessionId) await onOpen(session);
    }
    catch (error) { if (currentGeneration === generation.current) setError(error instanceof Error ? error.message : "Could not read this conversation."); }
    finally { if (currentGeneration === generation.current) setBusy(null); }
  }
  useEffect(() => {
    if (!active || !connection || busy !== null || !selectedSession || selectedSession.metadata?.nativeHistoryLoaded !== false || selectedSession.metadata.nativeBranch) return;
    const id = selectedSession.metadata.nativeHistoryId;
    if (typeof id !== "string") return;
    const key = `${generation.current}:${selectedSession.id}`;
    if (autoSelection.current === key) return;
    autoSelection.current = key;
    void open(id, undefined, selectedSession.id);
  }, [connection, selectedSession, busy, active]);
  async function control(command: ImporterControl) {
    const currentGeneration = generation.current;
    if (!connection) return;
    setBusy(command);
    try { await apiFetch(connection, "/v1/native-history/collector", { method: "POST", body: JSON.stringify({ command }) }); if (currentGeneration === generation.current) await refresh(); }
    catch (error) { if (currentGeneration === generation.current) setError(error instanceof Error ? error.message : "Collector action failed."); }
    finally { if (currentGeneration === generation.current) setBusy(null); }
  }
  async function connectionControl(action: ImporterConnectionControl, connectionId: string) {
    const currentGeneration = generation.current;
    if (!connection) return;
    setBusy(action);
    try {
      const result = await apiFetch<{ command: string }>(connection, "/v1/native-history/collector", { method: "POST", body: JSON.stringify({ command: action, connectionId }) });
      if (currentGeneration !== generation.current) return;
      setCommand(result.command); setError(null);
    } catch (error) { if (currentGeneration === generation.current) setError(error instanceof Error ? error.message : "Could not change Importer connection."); }
    finally { if (currentGeneration === generation.current) setBusy(null); }
  }
  async function connect(connectionId?: string) {
    const currentGeneration = generation.current;
    if (!connection) return;
    setBusy("connect");
    try {
      const result = await apiFetch<{ command: string }>(connection, "/v1/native-history/collector", { method: "POST", body: JSON.stringify({ command: connectionId ? "reconnect" : "connect", connectionId }) });
      if (currentGeneration !== generation.current) return;
      setCommand(result.command); setError(null);
    } catch (error) { if (currentGeneration === generation.current) setError(error instanceof Error ? error.message : "Could not open Importer setup."); }
    finally { if (currentGeneration === generation.current) setBusy(null); }
  }
  async function select(session: Session) {
    const id = session.metadata?.nativeHistoryId;
    if (!await onOpen(session)) return;
    if (session.metadata?.nativeHistoryProjection && !session.metadata.nativeBranch && typeof id === "string") void open(id, undefined, session.id);
  }
  return { connection, history, error, busy, command, expanded, branchSelection,
    setCommand, setExpanded, setBranchSelection, refresh, more, open, control, connectionControl, connect, select };
}

export function NativeConversationControls({ history: state }: { history: ReturnType<typeof useNativeConversationHistory> }) {
  const { connection, history, error, busy, command, expanded, branchSelection,
    setCommand, setExpanded, setBranchSelection, refresh, more, open, control, connectionControl, connect } = state;
  if (!connection) return null;
  return <section className="sidebar-section native-conversations" aria-label="Conversation import controls">
    <div className="sidebar-section-heading"><button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>Import conversations</button><button type="button" className="sidebar-icon" aria-label="Refresh saved conversation history" disabled={busy !== null} onClick={() => void refresh()}>{busy === "refresh" ? <Loader2 size={14} /> : <RefreshCw size={14} />}</button></div>
    {command ? <NativeSetupTerminal connection={connection} command={command} onClose={() => { setCommand(null); void refresh(); }} /> : null}
    {branchSelection ? <NativeBranchPicker title={history?.items.find(item => item.id === branchSelection.id)?.title ?? ""} inspection={branchSelection.inspection} busy={busy !== null} onSelect={branch => void open(branchSelection.id, branch, branchSelection.originSessionId ?? null)} onRefresh={() => void open(branchSelection.id, undefined, branchSelection.originSessionId ?? null)} onClose={() => setBranchSelection(null)} /> : null}
    {expanded ? <>
      <button type="button" disabled={busy !== null} onClick={() => void connect()}>Connect an import source</button>
      {history && Object.keys(history.nextCursors).length ? <button type="button" disabled={busy !== null} onClick={() => void more()}>Load more saved conversations</button> : null}
      {history && history.items.length === 0 ? <p>No saved conversations found in configured source locations.</p> : null}
      {history?.warnings.map((warning) => <p key={warning}><CircleAlert size={12} aria-hidden="true" /> {warning}</p>)}
      {history?.collector.connections.length ? <NativeImporterStatus status={history.collector} busy={busy !== null} onControl={(command) => void control(command)} onConnectionControl={(command, id) => void connectionControl(command, id)} onReconnect={(id) => void connect(id)} /> : <p>Connect an import source to upload conversations. Local history remains available without cloud sync.</p>}
    </> : null}
    {error ? <p role="status"><CircleAlert size={12} aria-hidden="true" /> {error}</p> : null}
  </section>;
}
