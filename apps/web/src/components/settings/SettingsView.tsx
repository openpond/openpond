import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "../../styles/settings/settings-layout.css";
import "../../styles/settings/settings-forms.css";
import "../../styles/settings/settings-lists.css";
import "../../styles/settings/remote-access.css";
import "../../styles/settings/compute-settings.css";
import "../../styles/settings/notifications-settings.css";
import "../../styles/settings/harness-history.css";
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
import { DatasetStorageSettingsSection } from "./DatasetStorageSettingsSection";
import { HarnessHistorySettingsSection } from "./HarnessHistorySettingsSection";
import {
  HarnessReleaseDiffSidebar,
  type HarnessReleaseDiffSelection,
} from "./HarnessReleaseDiffSidebar";
import { useAccountSettings } from "./useAccountSettings";
import { useDefaultsSettings } from "./useDefaultsSettings";
import { useDiagnosticsSettings } from "./useDiagnosticsSettings";
import { useEditorSettings } from "./useEditorSettings";
import { usePersonalizationSettings } from "./usePersonalizationSettings";
import { useProviderSettings } from "./useProviderSettings";
import { useRemoteAccessSettings } from "./useRemoteAccessSettings";
import { useDatasetStorageState } from "./useDatasetStorageState";
import { useDatasetStorageSettings } from "./useDatasetStorageSettings";
import { WindowControls, isDesktopShell, isMacPlatform } from "../app-shell/WindowControls";
import { PanelRight } from "../icons";
import type { SkillSourceDocument } from "../app-shell/skill-source-document";

const HARNESS_SECTIONS = new Set<SettingsSection>([
  "harness",
  "harness-refiner",
  "harness-continuous-review",
  "harness-contents",
  "harness-releases",
]);

