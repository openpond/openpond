import { useState } from "react";
import type { FormEvent } from "react";
import type { BootstrapPayload } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";

export function useAccountSettings({
  connection,
  onError,
  onPayload,
}: {
  connection: ClientConnection | null;
  onError: (message: string | null) => void;
  onPayload: (payload: BootstrapPayload) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshingAccounts, setRefreshingAccounts] = useState(false);

  async function switchAccount(handleValue: string, baseUrlValue?: string | null) {
    if (!connection) return;
    setSaving(true);
    onError(null);
    try {
      await api.switchOpenPondAccount(connection, {
        handle: handleValue,
        baseUrl: baseUrlValue ?? null,
      });
      onPayload(await api.savePreferences(connection, { defaultTeamId: null }));
    } catch (switchError) {
      onError(switchError instanceof Error ? switchError.message : String(switchError));
    } finally {
      setSaving(false);
    }
  }

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connection || !apiKey.trim()) return;
    setSaving(true);
    onError(null);
    try {
      await api.saveOpenPondAccount(connection, {
        apiKey: apiKey.trim(),
        setActive: true,
      });
      onPayload(await api.savePreferences(connection, { defaultTeamId: null }));
      setApiKey("");
    } catch (saveError) {
      onError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function refreshAccounts() {
    if (!connection) return;
    setRefreshingAccounts(true);
    onError(null);
    try {
      onPayload(await api.refreshOpenPondAccounts(connection));
    } catch (refreshError) {
      onError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setRefreshingAccounts(false);
    }
  }

  return {
    apiKey,
    refreshingAccounts,
    saving,
    refreshAccounts,
    saveAccount,
    setApiKey,
    switchAccount,
  };
}
