import { useEffect, useId, useState, type FormEvent } from "react";
import type { ChatProvider, ProviderSettings } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { Plus, X, Loader2, RefreshCw } from "../icons";

import { AppDialog } from "../dialogs/AppDialog";

type Distribution = { args?: string[]; env?: Record<string, string>; package?: string; archive?: string; cmd?: string };
type RegistryAgent = { id: string; name: string; version: string; description: string; website?: string; repository?: string; supported: boolean;
  distribution: { binary?: Record<string, Distribution>; npx?: Distribution; uvx?: Distribution } };
type Catalog = { platform: string; fetchedAt: string; agents: RegistryAgent[] };
type Added = { providerId: ChatProvider; settings: ProviderSettings };

export function AcpAgentBrowser({ connection, onChanged, onAdded }: { connection: ClientConnection | null; onChanged(settings: ProviderSettings): void; onAdded(id: ChatProvider): void }) {
  const tabId = useId();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<RegistryAgent | null>(null);
  const [distribution, setDistribution] = useState("");
  const [name, setName] = useState("");
  const [customName, setCustomName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [env, setEnv] = useState("{}");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || custom || !connection) return;
    const controller = new AbortController();
    setLoading(true); setError(null);
    void apiFetch<Catalog>(connection, `/v1/providers/acp-registry${refresh ? "?refresh=true" : ""}`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setCatalog(value); setSelected(null); }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load ACP registry."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, custom, connection, refresh]);
  const kinds = selected ? [selected.distribution.binary?.[catalog?.platform ?? ""] ? "binary" : null, selected.distribution.npx ? "npx" : null, selected.distribution.uvx ? "uvx" : null].filter((kind): kind is string => Boolean(kind)) : [];
  const visibleAgents = catalog?.agents.filter(agent => `${agent.name} ${agent.id} ${agent.description}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  const kind = kinds.includes(distribution) ? distribution : kinds[0];
  const spec = kind === "binary" ? selected?.distribution.binary?.[catalog?.platform ?? ""] : kind === "npx" ? selected?.distribution.npx : selected?.distribution.uvx;
  async function add(event: FormEvent) {
    event.preventDefault(); if (!connection || adding) return;
    setAdding(true); setError(null);
    try {
      const payload = custom ? { custom: { displayName: customName.trim(), command: command.trim(), args: JSON.parse(args), env: JSON.parse(env) } }
        : { registryId: selected?.id, version: selected?.version, distribution: kind, displayName: name.trim() || selected?.name };
      const result = await apiFetch<Added>(connection, "/v1/providers/acp-registry", { method: "POST", body: JSON.stringify(payload) });
      onChanged(result.settings); onAdded(result.providerId); setOpen(false); setSelected(null); setName(""); setCustomName(""); setCommand(""); setArgs("[]"); setEnv("{}");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not add ACP agent."); }
    finally { setAdding(false); }
  }
  function close() { if (!adding) setOpen(false); }
  return <>
    <button type="button" className="settings-secondary acp-add-button" disabled={!connection || adding} onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" /> ACP Agent</button>
    {open ? <AppDialog ariaLabel="Add ACP agent" backdropClassName="git-dialog-backdrop provider-dialog-backdrop" className="git-dialog provider-details-dialog acp-agent-dialog" dismissDisabled={adding} onClose={close}>
      <button type="button" className="git-dialog-close" aria-label="Close" disabled={adding} onClick={close}><X size={18} /></button>
      <div className="provider-dialog-header"><div><h2>Add ACP agent</h2><span>Choose from the registry or register your own agent.</span></div></div>
      <div className="surface-tabs" role="tablist" aria-label="Agent registration" onKeyDown={event => {
        if (adding || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? false : event.key === "End" ? true : !custom;
        setCustom(next); setError(null);
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next ? 1 : 0]?.focus();
      }}>
        <button type="button" role="tab" id={`${tabId}-registry-tab`} aria-controls={`${tabId}-panel`} aria-selected={!custom} tabIndex={custom ? -1 : 0} disabled={adding} onClick={() => { setCustom(false); setError(null); }}>Registry</button>
        <button type="button" role="tab" id={`${tabId}-custom-tab`} aria-controls={`${tabId}-panel`} aria-selected={custom} tabIndex={custom ? 0 : -1} disabled={adding} onClick={() => { setCustom(true); setError(null); }}>Custom agent</button>
      </div>
      <div className="provider-dialog-body" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${custom ? "custom" : "registry"}-tab`}>
      <p>{custom ? "Register an installed agent using its ACP executable and launch settings." : "Browse agents from the Agent Client Protocol registry."}</p>
      {error ? <p role="alert">{error}</p> : null}
      <form className="provider-card-form" onSubmit={event => void add(event)}>
        {custom ? <>
          <label className="settings-select-field"><span>Name</span><input required maxLength={160} value={customName} disabled={adding} onChange={event => setCustomName(event.target.value)} placeholder="My ACP agent" /></label>
          <label className="settings-select-field"><span>ACP executable</span><input required value={command} disabled={adding} onChange={event => setCommand(event.target.value)} placeholder="Executable from PATH or absolute path" /></label>
          <label className="settings-select-field"><span>Arguments (JSON array)</span><textarea value={args} disabled={adding} onChange={event => setArgs(event.target.value)} placeholder={'["--acp"]'} /></label>
          <label className="settings-select-field"><span>Environment overrides (JSON object)</span><textarea value={env} disabled={adding} onChange={event => setEnv(event.target.value)} /></label>
          <small>Overrides are saved in your local configuration. Inherited environment variables do not need to be entered here.</small>
        </> : <>
          <div className="acp-registry-search"><label className="settings-select-field"><span>Search registry</span><input value={search} disabled={adding} onChange={event => setSearch(event.target.value)} placeholder="Search agents" /></label><button type="button" className="settings-secondary" disabled={loading || adding} onClick={() => setRefresh(value => value + 1)} aria-label="Refresh ACP registry"><RefreshCw size={14} /></button></div>
          {loading ? <p role="status"><Loader2 size={16} className="settings-spin" /> Loading registry…</p> : null}
          <div className="acp-registry-content">
          {catalog ? <div className="acp-registry-list" role="group" aria-label="ACP registry agents">{visibleAgents.map(agent => <button type="button" className="acp-registry-entry" key={agent.id} disabled={adding} aria-pressed={selected?.id === agent.id} onClick={() => { setSelected(agent); setDistribution(""); setName(agent.name); }}><strong>{agent.name} <small>{agent.version}</small></strong><span>{agent.description}</span>{!agent.supported ? <small>No distribution for {catalog.platform}; use a custom command.</small> : null}</button>)}{!visibleAgents.length ? <p className="acp-registry-empty">No agents match your search.</p> : null}</div> : null}
          {selected ? <div className="acp-install-summary">
            <label className="settings-select-field"><span>Connection name</span><input value={name} disabled={adding} onChange={event => setName(event.target.value)} /></label>
            {kinds.length ? <label className="settings-select-field"><span>Distribution</span><select value={kind} disabled={adding} onChange={event => setDistribution(event.target.value)}>{kinds.map(value => <option key={value} value={value}>{value === "binary" ? `Binary for ${catalog?.platform}` : value}</option>)}</select></label> : null}
            {spec ? <><code>{kind === "binary" ? spec.archive : `${kind} ${spec.package} ${(spec.args ?? []).join(" ")}`}</code><p>{kind === "binary" ? "Adding downloads and installs this version locally." : `Connecting runs ${kind}, which downloads this package version if needed.`} The agent uses its own authentication and model catalog.</p></> : null}
            {selected.website || selected.repository ? <a href={selected.website ?? selected.repository} target="_blank" rel="noreferrer">Agent documentation</a> : null}
          </div> : null}
          {!selected && catalog ? <div className="acp-registry-hint">Select an agent to see its installation options.</div> : null}
          </div>
        </>}
        <div className="acp-registration-actions"><button type="button" className="settings-secondary" disabled={adding} onClick={close}>Cancel</button><button className="settings-primary" disabled={adding || !connection || (custom ? !customName.trim() || !command.trim() : !selected || !kind)}>{adding ? "Adding agent…" : "Add and connect"}</button></div>
      </form>
      </div>
    </AppDialog> : null}
  </>;
}
