import { apiFetch, type ClientConnection } from "../../api/api-client";
import { NativeSetupTerminal } from "../terminal/NativeSetupTerminal";
import { useState, type FormEvent } from "react";
import type { ChatProvider, ProviderConfig, ProviderConfigPatch, ProviderStatus } from "@openpond/contracts";

export const DESKTOP_AGENT_PROVIDERS: ChatProvider[] = ["codex", "claude-code", "grok-build", "opencode"];
export function isAcpProvider(id: string): boolean { return ["claude-code", "grok-build", "opencode"].includes(id); }
const setup: Record<string, { executable: string; login: string; install: string }> = {
  "claude-code": { executable: "claude", login: "claude auth login", install: "https://code.claude.com/docs/en/setup" },
  "grok-build": { executable: "grok", login: "grok login", install: "https://docs.x.ai/build/cli" },
  opencode: { executable: "opencode", login: "opencode auth login", install: "https://opencode.ai/docs" },
};

export function NativeAgentProviderDetails({ connection, providerId, config, status, busy, onSave, onConnect }: {
  connection: ClientConnection | null;
  providerId: ChatProvider; config: ProviderConfig; status: ProviderStatus; busy: boolean;
  onSave(provider: ChatProvider, patch: ProviderConfigPatch): Promise<void>;
  onConnect(provider: ChatProvider): Promise<void>;
}) {
  const [command, setCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [binaryPath, setBinaryPath] = useState(config.binaryPath ?? "");
  const [sourceHome, setSourceHome] = useState(config.sourceHome ?? "");
  const info = setup[providerId]!;
  async function save(event: FormEvent) {
    event.preventDefault();
    await onSave(providerId, { binaryPath: binaryPath.trim() || null, sourceHome: sourceHome.trim() || null, enabled: true });
    await onConnect(providerId);
  }
  async function login() {
    if (!connection) return;
    try {
      await onSave(providerId, { binaryPath: binaryPath.trim() || null, sourceHome: sourceHome.trim() || null });
      const result = await apiFetch<{ command: string }>(connection, `/v1/providers/${providerId}/native-setup`, { method: "POST", body: JSON.stringify({ action: "login" }) });
      setCommand(result.command); setError(null);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not open native login."); }
  }
  return <div className="provider-dialog-body native-agent-setup">
    <p>{status.displayName} owns its login, tools and saved conversations. OpenPond uses the selected local installation.</p>
    <form className="provider-card-form" onSubmit={(event) => void save(event)}>
      <label className="settings-select-field"><span>Executable</span><input value={binaryPath} placeholder={`${info.executable} from PATH, or an absolute path`} disabled={busy} onChange={(event) => setBinaryPath(event.currentTarget.value)} /></label>
      <label className="settings-select-field"><span>Source home</span><input value={sourceHome} placeholder="Use the agent's existing home" disabled={busy} onChange={(event) => setSourceHome(event.currentTarget.value)} /></label>
      <div className="settings-button-row"><button className="settings-secondary" disabled={busy}>{busy ? "Connecting" : "Save and connect"}</button><button className="settings-secondary" type="button" disabled={busy} onClick={() => void onConnect(providerId)}>Refresh connection and models</button></div>
    </form>
    <button type="button" className="settings-secondary" disabled={busy || !connection} onClick={() => void login()}>Open native login</button>
    {error ? <p role="alert">{error}</p> : null}
    {command && connection ? <NativeSetupTerminal connection={connection} command={command} onClose={() => { setCommand(null); void onConnect(providerId); }} /> : null}
    <p>For an existing installation, sign in with <code>{info.login}</code> and refresh the connection.</p>
    <a href={info.install} target="_blank" rel="noreferrer">Installation instructions</a>
  </div>;
}
