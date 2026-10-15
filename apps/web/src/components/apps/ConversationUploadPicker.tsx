import { ErrorToast } from "../common/ErrorToast";
import { useConnectionReadRetry } from "../../hooks/useConnectionReadRetry";
import { useEffect, useRef, useState } from "react";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { DropdownSelect } from "../DropdownSelect";
import "../../styles/labs/evaluation-workspace.css";
import "../../styles/training/training.css";

type Conversation = { key: string; title: string; cwd: string | null; nativeSessionId: string; updatedAt: string; approved: boolean; issue: string | null };
type Page = { items: Conversation[]; total: number; nextOffset: number | null };

export function ConversationUploadPicker({ connection, connectionId, disabled, projectName, onUpload, onClose }: {
  connection: ClientConnection; connectionId: string; disabled: boolean; projectName: string;
  onUpload(keys: string[]): Promise<void>; onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [range, setRange] = useState("all");
  const [page, setPage] = useState<Page | null>(null);
  const [selected, setSelected] = useState<Map<string, Conversation>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useConnectionReadRetry(connection, error, () => setRevision(value => value + 1));
  const request = useRef<AbortController | null>(null);
  const refreshedRevision = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    request.current?.abort(); request.current = controller;
    setLoading(true); setPage(null); setError(null);
    const timer = window.setTimeout(() => {
      const refresh = revision !== refreshedRevision.current;
      refreshedRevision.current = revision;
      void apiFetch<Page>(connection, "/v1/native-history/collector", { method: "POST", signal: controller.signal,
        body: JSON.stringify({ command: "conversations", connectionId, query, range, refresh }) })
        .then(value => { if (!controller.signal.aborted) setPage(value); })
        .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to list conversations."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); request.current?.abort(); };
  }, [connection, connectionId, query, range, revision]);
  async function more() {
    if (loading || page?.nextOffset == null) return;
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(null);
    try {
      const next = await apiFetch<Page>(connection, "/v1/native-history/collector", { method: "POST", signal: controller.signal,
        body: JSON.stringify({ command: "conversations", connectionId, query, range, offset: page.nextOffset }) });
      if (!controller.signal.aborted) setPage(previous => ({ ...next, items: [...new Map([...(previous?.items ?? []), ...next.items].map(item => [item.key, item])).values()] }));
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load more conversations."); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  function toggle(item: Conversation, checked: boolean) {
    setSelected(previous => { const next = new Map(previous); if (checked) next.set(item.key, item); else next.delete(item.key); return next; });
  }
  const rows = page?.items ?? [];
  const selectable = rows.filter(item => !item.issue);
  const allVisible = selectable.length > 0 && selectable.every(item => selected.has(item.key));
  const visibleKeys = new Set(rows.map(item => item.key));
  const hidden = [...selected.keys()].filter(key => !visibleKeys.has(key)).length;
  return <section className="conversation-upload-picker" aria-label="Choose conversations to upload">
    <h3>Choose conversations</h3>
    <p>Upload to <strong>{projectName}</strong>. This selection also sets which conversations later syncs update. Previously uploaded data stays in the project.</p>
    <div className="conversation-upload-toolbar">
      <input autoFocus type="search" aria-label="Search conversations" placeholder="Search title, folder, or session ID" value={query}
        disabled={disabled} onChange={event => setQuery(event.target.value)} />
      <DropdownSelect label="Conversation activity" value={range} disabled={disabled} onChange={setRange}
        options={[{ value: "all", label: "All dates" }, { value: "week", label: "Active last week" }, { value: "day", label: "Active last day" }]} />
    </div>
    <div className="conversation-upload-selection" role="status">
      <span>{selected.size} selected{hidden ? ` · ${hidden} outside this view` : ""}{page ? ` · ${page.total} matching` : ""}</span>
      <button type="button" className="settings-secondary" disabled={disabled || loading} onClick={() => setRevision(value => value + 1)}>Refresh</button>
      <button type="button" className="settings-secondary" disabled={disabled || !selected.size} onClick={() => setSelected(new Map())}>Clear selection</button>
    </div>
    <div className="evaluation-table-scroll evaluation-table-frame conversation-upload-table">
      <table className="training-data-table evaluation-workspace-table">
        <thead><tr><th><input type="checkbox" className="training-chat-checkbox" aria-label="Select visible conversations" checked={allVisible}
          disabled={disabled || loading || !selectable.length} onChange={event => {
            const checked = event.target.checked;
            setSelected(previous => { const next = new Map(previous); selectable.forEach(item => { if (checked) next.set(item.key, item); else next.delete(item.key); }); return next; });
          }} /></th><th>Conversation</th><th>Last activity</th></tr></thead>
        <tbody>{rows.map(item => <tr key={item.key}>
          <td><input type="checkbox" className="training-chat-checkbox" aria-label={`Select ${item.title}`} checked={selected.has(item.key)}
            disabled={disabled || !!item.issue} onChange={event => toggle(item, event.target.checked)} /></td>
          <td><span className="conversation-upload-title" title={item.title}>{item.title}</span>
            <small title={item.cwd ?? item.nativeSessionId}>{item.cwd ?? item.nativeSessionId}</small>
            {item.issue ? <small role="status">{item.issue}</small> : item.approved ? <small>Already approved for sync</small> : null}</td>
          <td><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString()}</time></td>
        </tr>)}{loading ? <tr><td colSpan={3} role="status">Loading conversations…</td></tr>
          : !rows.length && !error ? <tr><td colSpan={3}>{query.trim() || range !== "all" ? "No conversations match these filters." : "No saved conversations found in this installation."}</td></tr> : null}</tbody>
      </table>
    </div>
    {error ? <ErrorToast error={error}><button type="button" className="settings-secondary" disabled={disabled || loading} onClick={() => setRevision(value => value + 1)}>Retry</button></ErrorToast> : null}
    {page?.nextOffset != null ? <button type="button" className="settings-secondary" disabled={disabled || loading} onClick={() => void more()}>Load more conversations</button> : null}
    <p>The complete selected conversations are uploaded, including their prompts, responses, and tool history. Date filters help you find conversations; they do not trim their contents.</p>
    <div className="settings-button-row">
      <button type="button" className="agent-connect-button" disabled={disabled || !selected.size} onClick={() => void onUpload([...selected.keys()])}>
        {`Upload ${selected.size} conversation${selected.size === 1 ? "" : "s"}`}
      </button>
      <button type="button" className="settings-secondary" disabled={disabled} onClick={onClose}>Cancel</button>
    </div>
  </section>;
}
