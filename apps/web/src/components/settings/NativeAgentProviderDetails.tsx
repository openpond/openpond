import { useState, type FormEvent } from "react";
import type { ChatProvider, ProviderConfig, ProviderConfigPatch, ProviderStatus } from "@openpond/contracts";

export const DESKTOP_AGENT_PROVIDERS: ChatProvider[] = ["codex", "claude-code", "grok-build", "opencode"];
export function isAcpProvider(id: string): boolean { return ["claude-code", "grok-build", "opencode"].includes(id); }
const setup: Record<string, { executable: string; login: string; install: string }> = {
  "claude-code": { executable: "claude-agent-acp", login: "claude auth login", install: "https://github.com/agentclientprotocol/claude-agent-acp" },
  "grok-build": { executable: "grok", login: "grok login", install: "https://docs.x.ai/build/cli" },
  opencode: { executable: "opencode", login: "opencode auth login", install: "https://opencode.ai/docs" },
};

export function NativeAgentProviderDetails({ providerId, config, status, busy, onSave, onConnect }: {
  providerId: ChatProvider; config: ProviderConfig; status: ProviderStatus; busy: boolean;
  onSave(provider: ChatProvider, patch: ProviderConfigPatch): Promise<void>;
  onConnect(provider: ChatProvider): Promise<void>;
}) {
  const [binaryPath, setBinaryPath] = useState(config.binaryPath ?? "");
  const [sourceHome, setSourceHome] = useState(config.sourceHome ?? "");
  const info = setup[providerId]!;
  async function save(event: FormEvent) {
    event.preventDefault();
    await onSave(providerId, { binaryPath: binaryPath.trim() || null, sourceHome: sourceHome.trim() || null, enabled: true });
    await onConnect(providerId);
  }
  return <div className="provider-dialog-body">
    <p>{status.displayName} owns its login, tools and saved conversations. OpenPond uses the selected local installation.</p>
    <form className="provider-card-form" onSubmit={(event) => void save(event)}>
      <label className="settings-select-field"><span>Executable</span><input value={binaryPath} placeholder={`${info.executable} from PATH, or an absolute path`} disabled={busy} onChange={(event) => setBinaryPath(event.currentTarget.value)} /></label>
      <label className="settings-select-field"><span>Source home</span><input value={sourceHome} placeholder="Use the agent's existing home" disabled={busy} onChange={(event) => setSourceHome(event.currentTarget.value)} /></label>
      <div className="settings-button-row"><button className="settings-secondary" disabled={busy}>{busy ? "Connecting" : "Save and connect"}</button><button className="settings-secondary" type="button" disabled={busy} onClick={() => void onConnect(providerId)}>Refresh connection and models</button></div>
    </form>
    <p>For an existing installation, sign in with <code>{info.login}</code> and refresh the connection.</p>
    {providerId === "claude-code" ? <p>The Claude ACP adapter uses the Claude Agent SDK. Use an authentication route supported by Anthropic for this integration; an existing Claude subscription alone does not establish that entitlement.</p> : null}
    <a href={info.install} target="_blank" rel="noreferrer">Installation instructions</a>
  </div>;
}
