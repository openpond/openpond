import { useCallback, useEffect, useMemo, useState } from "react";
import type { BootstrapPayload, ProviderSettings } from "@openpond/contracts";
import type { ClientConnection, PreferencesPayload } from "../../api";
import { EMPTY_PERSONALIZATION, normalizePreferences } from "../../lib/app-models";
import type { SettingsSection } from "../../lib/app-models";
import { AccountSettingsSection } from "./AccountSettingsSection";
import { DefaultsSettingsSection } from "./DefaultsSettingsSection";
import { DiagnosticsSettingsSection } from "./DiagnosticsSettingsSection";
import { EditorSettingsSection } from "./EditorSettingsSection";
import { PersonalizationSettingsSection } from "./PersonalizationSettingsSection";
import { ProfileSettingsSection } from "./ProfileSettingsSection";
import { ProviderSettingsSection } from "./ProviderSettingsSection";
import { RemoteAccessSettingsSection } from "./RemoteAccessSettingsSection";
import { SettingsNavigation } from "./SettingsNavigation";
import { UsageSettingsSection } from "./UsageSettingsSection";
import { WalletView } from "../wallet/WalletView";
import { useAccountSettings } from "./useAccountSettings";
import { useDefaultsSettings } from "./useDefaultsSettings";
import { useDiagnosticsSettings } from "./useDiagnosticsSettings";
import { useEditorSettings } from "./useEditorSettings";
import { usePersonalizationSettings } from "./usePersonalizationSettings";
import { useProviderSettings } from "./useProviderSettings";
import { useRemoteAccessSettings } from "./useRemoteAccessSettings";
import { WindowControls, isDesktopShell, isMacPlatform } from "../app-shell/WindowControls";

export function SettingsView({
  payload,
  connection,
  onPayload,
  onError,
  onToast,
  onBack,
  onOpenSourceSession,
  initialSection = "account",
}: {
  payload: BootstrapPayload | null;
  connection: ClientConnection | null;
  onPayload: (payload: BootstrapPayload) => void;
  onError: (message: string | null) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
  onBack: () => void;
  onOpenSourceSession?: (sessionId: string) => void;
  initialSection?: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const codex = payload?.codex ?? null;
  const preferences = useMemo(() => normalizePreferences(payload?.preferences), [payload?.preferences]);
  const personalization = payload?.personalization ?? EMPTY_PERSONALIZATION;
  const isMac = isDesktopShell() && isMacPlatform(connection?.platform);
  const applyProviderSettings = useCallback(
    (providers: ProviderSettings) => {
      if (!payload) return;
      onPayload({ ...payload, providers });
    },
    [onPayload, payload],
  );
  const applyPreferencesPayload = useCallback(
    (preferencesPayload: PreferencesPayload) => {
      if (!payload) return;
      onPayload({ ...payload, preferences: preferencesPayload.preferences });
    },
    [onPayload, payload],
  );
  const accountSettings = useAccountSettings({ connection, onError, onPayload });
  const providerSettings = useProviderSettings({
    connection,
    onError,
    onPayload,
    onPreferences: applyPreferencesPayload,
    onProviders: applyProviderSettings,
    preferences,
    providers: payload?.providers ?? null,
  });
  const defaultsSettings = useDefaultsSettings({
    connection,
    onError,
    onPayload,
    onPreferences: applyPreferencesPayload,
    preferences,
    providers: payload?.providers ?? null,
  });
  const editorSettings = useEditorSettings({
    connection,
    enabled: section === "editor",
    onError,
    onPayload,
    onPreferences: applyPreferencesPayload,
    onToast,
    preferences,
  });
  const personalizationSettings = usePersonalizationSettings({ connection, onError, onPayload, personalization });
  const diagnosticsSettings = useDiagnosticsSettings({ onError, section });
  const remoteAccessSettings = useRemoteAccessSettings({ connection, enabled: section === "remote", onError, onToast });

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  return (
    <div className={`settings-shell ${isMac ? "platform-macos" : ""}`}>
      <div className="settings-drag-region" aria-hidden="true" />
      <div className="settings-window-controls">
        <WindowControls platform={connection?.platform} />
      </div>
      <SettingsNavigation section={section} onBack={onBack} onSectionChange={setSection} />
      <main className="settings-content">
        {section === "account" ? (
          <AccountSettingsSection
            payload={payload}
            connection={connection}
            onPayload={onPayload}
            onPreferences={applyPreferencesPayload}
            onError={onError}
            onToast={onToast}
            {...accountSettings}
          />
        ) : section === "wallet" ? (
          <WalletView payload={payload} />
        ) : section === "profile" ? (
          <ProfileSettingsSection
            payload={payload}
            connection={connection}
            onPayload={onPayload}
            onError={onError}
            onToast={onToast}
          />
        ) : section === "providers" ? (
          <ProviderSettingsSection
            account={payload?.account ?? null}
            codex={codex}
            providers={payload?.providers ?? null}
            {...providerSettings}
          />
        ) : section === "defaults" ? (
          <DefaultsSettingsSection
            preferences={preferences}
            providers={payload?.providers ?? null}
            {...defaultsSettings}
          />
        ) : section === "editor" ? (
          <EditorSettingsSection preferences={preferences} {...editorSettings} />
        ) : section === "remote" ? (
          <RemoteAccessSettingsSection {...remoteAccessSettings} />
        ) : section === "usage" ? (
          <UsageSettingsSection
            connection={connection}
            enabled={section === "usage"}
            onError={onError}
            onOpenSourceSession={onOpenSourceSession}
          />
        ) : section === "personalization" ? (
          <PersonalizationSettingsSection {...personalizationSettings} />
        ) : (
          <DiagnosticsSettingsSection {...diagnosticsSettings} />
        )}
      </main>
    </div>
  );
}
