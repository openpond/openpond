import "./native-agent-controls.css";
import { useEffect, useState } from "react";
import type { ProviderConfigPatch, ProviderSettings } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "../../api/api-client";
import { acquireNativeAgentCatalog, cachedNativeAgentCatalog, nativeAgentCatalogKey, saveNativeAgentCatalog, type NativeAgentCatalog } from "./native-agent-catalog";
import { DropdownSelect } from "../DropdownSelect";
import { Shield } from "../icons";

/** Vendor-advertised controls are defaults for this configured installation. */
export function NativeAgentControls({ connection, provider, providerSettings, disabled, placement = "top", onSettings, onSetup }: { connection: ClientConnection | null; provider: string; providerSettings?: ProviderSettings | null; disabled: boolean; placement?: "top" | "bottom"; onSettings(value: { provider: string; settings: ProviderSettings }): void; onSetup?(): void }) {
  const config = providerSettings?.providers[provider];
  const [loaded, setLoaded] = useState<{ connection: ClientConnection; provider: string; instance: string; value: NativeAgentCatalog } | null>(null);
  const instance = nativeAgentCatalogKey(provider, config);
  const retained = connection ? cachedNativeAgentCatalog(connection, provider, config) : null;
  const setup = loaded?.connection === connection && loaded.provider === provider && loaded.instance === instance ? loaded.value : retained;
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const supported = ["opencode", "grok-build", "claude-code"].includes(provider);
  useEffect(() => {
    setError(null);
    if (!connection || !supported) return;
    const catalog = acquireNativeAgentCatalog(connection, provider, config);
    let active = true;
    void catalog.promise
      .then((value) => { if (active) {
        if (value.error) setError(value.error);
        else {
          setLoaded({ connection, provider, instance, value });
          onSettings({ provider, settings: value.settings });
        }
      } })
      .catch((error: Error) => { if (active) setError(error.message); });
    return () => { active = false; catalog.release(); };
  }, [connection, provider, supported, onSettings, instance]);
  if (!supported || !connection) return null;
  const nativeMode = config?.nativeMode ?? setup?.session?.modes?.currentModeId ?? "";
  async function save(patch: ProviderConfigPatch) {
    if (!connection) return;
    setSaving(true);
    try {
      const settings = await apiFetch<ProviderSettings>(connection, "/v1/providers", { method: "PATCH", body: JSON.stringify({ providers: { [provider]: patch } }) });
      if (setup) {
        const value = { ...setup, settings };
        saveNativeAgentCatalog(connection, provider, value, config);
        setLoaded({ connection, provider, instance, value });
      }
      onSettings({ provider, settings }); setError(null);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save agent settings."); }
    finally { setSaving(false); }
  }
  return <>
    {config && !config.enabled ? <button type="button" disabled={disabled || saving} onClick={() => void save({ enabled: true })}>Enable agent</button> : null}
    {setup?.session?.modes ? <DropdownSelect
      compact
      className="permission-select"
      icon={<Shield size={14} />}
      placement={placement}
      label={provider === "claude-code" ? "Claude permissions" : "Agent mode"}
      disabled={disabled || saving}
      value={provider === "claude-code" && nativeMode === "default" ? "manual" : nativeMode}
      options={setup.session.modes.availableModes.map((mode) => ({
        value: mode.id,
        label: provider === "claude-code" && mode.id === "manual" ? "Ask" : mode.name,
        ...(provider === "claude-code" ? { description: mode.id === "plan"
          ? "Inspect and plan before making changes."
          : "Ask before actions that require permission." } : {}),
      }))}
      onChange={(value) => void save({ nativeMode: value })}
    /> : null}
    {setup?.session?.configOptions?.filter((option) => option.type === "select" && option.category !== "model" && option.category !== "mode").map((option) => <label className="composer-native-option" key={option.id}><span>{option.name}</span><select title={`Default ${option.name.toLowerCase()} for this agent installation`} disabled={disabled || saving} value={config?.nativeOptions?.[option.id] ?? option.currentValue} onChange={(event) => void save({ nativeOptions: { ...config?.nativeOptions, [option.id]: event.target.value } })}>{option.options?.flatMap((item) => "options" in item ? item.options : [item]).map((item) => <option key={item.value} value={item.value}>{item.name}</option>)}</select></label>)}
    {error || setup?.error ? <span role="status" title={error ?? setup?.error ?? undefined}>Agent needs attention{onSetup ? <button type="button" onClick={onSetup}>Open setup</button> : null}</span> : null}
  </>;
}