function harnessPageForSection(section: SettingsSection) {
  if (section === "harness-refiner") return "refiner" as const;
  if (section === "harness-continuous-review") return "continuous-review" as const;
  if (section === "harness-contents") return "contents" as const;
  if (section === "harness-releases") return "releases" as const;
  return "overview" as const;
}

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
  onAcceptEvaluationReview,
  onOpenSkill,
  onOpenExtension,
  teamChatCurrentUserId,
  teamChatEnabled,
  teamChatNotificationMode,
  teamChatThreads,
  onTeamChatNotificationModeChange,
  onTeamChatThreadMuteChange,
  diffPanelWidth,
  diffPanelResizing,
  diffPanelExpanded,
  onDiffPanelResizeStart,
  onDiffPanelExpandedChange,
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
  onAcceptEvaluationReview: (
    workspaceId: string,
    review: { id: string; contentHash: string },
  ) => Promise<boolean>;
  onOpenSkill: (skill: SkillSourceDocument) => void;
  onOpenExtension: (extension: OpenPondExtension) => void;
  teamChatCurrentUserId: string | null;
  teamChatEnabled: boolean;
  teamChatNotificationMode: TeamChatNotificationMode;
  teamChatThreads: TeamChatThread[];
  onTeamChatNotificationModeChange: (mode: TeamChatNotificationMode) => void;
  onTeamChatThreadMuteChange: (threadId: string, muted: boolean) => Promise<boolean>;
  diffPanelWidth: number;
  diffPanelResizing: boolean;
  diffPanelExpanded: boolean;
  onDiffPanelResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDiffPanelExpandedChange: (expanded: boolean) => void;
  initialSection?: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [harnessDiffSelection, setHarnessDiffSelection] = useState<HarnessReleaseDiffSelection | null>(null);
  const [harnessDiffOpen, setHarnessDiffOpen] = useState(false);
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
  const datasetStorageState = useDatasetStorageState({
    connection,
    enabled: datasetStorageEnabled,
    onError,
  });
  const datasetStorageSettings = useDatasetStorageSettings({
    connection,
    enabled: datasetStorageEnabled,
    onError,
    profileId: payload?.profile.activeProfile ?? "default",
  });
  const saveDatasetStorage = datasetStorageState.save;
  const refreshDatasetStorage = useCallback(
    async () => {
      await Promise.all([
        datasetStorageState.refresh(),
        datasetStorageSettings.refresh(),
      ]);
    },
    [datasetStorageState.refresh, datasetStorageSettings.refresh],
  );
  const confirmSubagentsNavigation = useCallback(() => {
    if (section !== "subagents" || !defaultsSettings.subagentsDirty) return true;
    return window.confirm("You have unsaved changes. Leave Subagents without saving?");
  }, [defaultsSettings.subagentsDirty, section]);
  const changeSection = useCallback(
    (nextSection: SettingsSection) => {
      if (nextSection === section) return;
      if (!confirmSubagentsNavigation()) return;
      setHarnessDiffOpen(false);
      onDiffPanelExpandedChange(false);
      setSection(nextSection);
    },
    [confirmSubagentsNavigation, onDiffPanelExpandedChange, section],
  );
  const goBack = useCallback(() => {
    if (!confirmSubagentsNavigation()) return;
    setHarnessDiffOpen(false);
    onDiffPanelExpandedChange(false);
    onBack();
  }, [confirmSubagentsNavigation, onBack, onDiffPanelExpandedChange]);

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

  const settingsStyle = {
    "--diff-panel-width": `${diffPanelWidth}px`,
  } as CSSProperties;
  const harnessSectionActive = HARNESS_SECTIONS.has(section);
  const harnessSidebarVisible = harnessSectionActive && harnessDiffOpen && harnessDiffSelection;

  return (
    <div
      className={`settings-shell ${isMac ? "platform-macos" : ""} ${harnessSidebarVisible ? "harness-diff-open" : ""} ${diffPanelExpanded ? "harness-diff-expanded" : ""} ${diffPanelResizing ? "diff-panel-resizing" : ""}`}
      style={settingsStyle}
    >
      <div className="settings-drag-region" aria-hidden="true" />
      <div className="settings-window-controls">
        {harnessSectionActive ? (
          <button
            type="button"
            className={`topbar-diff-button ${harnessSidebarVisible ? "active" : ""}`}
            title={`${harnessSidebarVisible ? "Hide" : "Show"} sidebar`}
            aria-label={`${harnessSidebarVisible ? "Hide" : "Show"} sidebar`}
            aria-pressed={Boolean(harnessSidebarVisible)}
            disabled={!harnessDiffSelection}
            onClick={() => setHarnessDiffOpen((open) => !open)}
          >
            <PanelRight size={16} />
          </button>
        ) : null}
        <WindowControls platform={connection?.platform} />
      </div>
      <SettingsNavigation section={section} onBack={goBack} onSectionChange={changeSection} />
      <main className={`settings-content ${section === "profile" || harnessSectionActive ? "settings-content-wide" : ""}`}>
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
        ) : harnessSectionActive ? (
          <HarnessHistorySettingsSection
            connection={connection}
            enabled={harnessSectionActive}
            onAcceptEvaluationReview={onAcceptEvaluationReview}
            onError={onError}
            onDefaultReleaseDiff={setHarnessDiffSelection}
            onOpenSourceSession={onOpenSourceSession}
            onOpenReleaseDiff={(selection) => {
              setHarnessDiffSelection(selection);
              setHarnessDiffOpen(true);
            }}
            onToast={onToast}
            page={harnessPageForSection(section)}
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
        ) : section === "dataset-storage" ? (
          <DatasetStorageSettingsSection
            state={datasetStorageState.state}
            catalog={datasetStorageSettings.catalog}
            busy={datasetStorageState.busy}
            catalogLoading={datasetStorageSettings.loading}
            onRefresh={refreshDatasetStorage}
            onSave={saveDatasetStorage}
          />
        ) : section === "defaults" ? (
          <div className="settings-stacked-sections">
            <DefaultsSettingsSection preferences={preferences} {...defaultsSettings} />
            <ContextSettingsSection embedded preferences={preferences} {...defaultsSettings} />
          </div>
        ) : section === "context" ? (
          <ContextSettingsSection preferences={preferences} {...defaultsSettings} />
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
      {harnessSectionActive && connection && harnessSidebarVisible ? (
        <HarnessReleaseDiffSidebar
          connection={connection}
          expanded={diffPanelExpanded}
          onResizeStart={onDiffPanelResizeStart}
          onToggleExpanded={() => onDiffPanelExpandedChange(!diffPanelExpanded)}
          selection={harnessSidebarVisible}
        />
      ) : null}
    </div>
  );
}
