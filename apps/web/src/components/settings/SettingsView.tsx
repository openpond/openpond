import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import "../../styles/settings/settings-layout.css";
import "../../styles/settings/settings-forms.css";
import "../../styles/settings/settings-lists.css";
import "../../styles/settings/remote-access.css";
import "../../styles/settings/compute-settings.css";
import "../../styles/settings/notifications-settings.css";
import type {
  BootstrapPayload,
  OpenPondExtension,
  ProviderSettings,
  RuntimeEvent,
  TeamChatThread,
} from "@openpond/contracts";
import type { ClientConnection, PreferencesPayload } from "../../api";
import { EMPTY_PERSONALIZATION, normalizePreferences } from "../../lib/app-models";
import type { SettingsSection } from "../../lib/app-models";
import type { TeamChatNotificationMode } from "../../lib/team-chat-notifications";
import { AccountSettingsSection } from "./AccountSettingsSection";
import { DefaultsSettingsSection } from "./DefaultsSettingsSection";
import { DiagnosticsSettingsSection } from "./DiagnosticsSettingsSection";
import { EditorSettingsSection } from "./EditorSettingsSection";
import {
  ContextSettingsSection,
  GoalsSettingsSection,
  InsightsSettingsSection,
  SubagentsSettingsSection,
} from "./HarnessSettingsSections";
import { NotificationsSettingsSection } from "./NotificationsSettingsSection";
import { PersonalizationSettingsSection } from "./PersonalizationSettingsSection";
import { ProfileSettingsSection } from "./ProfileSettingsSection";
import { ProviderSettingsSection } from "./ProviderSettingsSection";
import { RemoteAccessSettingsSection } from "./RemoteAccessSettingsSection";
import { SettingsNavigation } from "./SettingsNavigation";
import { SkillsSettingsSection } from "./SkillsSettingsSection";
import { TrainingSettingsSection } from "./TrainingSettingsSection";
import { ComputeSettingsSection } from "./ComputeSettingsSection";
import { DatasetStorageSettingsSection } from "./DatasetStorageSettingsSection";
import { useAccountSettings } from "./useAccountSettings";
import { useDefaultsSettings } from "./useDefaultsSettings";
import { useDiagnosticsSettings } from "./useDiagnosticsSettings";
import { useEditorSettings } from "./useEditorSettings";
import { usePersonalizationSettings } from "./usePersonalizationSettings";
import { useProviderSettings } from "./useProviderSettings";
import { useRemoteAccessSettings } from "./useRemoteAccessSettings";
import { useComputeSettings } from "./useComputeSettings";
import { useDatasetStorageSettings } from "./useDatasetStorageSettings";
import { WindowControls, isDesktopShell, isMacPlatform } from "../app-shell/WindowControls";
import type { SkillSourceDocument } from "../app-shell/skill-source-document";

const UsageSettingsSection = lazy(() =>
  import("./UsageSettingsSection").then((module) => ({ default: module.UsageSettingsSection })),
);

