import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderConfig, ProviderSettings } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import { apiFetch } from "../../api/api-client";
import { Check, ExternalLink, Loader2, Plus } from "../icons";
import { useNativeLogin } from "../terminal/NativeLoginProvider";
import { NativeSetupTerminal } from "../terminal/NativeSetupTerminal";
import type { NativeProviderCheck } from "../settings/native-provider-check";

type AgentId = "codex" | "claude-code";
const AGENTS = {
  codex: { name: "Codex", installUrl: "https://developers.openai.com/codex/cli" },
  "claude-code": { name: "Claude", installUrl: "https://code.claude.com/docs/en/setup" },
};

export function OnboardingAgentCard({ providerId, connection, config, onProviders }: {
  providerId: AgentId;
  connection: ClientConnection;
  config: ProviderConfig | undefined;
  onProviders: (providers: ProviderSettings) => void;
}) {
  const info = AGENTS[providerId];
  const nativeLogin = useNativeLogin();
  const loginActive = useRef(nativeLogin.active);
  loginActive.current = nativeLogin.active;
  const [result, setResult] = useState<NativeProviderCheck | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<{ command: string; displayCommand: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const latestProviders = useRef(onProviders);
  latestProviders.current = onProviders;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const check = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timeout = setTimeout(() => controller.abort(new Error("Connection check timed out. Try again.")), 45_000);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const next = await apiFetch<NativeProviderCheck>(connection, `/v1/providers/${providerId}/native-setup`, {
        method: "POST", body: JSON.stringify({ action: "check" }), signal: controller.signal,
      });
      if (active.current !== controller || controller.signal.aborted) return;
      setResult(next);
      setError(next.error);
      latestProviders.current(next.settings);
    } catch (caught) {
      if (active.current === controller) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      clearTimeout(timeout);
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }, [connection.serverUrl, connection.token, providerId]);

  useEffect(() => {
    if (!command && !(providerId === "claude-code" && loginActive.current)) void check();
    function onFocus() { if (!active.current && !command && !(providerId === "claude-code" && loginActive.current)) void check(); }
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      const controller = active.current;
      active.current = null;
      controller?.abort();
    };
  }, [check, config?.binaryPath, config?.sourceHome, command, providerId]);

  async function connect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.saveProviderSettings(connection, { providers: { [providerId]: { enabled: true } } });
      if (!mounted.current) return;
      latestProviders.current(next);
      await check();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  async function login() {
    if (busy) return;
    const controller = new AbortController();
    active.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    setBusy(true);
    setError(null);
    try {
      const next = await apiFetch<{ command: string; displayCommand: string }>(connection, `/v1/providers/${providerId}/native-setup`, {
        method: "POST", body: JSON.stringify({ action: "login" }), signal: controller.signal,
      });
      if (active.current !== controller || controller.signal.aborted) return;
      if (!config?.enabled) {
        const providers = await api.saveProviderSettings(connection, { providers: { [providerId]: { enabled: true } } });
        if (active.current !== controller || controller.signal.aborted) return;
        latestProviders.current(providers);
      }
      if (active.current === controller && !controller.signal.aborted) {
        if (providerId === "claude-code") nativeLogin.start(next);
        else setCommand(next);
      }
    } catch (caught) {
      if (active.current === controller) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      clearTimeout(timeout);
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }

  useEffect(() => {
    if (providerId !== "claude-code" || !nativeLogin.result) return;
    const verified = nativeLogin.result.settings.providers[providerId];
    if ((verified?.binaryPath || null) !== (config?.binaryPath || null) || (verified?.sourceHome || null) !== (config?.sourceHome || null)) return;
    setBusy(false);
    setResult(nativeLogin.result);
    setError(nativeLogin.result.status === "unavailable" ? nativeLogin.result.error : null);
  }, [nativeLogin.result, providerId, config?.binaryPath, config?.sourceHome]);

  const ready = !error && result?.status === "ready";
  return <li className="getting-started-card">
    <img className="getting-started-provider-icon" src={`/agent-sources/${providerId}.svg`} alt="" />
    <h3>{info.name}</h3>
    <div className="getting-started-card-status" role="status" aria-live="polite">
      {providerId === "claude-code" && nativeLogin.active ? <button type="button" onClick={nativeLogin.resume}>Continue sign-in</button>
        : busy ? <Loader2 className="settings-spin" size={20} aria-label={`Checking ${info.name}`} />
        : ready && config?.enabled ? <span><Check size={16} /> Connected</span>
        : ready ? <button type="button" aria-label={`Connect ${info.name}`} onClick={() => void connect()}><Plus size={14} /> Connect</button>
        : result?.status === "missing" ? <a href={info.installUrl} target="_blank" rel="noreferrer">Install {info.name} <ExternalLink size={12} /></a>
        : result?.status === "needs_login" ? <button type="button" className="getting-started-login" aria-label={`Log in to ${info.name}`} title={error ?? undefined} onClick={() => void login()}>Log in</button>
        : <button type="button" aria-label={`Retry ${info.name} connection`} title={error ?? "Check connection again"} onClick={() => void check()}>Retry</button>}
    </div>
    {command ? <NativeSetupTerminal modal connection={connection} command={command.command} displayCommand={command.displayCommand} onComplete={() => setCommand(null)} onClose={() => setCommand(null)} /> : null}
  </li>;
}
