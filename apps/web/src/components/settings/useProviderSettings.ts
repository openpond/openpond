import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type {
  AppPreferences,
  BootstrapPayload,
  ChatProvider,
  ProviderCredentialWriteRequest,
  ProviderConfigPatch,
  ProviderSettings,
  ProviderValidationRequest,
} from "@openpond/contracts";
import { api, type ClientConnection, type PreferencesPayload } from "../../api";
import { normalizeChatModel } from "../../lib/app-models";

export function useProviderSettings({
  connection,
  onError,
  onPayload,
  onPreferences,
  onProviders,
  preferences,
  providers,
}: {
  connection: ClientConnection | null;
  onError: (message: string | null) => void;
  onPayload: (payload: BootstrapPayload) => void;
  onPreferences: (payload: PreferencesPayload) => void;
  onProviders: (providers: ProviderSettings) => void;
  preferences: AppPreferences;
  providers: ProviderSettings | null | undefined;
}) {
  const [defaultProvider, setDefaultProvider] = useState<ChatProvider>(preferences.defaultChatProvider);
  const [defaultModel, setDefaultModel] = useState(preferences.defaultChatModel);
  const [saving, setSaving] = useState(false);
  const [providerBusy, setProviderBusy] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  useEffect(() => {
    setDefaultProvider(preferences.defaultChatProvider);
    setDefaultModel(preferences.defaultChatModel);
  }, [preferences.defaultChatProvider, preferences.defaultChatModel]);

  async function saveProviders(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connection) return;
    setSaving(true);
    onError(null);
    try {
      onPreferences(
        await api.savePreferences(connection, {
          defaultChatProvider: defaultProvider,
          defaultChatModel: normalizeChatModel(defaultProvider, defaultModel, providers),
        })
      );
    } catch (saveError) {
      onError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  function changeDefaultProvider(provider: ChatProvider) {
    setDefaultProvider(provider);
    setDefaultModel((current) => normalizeChatModel(provider, current, providers));
  }

  async function runProviderAction<T>(
    provider: ChatProvider,
    action: string,
    task: () => Promise<T>,
  ): Promise<T | null> {
    if (!connection) return null;
    setProviderBusy(`${provider}:${action}`);
    setValidationMessage(null);
    onError(null);
    try {
      return await task();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setProviderBusy(null);
    }
  }

  async function saveProviderConfig(provider: ChatProvider, patch: ProviderConfigPatch) {
    await runProviderAction(provider, "config", async () => {
      const nextProviders = await api.saveProviderSettings(connection!, {
        providers: { [provider]: patch },
      });
      onProviders(nextProviders);
      return nextProviders;
    });
  }

  async function saveProviderCredential(
    provider: ChatProvider,
    credential: ProviderCredentialWriteRequest,
  ) {
    await runProviderAction(provider, "credential", async () => {
      const nextProviders = await api.saveProviderCredential(connection!, provider, credential);
      onProviders(nextProviders);
      return nextProviders;
    });
  }

  async function deleteProviderCredential(provider: ChatProvider) {
    await runProviderAction(provider, "credential", async () => {
      const nextProviders = await api.deleteProviderCredential(connection!, provider, {});
      onProviders(nextProviders);
      return nextProviders;
    });
  }

  async function refreshProviderModels(provider: ChatProvider) {
    await runProviderAction(provider, "models", async () => {
      const result = await api.refreshProviderModels(connection!, provider, { force: true });
      onProviders(result.providers);
      return result;
    });
  }

  async function loadProviderModels(provider: ChatProvider) {
    await runProviderAction(provider, "models", async () => {
      const result = await api.loadProviderModels(connection!, provider, { limit: 500 });
      onProviders(result.providers);
      return result;
    });
  }

  async function validateProvider(provider: ChatProvider, request: ProviderValidationRequest = {}) {
    await runProviderAction(provider, "validate", async () => {
      const validation = await api.validateProviderCredential(connection!, provider, request);
      setValidationMessage(
        validation.ok
          ? `${provider} validated${validation.modelId ? ` with ${validation.modelId}` : ""}.`
          : validation.errors.join("\n") || `${provider} validation failed.`,
      );
      onProviders(validation.providers);
      return validation;
    });
  }

  return {
    defaultModel,
    defaultProvider,
    providerBusy,
    saving,
    validationMessage,
    changeDefaultProvider,
    deleteProviderCredential,
    loadProviderModels,
    refreshProviderModels,
    saveProviderConfig,
    saveProviderCredential,
    saveProviders,
    setDefaultModel,
    validateProvider,
  };
}
