import "./native-agent-controls.css";
import { useEffect, useState } from "react";
import type { ProviderConfigPatch, ProviderSettings } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";

type Option = { value: string; name: string };
type Setup = { error: string | null; settings: ProviderSettings; session: null | {
  modes?: { currentModeId: string; availableModes: Array<{ id: string; name: string }> };
  configOptions?: Array<{ id: string; name: string; category?: string; currentValue: string; type: string; options?: Array<Option | { group: string; options: Option[] }> }>;
} };

/** Vendor-advertised controls are defaults for this configured installation. */
export function NativeAgentControls({ connection, provider, disabled, onSettings }: { connection: ClientConnection | null; provider: string; disabled: boolean; onSettings(value: { provider: string; settings: ProviderSettings }): void }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const supported = ["opencode", "grok-build", "claude-code"].includes(provider);
  useEffect(() => {
    setSetup(null); setError(null);
    if (!connection || !supported) return;
    const controller = new AbortController();
    void apiFetch<Setup>(connection, `/v1/providers/${provider}/native-setup`, { method: "POST", body: JSON.stringify({ action: "capabilities" }), signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) { setSetup(value); onSettings({ provider, settings: value.settings }); } })
      .catch((error: Error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [connection, provider, supported, onSettings]);
  if (!supported || !connection) return null;
  const config = setup?.settings.providers[provider];
  async function save(patch: ProviderConfigPatch) {
    if (!connection) return;
    setSaving(true);
    try {
      const settings = await apiFetch<ProviderSettings>(connection, "/v1/providers", { method: "PATCH", body: JSON.stringify({ providers: { [provider]: patch } }) });
      setSetup((value) => value ? { ...value, settings } : value); onSettings({ provider, settings }); setError(null);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save agent settings."); }
    finally { setSaving(false); }
  }
  return <>
    {setup?.session?.modes ? <label className="composer-native-option"><span>Mode</span><select title="Default mode for this agent installation" disabled={disabled || saving} value={config?.nativeMode ?? setup.session.modes.currentModeId} onChange={(event) => void save({ nativeMode: event.target.value })}>{setup.session.modes.availableModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.name}</option>)}</select></label> : null}
    {setup?.session?.configOptions?.filter((option) => option.type === "select" && option.category !== "model" && option.category !== "mode").map((option) => <label className="composer-native-option" key={option.id}><span>{option.name}</span><select title={`Default ${option.name.toLowerCase()} for this agent installation`} disabled={disabled || saving} value={config?.nativeOptions?.[option.id] ?? option.currentValue} onChange={(event) => void save({ nativeOptions: { ...config?.nativeOptions, [option.id]: event.target.value } })}>{option.options?.flatMap((item) => "options" in item ? item.options : [item]).map((item) => <option key={item.value} value={item.value}>{item.name}</option>)}</select></label>)}
    {error || setup?.error ? <span role="status" title={error ?? setup?.error ?? undefined}>Agent needs attention</span> : null}
  </>;
}