export function SettingsView({
  payload,
  connection,
  diagnostics,
  onPayload,
  onError,
  onToast,
  onBack,
  onOpenSourceSession,
  onOpenSkill,
  onOpenExtension,
  teamChatCurrentUserId,
  teamChatEnabled,
  teamChatNotificationMode,
  teamChatThreads,
  onTeamChatNotificationModeChange,
  onTeamChatThreadMuteChange,
  initialSection = "account",
}: {
  payload: BootstrapPayload | null;
  connection: ClientConnection | null;
  diagnostics?: RuntimeEvent[];
  onPayload: (payload: BootstrapPayload) => void;
  onError: (message: string | null) => void;
  onToast?: (message: string, tone?: "success" | "error" | "info") => void;
  onBack: () => void;
  onOpenSourceSession?: (sessionId: string) => void;
  onOpenSkill: (skill: SkillSourceDocument) => void;
  onOpenExtension: (extension: OpenPondExtension) => void;
  teamChatCurrentUserId: string | null;
  teamChatEnabled: boolean;
  teamChatNotificationMode: TeamChatNotificationMode;
  teamChatThreads: TeamChatThread[];
  onTeamChatNotificationModeChange: (mode: TeamChatNotificationMode) => void;
  onTeamChatThreadMuteChange: (threadId: string, muted: boolean) => Promise<boolean>;
  initialSection?: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const codex = payload?.codex ?? null;
  const preferences = useMemo(() => normalizePreferences(payload?.preferences), [payload?.preferences]);
  const personalization = payload?.personalization ?? EMPTY_PERSONALIZATION;
  const savedDiagnostics = diagnostics ?? payload?.diagnostics ?? [];
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
  const applyExtensionCatalog = useCallback(
    (extensionCatalog: BootstrapPayload["extensionCatalog"]) => {
      if (!payload) return;
      onPayload({ ...payload, extensionCatalog });
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
  const datasetStorageEnabled = section === "dataset-storage";
  const computeSettings = useComputeSettings({
    connection,
    enabled: section === "compute" || datasetStorageEnabled,
    onError,
  });
  const datasetStorageSettings = useDatasetStorageSettings({
    connection,
    enabled: datasetStorageEnabled,
    onError,
    profileId: payload?.profile.activeProfile ?? "default",
  });
  const saveDatasetStorage = useCallback(
    (datasetStorePath: string | null) => computeSettings.save(
      computeSettings.state?.settings.modelStorePath ?? null,
      datasetStorePath,
      computeSettings.state?.settings.defaultDeviceIds ?? [],
    ),
    [
      computeSettings.save,
      computeSettings.state?.settings.defaultDeviceIds,
      computeSettings.state?.settings.modelStorePath,
    ],
  );
  const refreshDatasetStorage = useCallback(
    async () => {
      await Promise.all([
        computeSettings.refresh(),
        datasetStorageSettings.refresh(),
      ]);
    },
    [computeSettings.refresh, datasetStorageSettings.refresh],
  );
  const confirmSubagentsNavigation = useCallback(() => {
    if (section !== "subagents" || !defaultsSettings.subagentsDirty) return true;
    return window.confirm("You have unsaved changes. Leave Subagents without saving?");
  }, [defaultsSettings.subagentsDirty, section]);
  const changeSection = useCallback(
    (nextSection: SettingsSection) => {
      if (nextSection === section) return;
      if (!confirmSubagentsNavigation()) return;
      setSection(nextSection);
    },
    [confirmSubagentsNavigation, section],
  );
  const goBack = useCallback(() => {
    if (!confirmSubagentsNavigation()) return;
    onBack();
  }, [confirmSubagentsNavigation, onBack]);

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    if (section !== "subagents" || !defaultsSettings.subagentsDirty) return undefined;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "You have unsaved changes.";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [defaultsSettings.subagentsDirty, section]);

  return (
    <div className={`settings-shell ${isMac ? "platform-macos" : ""}`}>
      <div className="settings-drag-region" aria-hidden="true" />
      <div className="settings-window-controls">
        <WindowControls platform={connection?.platform} />
      </div>
      <SettingsNavigation section={section} onBack={goBack} onSectionChange={changeSection} />
      <main className={`settings-content ${section === "profile" ? "settings-content-wide" : ""}`}>
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
        ) : section === "notifications" ? (
          <NotificationsSettingsSection
            currentUserId={teamChatCurrentUserId}
            enabled={teamChatEnabled}
            mode={teamChatNotificationMode}
            threads={teamChatThreads}
            onModeChange={onTeamChatNotificationModeChange}
            onThreadMuteChange={onTeamChatThreadMuteChange}
          />
        ) : section === "profile" ? (
          <ProfileSettingsSection
            payload={payload}
            connection={connection}
            onPayload={onPayload}
            onError={onError}
            onToast={onToast}
          />
        ) : section === "skills" ? (
          <SkillsSettingsSection
            personalSkills={payload?.codexPersonalSkills ?? []}
            extensionCatalog={payload?.extensionCatalog ?? {
              rootPath: "",
              registryPath: "",
              extensions: [],
              error: null,
            }}
            connection={connection}
            onExtensionCatalog={applyExtensionCatalog}
            onError={onError}
            onToast={onToast}
            onOpenSkill={onOpenSkill}
            onOpenExtension={onOpenExtension}
          />
        ) : section === "providers" ? (
          <ProviderSettingsSection
            account={payload?.account ?? null}
            codex={codex}
            providers={payload?.providers ?? null}
            {...providerSettings}
          />
        ) : section === "compute" ? (
          <ComputeSettingsSection
            state={computeSettings.state}
            busy={computeSettings.busy}
            onScan={computeSettings.scan}
            onSave={computeSettings.save}
            onDownloadSmolLm2={computeSettings.downloadSmolLm2}
            onCancelDownload={computeSettings.cancelDownload}
          />
        ) : section === "dataset-storage" ? (
          <DatasetStorageSettingsSection
            state={computeSettings.state}
            catalog={datasetStorageSettings.catalog}
            busy={computeSettings.busy}
            catalogLoading={datasetStorageSettings.loading}
            onRefresh={refreshDatasetStorage}
            onSave={saveDatasetStorage}
          />
        ) : section === "defaults" ? (
          <DefaultsSettingsSection preferences={preferences} {...defaultsSettings} />
        ) : section === "goals" ? (
          <GoalsSettingsSection preferences={preferences} {...defaultsSettings} />
        ) : section === "context" ? (
          <ContextSettingsSection preferences={preferences} {...defaultsSettings} />
        ) : section === "insights" ? (
          <InsightsSettingsSection
            preferences={preferences}
            providers={payload?.providers ?? null}
            {...defaultsSettings}
          />
        ) : section === "training" ? (
          <TrainingSettingsSection
            connection={connection}
            onError={onError}
            onPreferences={applyPreferencesPayload}
            preferences={preferences}
            providers={payload?.providers ?? null}
          />
        ) : section === "subagents" ? (
          <SubagentsSettingsSection
            preferences={preferences}
            providers={payload?.providers ?? null}
            {...defaultsSettings}
          />
        ) : section === "editor" ? (
          <EditorSettingsSection preferences={preferences} {...editorSettings} />
        ) : section === "remote" ? (
          <RemoteAccessSettingsSection {...remoteAccessSettings} />
        ) : section === "usage" ? (
          <Suspense fallback={<div className="usage-load-state">Loading activity…</div>}>
            <UsageSettingsSection
              account={payload?.account ?? null}
              connection={connection}
              enabled={section === "usage"}
              onError={onError}
              onOpenSourceSession={onOpenSourceSession}
            />
          </Suspense>
        ) : section === "personalization" ? (
          <PersonalizationSettingsSection {...personalizationSettings} />
        ) : (
          <DiagnosticsSettingsSection diagnostics={savedDiagnostics} {...diagnosticsSettings} />
        )}
      </main>
    </div>
  );
}
