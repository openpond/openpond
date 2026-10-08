import { useEffect, useRef, useState, type FormEvent } from "react";
import type { UrlModel, UrlModelInspection } from "@openpond/contracts/enclave";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { useAgentDialogFocus } from "../apps/useAgentDialogFocus";
import { X } from "../icons";
import { DropdownSelect } from "../DropdownSelect";

type ModelList = { models: UrlModel[] };
export function UrlModelConnections({ connection, onChanged }: { connection: ClientConnection | null; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<UrlModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setModels([]); setError(null);
    if (connection) void apiFetch<ModelList>(connection, "/v1/url-models/list", { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setModels(value.models); })
      .catch(() => { if (!controller.signal.aborted) setError("Could not load your model connections."); });
    return () => controller.abort();
  }, [connection, reload]);
  async function remove(model: UrlModel) {
    if (!connection || removing) return;
    setRemoving(model.id); setError(null);
    try {
      const value = await apiFetch<ModelList>(connection, "/v1/url-models/remove", { method: "POST", body: JSON.stringify({ id: model.id }) });
      setModels(value.models); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove the connection."); }
    finally { setRemoving(null); }
  }
  return <section aria-label="Models from URL" className="url-model-connections">
    <div className="provider-connections-intro"><div><h2>Models from URL</h2><p>Connect a model endpoint and select it in your chats. </p></div><button type="button" className="settings-primary" disabled={!connection} onClick={() => setOpen(true)}>Add model</button></div>
    {error ? <p role="alert">{error} <button type="button" onClick={() => setReload((value) => value + 1)}>Retry</button></p> : null}
    <div className="provider-connections-grid">{models.map((model) => <div className="provider-connection-card" key={model.id}>
      <strong>{model.name}</strong><p className="url-model-endpoint">{model.endpoint}</p><p>{model.providerName} · {model.model} · {model.hasToken ? "Key saved securely" : "No API key"}</p>
      <button type="button" className="settings-secondary" disabled={Boolean(removing)} onClick={() => void remove(model)}>{removing === model.id ? "Removing…" : "Remove model"}</button>
    </div>)}</div>
    {open && connection ? <AddUrlModelDialog providerNames={[...new Set(models.map((model) => model.providerName))]} connection={connection} onClose={() => setOpen(false)} onSaved={async (value) => { setModels(value.models); await onChanged(); setOpen(false); }} /> : null}
  </section>;
}

function AddUrlModelDialog({ connection, providerNames, onClose, onSaved }: {
  connection: ClientConnection; providerNames: string[]; onClose: () => void; onSaved: (value: ModelList) => Promise<void>;
}) {
  const dialog = useAgentDialogFocus(onClose);
  const [providerChoice, setProviderChoice] = useState(providerNames[0] ? `provider:${providerNames[0]}` : "__new__");
  const [newProviderName, setNewProviderName] = useState("");
  const providerName = providerChoice === "__new__" ? newProviderName.trim() : providerChoice.slice(9);
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [inspection, setInspection] = useState<UrlModelInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  function resetInspection() { setInspection(null); setModel(""); setError(null); }
  async function operate(save: boolean) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError(null);
    try {
      if (save) {
        const value = await apiFetch<ModelList>(connection, "/v1/url-models/save", { method: "POST", signal: controller.signal, body: JSON.stringify({ endpoint: endpoint.trim(), token, name: name.trim(), model, providerName }) });
        if (!controller.signal.aborted) { setToken(""); await onSaved(value); }
      } else {
        const value = await apiFetch<UrlModelInspection>(connection, "/v1/url-models/inspect", { method: "POST", signal: controller.signal, body: JSON.stringify({ endpoint: endpoint.trim(), token }) });
        if (!controller.signal.aborted) { setInspection(value); setModel(value.models[0] ?? ""); if (!name.trim()) setName(value.models[0] ?? ""); }
      }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Connection failed."); }
    finally { active.current = null; if (!controller.signal.aborted) setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void operate(Boolean(inspection)); }
  return <div className="git-dialog-backdrop provider-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className="git-dialog provider-details-dialog" role="dialog" aria-modal="true" aria-labelledby="url-model-title" tabIndex={-1}>
      <div className="provider-dialog-header"><h2 id="url-model-title">Add model</h2><button type="button" className="git-dialog-close" aria-label="Close Add model" onClick={onClose}><X size={18} /></button></div>
      <form className="url-model-connection-form" onSubmit={submit}>
        <div className="url-model-field"><span>Provider</span><DropdownSelect label="Provider" value={providerChoice} disabled={busy} floating
          options={[...providerNames.map((name) => ({ value: `provider:${name}`, label: name })), { value: "__new__", label: "Create new provider", icon: "plus", separatorBefore: Boolean(providerNames.length) }]}
          onChange={setProviderChoice} /></div>
        {providerChoice === "__new__" ? <label>Provider name<input required maxLength={100} placeholder="My model provider" value={newProviderName} disabled={busy} onChange={(event) => setNewProviderName(event.target.value)} /></label> : null}
        <label>Endpoint URL<input type="url" required placeholder="https://api.example.com/v1" value={endpoint} disabled={busy} onChange={(event) => { setEndpoint(event.target.value); resetInspection(); }} /></label>
        <label>API key <span className="settings-footnote">Optional for endpoints that do not require one</span><input type="password" autoComplete="new-password" spellCheck={false} value={token} disabled={busy} placeholder="API key" onChange={(event) => { setToken(event.target.value); resetInspection(); }} /></label>
        {inspection ? <>
          <div className="url-model-field"><span>Model</span><DropdownSelect label="Model" value={model} disabled={busy} floating searchable
            options={inspection.models.map((id) => ({ value: id, label: id }))}
            onChange={(value) => { setModel(value); setName(value); }} /></div>
          <label>Display name<input required maxLength={100} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
        </> : <p className="settings-footnote">Use the model service’s API base URL. Keys are encrypted on this machine.</p>}
        {error ? <p role="alert">{error}</p> : null}
        <div className="url-model-connection-actions"><button className="settings-primary" type="submit" disabled={busy || !providerName || (Boolean(inspection) && (!model || !name.trim()))}>{busy ? "Connecting…" : inspection ? "Add model" : "Fetch models"}</button><button type="button" className="settings-secondary" onClick={onClose}>Cancel</button></div>
      </form>
    </section>
  </div>;
}
