import { isRegisteredAcpProvider } from "@openpond/contracts/providers";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { modelDisplayLabel } from "../../lib/model-display";
import { NativeSetupTerminal } from "../terminal/NativeSetupTerminal";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, CircleAlert, Loader2, RefreshCw } from "../icons";
import type { ChatProvider, ProviderConfig, ProviderConfigPatch, ProviderStatus, ProviderModel } from "@openpond/contracts";
import type { CheckNativeProvider, NativeProviderCheck } from "./native-provider-check";

export const DESKTOP_AGENT_PROVIDERS: ChatProvider[] = ["codex", "claude-code", "grok-build", "opencode"];
export function isAcpProvider(id: string): boolean { return isRegisteredAcpProvider(id) || ["claude-code", "grok-build", "opencode"].includes(id); }
const setup: Record<string, { executable: string; install: string }> = {
  codex: { executable: "codex", install: "https://developers.openai.com/codex/cli" },
  "claude-code": { executable: "claude", install: "https://code.claude.com/docs/en/setup" },
  "grok-build": { executable: "grok", install: "https://docs.x.ai/build/cli" },
  opencode: { executable: "opencode", install: "https://opencode.ai/docs" },
};
const signature = (binaryPath: string | null | undefined, sourceHome: string | null | undefined) => JSON.stringify([binaryPath || "", sourceHome || ""]);

