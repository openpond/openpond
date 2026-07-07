import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { BootstrapPayload } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";

export type SaveEnvironmentAccountInput = {
  apiKey: string;
  handle?: string | null;
  baseUrl: string;
  apiBaseUrl: string;
  environment?: string | null;
};

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

  useEffect(() => {
    if (!connection) setApiKey("");
  }, [connection]);

  async function switchAccount(handleValue: string, baseUrlValue?: string | null) {
    if (!connection) return;
    setSaving(true);
    onError(null);
    try {
      const switchedPayload = await api.switchOpenPondAccount(connection, {
        handle: handleValue,
        baseUrl: baseUrlValue ?? null,
      });
      const preferencesPayload = await api.savePreferences(connection, { defaultTeamId: null });
      onPayload({ ...switchedPayload, preferences: preferencesPayload.preferences });
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
      const savedPayload = await api.saveOpenPondAccount(connection, {
        apiKey: apiKey.trim(),
        setActive: true,
      });
      const preferencesPayload = await api.savePreferences(connection, { defaultTeamId: null });
      onPayload({ ...savedPayload, preferences: preferencesPayload.preferences });
      setApiKey("");
    } catch (saveError) {
      onError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function saveEnvironmentAccount(input: SaveEnvironmentAccountInput) {
    if (!connection || !input.apiKey.trim()) return;
    setSaving(true);
    onError(null);
    try {
      const handle = input.handle?.trim();
      const environment = input.environment?.trim();
      const savedPayload = await api.saveOpenPondAccount(connection, {
        apiKey: input.apiKey.trim(),
        handle: handle || undefined,
        baseUrl: input.baseUrl,
        apiBaseUrl: input.apiBaseUrl,
        environment: environment || "custom",
        setActive: true,
      });
      const preferencesPayload = await api.savePreferences(connection, { defaultTeamId: null });
      onPayload({ ...savedPayload, preferences: preferencesPayload.preferences });
      setApiKey("");
    } catch (saveError) {
      onError(saveError instanceof Error ? saveError.message : String(saveError));
      throw saveError;
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
    saveEnvironmentAccount,
    setApiKey,
    switchAccount,
  };
}
