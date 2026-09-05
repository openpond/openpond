import { clientChoiceSaveIssue, retryClientChoiceSave, useHydratedClientChoice } from "../../lib/client-choice-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, type ClientConnection } from "../../api/api-client";

type ConfigStatus = {
  path: string; text: string | null; rawRevision: string;
  issue: { code: string; message: string; path: string; line?: number; column?: number; action: string } | null;
  effective: { effectiveRevision: string; document: unknown; provenance: Record<string, { layer: string; path: string; revision: string }> } | null;
  recoverableRevisions: { revision: string; createdAt: string }[];
};
export function ConfigurationSettings({ connection, bannerOnly = false, onOpen, onSaved }: { connection: ClientConnection | null; bannerOnly?: boolean; onOpen?: () => void; onSaved?: () => Promise<void> }) {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [editRevision, setEditRevision] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveIssue, setSaveIssue] = useState(clientChoiceSaveIssue);
  useHydratedClientChoice(() => setSaveIssue(clientChoiceSaveIssue()));
  const loadOrder = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!connection) return;
    const order = ++loadOrder.current;
    const value = await apiFetch<ConfigStatus>(connection, "/v1/configuration", { signal });
    if (!signal?.aborted && order === loadOrder.current) setStatus(value);
  }, [connection]);
  useEffect(() => {
    setStatus(null); setDraft(null); setEditRevision(null); setMessage(null);
    const controller = new AbortController();
    const refresh = () => { void load(controller.signal).catch((error) => { if (!controller.signal.aborted) setMessage(String(error)); }); };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { loadOrder.current += 1; controller.abort(); window.clearInterval(timer); };
  }, [load]);
  async function act(action: "validate" | "replace" | "restore", revision?: string) {
    if (!connection || !status) return;
    setBusy(true); setMessage(null);
    try {
      const body = action === "restore" ? { action, revision, expectedRevision: status.rawRevision } : action === "validate" ? { action, text: draft ?? status.text ?? "schema_version = 1\n" } : { action, text: draft ?? status.text ?? "schema_version = 1\n", expectedRevision: editRevision ?? status.rawRevision };
      await apiFetch(connection, "/v1/configuration", { method: "POST", body: JSON.stringify(body) });
      if (action !== "validate") { setDraft(null); setEditRevision(null); await load(); await onSaved?.(); }
      setMessage(action === "validate" ? "Configuration is valid." : "Saved. Changes apply to the next turn.");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  if (!connection) return null;
  if (bannerOnly && !status?.issue && !saveIssue) return null;
  return <section className={`account-settings configuration-settings ${bannerOnly ? "configuration-banner" : ""}`} aria-label="Configuration">
    {!bannerOnly ? <header><h1>Configuration</h1><p>Manage your settings in one TOML file. The controls below save to the same file; unset an override to inherit its default.</p></header> : null}
    {saveIssue ? <p role="alert">{saveIssue} <button type="button" onClick={retryClientChoiceSave}>Retry saving preferences</button></p> : null}
    {status?.issue ? <div role="alert">
      <strong>Configuration needs attention</strong>
      <p>{status.issue.message}</p>
      <p><code>{status.issue.path}{status.issue.line ? `:${status.issue.line}:${status.issue.column ?? 1}` : ""}</code></p>
      <p>{status.issue.action} Affected turns are blocked until this is corrected.</p>
      <button type="button" onClick={() => { if (bannerOnly) onOpen?.(); else setExpanded(true); }}>Open configuration</button>
    </div> : null}
    {!bannerOnly ? <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>Configuration file and sources</summary>
      <p><code>{status?.path ?? "Loading…"}</code></p>
      <p>Unset an override to inherit its default. Changes apply to the next turn; current turns retain their model settings.</p>
      <textarea aria-label="TOML configuration" spellCheck={false} rows={18} style={{ width: "100%", fontFamily: "monospace" }} value={draft ?? status?.text ?? "schema_version = 1\n"} onChange={(event) => { if (draft === null) setEditRevision(status?.rawRevision ?? null); setDraft(event.target.value); }} />
      {draft !== null && status?.rawRevision !== editRevision ? <p role="alert">The file changed elsewhere. Reload before saving your edits.</p> : null}
      <div className="configuration-actions">
        <button type="button" disabled={busy || !status} onClick={() => void act("validate")}>Validate</button>
        <button type="button" disabled={busy || !status || draft !== null && status.rawRevision !== editRevision} onClick={() => void act("replace")}>Save config</button>
        <button type="button" disabled={busy} onClick={() => { setDraft(null); setEditRevision(null); void load().catch((error) => setMessage(String(error))); }}>Reload file</button>
      </div>
      {status?.recoverableRevisions.length ? <label>Restore a verified revision <select value="" disabled={busy} onChange={(event) => { if (event.target.value) void act("restore", event.target.value); }}><option value="">Choose a revision…</option>{status.recoverableRevisions.map((entry) => <option key={entry.revision} value={entry.revision}>{new Date(entry.createdAt).toLocaleString()} · {entry.revision.slice(0, 12)}</option>)}</select></label> : null}
      {status?.effective ? <details><summary>Effective values and sources</summary><table><thead><tr><th>Setting</th><th>Source</th><th>Location</th></tr></thead><tbody>{Object.entries(status.effective.provenance).map(([key, source]) => <tr key={key}><td>{(JSON.parse(key) as string[]).join(".")}</td><td>{source.layer === "user" ? "Set here" : `Inherited from ${source.layer}`}</td><td>{source.path}</td></tr>)}</tbody></table><pre>{JSON.stringify(status.effective.document, null, 2)}</pre></details> : null}
    </details> : null}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