export function NativeAgentProviderDetails({ connection, providerId, config, status, cachedModels, busy, onCheck }: {
  connection: ClientConnection | null;
  providerId: ChatProvider; config: ProviderConfig; status: ProviderStatus; busy: boolean;
  onCheck: CheckNativeProvider;
  cachedModels: ProviderModel[];
}) {
  const [command, setCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NativeProviderCheck | null>(null);
  const [working, setWorking] = useState(false);
  const [binaryPath, setBinaryPath] = useState(config.binaryPath ?? "");
  const [sourceHome, setSourceHome] = useState(config.sourceHome ?? "");
  const active = useRef<AbortController | null>(null);
  const ownSave = useRef<string | null>(null);
  const latestCheck = useRef(onCheck);
  latestCheck.current = onCheck;
  const registered = isRegisteredAcpProvider(providerId);
  const info = setup[providerId] ?? { executable: config.acp?.command ?? "", install: config.acp?.installUrl ?? "" };
  const [agentCommand, setAgentCommand] = useState(config.acp?.command ?? "");
  const [agentArgs, setAgentArgs] = useState(JSON.stringify(config.acp?.args ?? []));
  const [agentEnv, setAgentEnv] = useState(JSON.stringify(config.acp?.env ?? {}, null, 2));
  const savedSignature = signature(config.binaryPath, config.sourceHome) + JSON.stringify(config.acp);
  const dirty = signature(binaryPath.trim(), sourceHome.trim()) !== signature(config.binaryPath, config.sourceHome) || (registered && (agentCommand !== config.acp?.command || agentArgs !== JSON.stringify(config.acp?.args ?? []) || agentEnv !== JSON.stringify(config.acp?.env ?? {}, null, 2)));
  const disabled = busy || working || command !== null;

  const check = useCallback(async (patch?: ProviderConfigPatch) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timeout = setTimeout(() => controller.abort(new Error("Connection check timed out. Retry when the agent is available.")), 45_000);
    setWorking(true); setError(null);
    try {
      const next = await latestCheck.current(providerId, controller.signal, patch);
      if (active.current === controller && !controller.signal.aborted) setResult(next);
    } catch (failure) {
      if (active.current === controller) setError(failure instanceof Error ? failure.message : "Could not check the agent.");
    } finally {
      clearTimeout(timeout);
      if (active.current === controller) { active.current = null; setWorking(false); }
    }
  }, [providerId]);

  useEffect(() => {
    setAgentCommand(config.acp?.command ?? ""); setAgentArgs(JSON.stringify(config.acp?.args ?? [])); setAgentEnv(JSON.stringify(config.acp?.env ?? {}, null, 2));
    setBinaryPath(config.binaryPath ?? ""); setSourceHome(config.sourceHome ?? "");
    if (ownSave.current === savedSignature) { ownSave.current = null; return; }
    setCommand(null);
    setResult(null);
    void check();
  }, [check, savedSignature, config.binaryPath, config.sourceHome, connection?.serverUrl, connection?.token]);
  useEffect(() => () => { const current = active.current; active.current = null; current?.abort(); }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!dirty || disabled) return;
    try {
      const acp = registered && config.acp ? { ...config.acp, command: agentCommand.trim(), args: JSON.parse(agentArgs), env: JSON.parse(agentEnv) } : config.acp;
      ownSave.current = signature(binaryPath.trim(), sourceHome.trim()) + JSON.stringify(acp);
      await check({ binaryPath: binaryPath.trim() || null, sourceHome: sourceHome.trim() || null, ...(registered ? { acp } : {}) });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Invalid command configuration."); }
    ownSave.current = null;
  }
  async function login() {
    if (!connection || result?.status !== "needs_login") return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    active.current?.abort(); active.current = controller;
    setWorking(true); setError(null);
    try {
      const loginResult = await apiFetch<{ command: string }>(connection, `/v1/providers/${providerId}/native-setup`, { method: "POST", body: JSON.stringify({ action: "login" }), signal: controller.signal });
      if (active.current === controller && !controller.signal.aborted) setCommand(loginResult.command);
    } catch (failure) {
      if (active.current === controller) setError(failure instanceof Error ? failure.message : "Could not open native login.");
    } finally { clearTimeout(timeout); if (active.current === controller) { active.current = null; setWorking(false); } }
  }
  async function authenticate(authMethodId: string) {
    if (!connection || disabled || dirty) return;
    setWorking(true); setError(null);
    const controller = new AbortController(); active.current = controller;
    const timeout = setTimeout(() => controller.abort(new Error("Authentication timed out. Use the agent’s login and refresh.")), 185_000);
    try {
      const next = await apiFetch<NativeProviderCheck>(connection, `/v1/providers/${providerId}/native-setup`, { method: "POST", body: JSON.stringify({ action: "authenticate", authMethodId }), signal: controller.signal });
      if (!controller.signal.aborted) {
        ownSave.current = signature(next.settings.providers[providerId]?.binaryPath, next.settings.providers[providerId]?.sourceHome) + JSON.stringify(next.settings.providers[providerId]?.acp);
        setResult(next); await check(); ownSave.current = null;
      }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Authentication failed."); }
    finally { clearTimeout(timeout); if (active.current === controller) { active.current = null; setWorking(false); } }
  }
  const models = result?.settings.modelCaches[providerId]?.models ?? cachedModels;
  const modelNames = [...new Set(models.map(model => modelDisplayLabel(model.displayName || model.id)))];
  const message = error ?? result?.error;
  return <div className="provider-dialog-body native-agent-setup">
    <p>{registered ? `Uses the configured ${status.displayName} ACP command and its own login.` : `Uses your existing ${status.displayName} installation and login.`}</p>
    <div className="native-connection-status">
      <div role="status" aria-live="polite">{working ? <><Loader2 size={16} className="settings-spin" /><span>Checking connection…</span></> : result?.status === "ready" ? <><CheckCircle2 size={16} /><span>{config.enabled ? "Connected" : "Connected, disabled for chat"}</span></> : <><CircleAlert size={16} /><span>{result?.status === "missing" ? "Installation not found" : result?.status === "needs_login" ? "Sign in required" : "Connection needs attention"}</span></>}</div>
      <button type="button" className="settings-secondary" disabled={disabled || !connection} onClick={() => void check()} title="Refresh connection" aria-label="Refresh connection"><RefreshCw size={14} /> Refresh</button>
    </div>
    {message ? <p role="alert">{message}</p> : null}
    {modelNames.length ? <section className="native-model-section" aria-label="Available models"><div className="native-model-heading"><h3>Models</h3><small>{modelNames.length} available</small></div><div className="native-model-list" tabIndex={0} aria-label="Models" role="list">{modelNames.map(name => <span key={name} role="listitem">{name}</span>)}</div><small>Choose a model when starting a chat.</small></section> : null}
    {result?.version ? <small className="native-agent-version">{result.version}</small> : null}
    {!registered && result?.status === "needs_login" ? <button type="button" className="settings-secondary" disabled={disabled || dirty || !connection} title={dirty ? "Save changes before signing in to a different installation" : undefined} onClick={() => void login()}>Sign in</button> : null}
    {registered && result?.authMethods?.length ? <div className="acp-auth-methods">{result.authMethods.map(method => method.type === "terminal" ? <p key={method.id}>Use {method.name} in the agent’s own terminal, then refresh this connection.</p> : <button key={method.id} type="button" className="settings-secondary" disabled={disabled || dirty || !connection} onClick={() => void authenticate(method.id)} title={method.description}>{method.name}</button>)}</div> : null}
    {result?.status === "missing" && info.install ? <p><a href={info.install} target="_blank" rel="noreferrer">Install {status.displayName}</a>, then refresh this connection.</p> : null}
    {providerId === "codex" && result?.status === "missing" ? <p>OpenPond needs the Codex CLI installed separately from ChatGPT.</p> : null}
    {(error || result?.status === "unavailable") && !working ? <button type="button" className="settings-secondary" disabled={disabled || !connection} onClick={() => void check()}>Retry</button> : null}
    {command && connection ? <NativeSetupTerminal connection={connection} command={command} onComplete={() => { setCommand(null); void check(); }} onClose={() => { setCommand(null); void check(); }} /> : null}
    {isAcpProvider(providerId) ? <details>
      <summary>Advanced</summary>
      <form className="provider-card-form" onSubmit={(event) => void save(event)}>
        {registered ? <>
          <label className="settings-select-field"><span>ACP command</span><input value={agentCommand} disabled={disabled} onChange={event => setAgentCommand(event.target.value)} /></label>
          <label className="settings-select-field"><span>Arguments (JSON array)</span><textarea value={agentArgs} disabled={disabled} onChange={event => setAgentArgs(event.target.value)} /></label>
          <label className="settings-select-field"><span>Environment overrides (JSON object)</span><textarea value={agentEnv} disabled={disabled} onChange={event => setAgentEnv(event.target.value)} /></label>
        </> : null}
        <label className="settings-select-field"><span>Executable override</span><input value={binaryPath} placeholder={`${info.executable} from PATH, or an absolute path`} disabled={disabled} onChange={(event) => setBinaryPath(event.currentTarget.value)} /></label>
        <label className="settings-select-field"><span>{registered ? "Home directory" : "Source home"}</span><input value={sourceHome} placeholder="Use the agent's existing home" disabled={disabled} onChange={(event) => setSourceHome(event.currentTarget.value)} /></label>
        {dirty ? <button className="settings-secondary" disabled={disabled || !connection}>Save changes</button> : null}
      </form>
    </details> : null}
  </div>;
}
