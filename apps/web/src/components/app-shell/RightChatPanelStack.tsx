import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  BootstrapPayload,
  ChatAttachment,
  ChatProvider,
  CodexPersonalSkill,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondCommandAccessMode,
  OpenPondApp,
  OpenPondExtensionCatalog,
  OpenPondProfileLibrary,
  OpenPondProfileSkill,
  ResolveApprovalRequest,
  Session,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import type { ConnectedAppMentionOption } from "../../lib/connected-app-mentions";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import type { WorkspaceTargetState, WorkspaceTargetValue } from "../../lib/workspace-location";
import type { ComposerProjectTargetState, ComposerSubmitOptions } from "../chat/Composer";
import type { ComposerProfileTargetState } from "../chat/ComposerControls";
import type { ComposerCreateImproveActions } from "../chat/ComposerCreateImproveStrip";
import type { ComposerSlashCommand } from "../../lib/composer-slash-commands";
import { FolderOpen, MessageSquare, Plus, X } from "../icons";
import { mostRecentlyActivatedRightChatPanel } from "../../lib/right-chat-panels";
import {
  buildOpenPondProfileActionCatalog,
  isOpenPondProfileAction,
} from "../../lib/openpond-action-run";
import {
  composerProfileTargetForLibrary,
  composerSkillsForProfile,
  profileStateForRef,
} from "../../lib/profile-selection";
import { RightChatPane } from "./RightChatPane";
import type { RightChatPanelView } from "./right-chat-panel-types";

export type { RightChatPanelView } from "./right-chat-panel-types";

export function RightChatPanelStack({
  panels,
  actionCatalog = [],
  createImproveActions,
  busy,
  codexPermissionMode,
  codexReasoningEffort,
  openPondCommandAccessMode,
  connection,
  connectedAppMentions,
  mentionApps,
  codexPersonalSkills,
  profileSkills = [],
  profileLibrary = { lastUsed: null, profiles: [] },
  extensionCatalog,
  projectTarget,
  providerSettings,
  accountBaseUrl,
  billingOrganizationSlug,
  billingTeamId,
  showToast,
  workspaceTarget,
  onAddChat,
  onActivatePanel,
  onClosePanel,
  onCodexPermissionModeChange,
  onCodexReasoningEffortChange,
  onOpenPondCommandAccessModeChange,
  onModelChange,
  onOpenFileInSidebar,
  onOpenProfileSettings,
  onOpenSession,
  onProviderChange,
  onProviderSetupOpen,
  onPromptChange,
  onProfileTargetChange,
  onScrollStateChange,
  onProjectTargetChange,
  onResolveApproval,
  onResizeStart,
  onSelectFiles,
  onShowBrowserPanel,
  onStop,
  onSubmit,
  onWorkspaceTargetChange,
}: {
  panels: RightChatPanelView[];
  actionCatalog?: SandboxActionCatalogEntry[];
  createImproveActions: ComposerCreateImproveActions;
  busy: boolean;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  openPondCommandAccessMode: OpenPondCommandAccessMode;
  connection: ClientConnection | null;
  connectedAppMentions: ConnectedAppMentionOption[];
  mentionApps: OpenPondApp[];
  codexPersonalSkills: CodexPersonalSkill[];
  profileSkills: OpenPondProfileSkill[];
  profileLibrary: OpenPondProfileLibrary;
  extensionCatalog: OpenPondExtensionCatalog | null;
  projectTarget: ComposerProjectTargetState;
  providerSettings?: BootstrapPayload["providers"] | null;
  accountBaseUrl?: string | null;
  billingOrganizationSlug?: string | null;
  billingTeamId?: string | null;
  showToast: ShowAppToast;
  workspaceTarget: WorkspaceTargetState;
  onAddChat: () => void;
  onActivatePanel: (panelId: string) => void;
  onClosePanel: (panelId: string) => void;
  onCodexPermissionModeChange: (mode: CodexPermissionMode) => void;
  onCodexReasoningEffortChange: (effort: CodexReasoningEffort) => void;
  onOpenPondCommandAccessModeChange: (mode: OpenPondCommandAccessMode, session?: Session | null) => void;
  onModelChange: (panelId: string, model: string) => void;
  onOpenFileInSidebar: (path: string) => void;
  onOpenProfileSettings: () => void;
  onOpenSession?: (sessionId: string) => void;
  onProviderChange: (panelId: string, provider: ChatProvider) => void;
  onProviderSetupOpen: () => void;
  onPromptChange: (panelId: string, prompt: string) => void;
  onProfileTargetChange: (sessionId: string | null, value: string) => void;
  onScrollStateChange: (
    panelId: string,
    state: { scrollTop: number; stickyToBottom: boolean },
  ) => void;
  onProjectTargetChange: (value: string) => void;
  onResolveApproval: (
    approvalId: string,
    decision: ResolveApprovalRequest["decision"],
  ) => Promise<void>;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelectFiles: () => void;
  onShowBrowserPanel: () => void;
  onStop: (sessionId: string | null) => Promise<boolean>;
  onSubmit: (
    panelId: string,
    attachments?: ChatAttachment[],
    action?: SandboxActionCatalogEntry | null,
    command?: ComposerSlashCommand | null,
    options?: ComposerSubmitOptions,
  ) => Promise<boolean>;
  onWorkspaceTargetChange: (target: WorkspaceTargetValue) => void;
}) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [activePanelId, setActivePanelId] = useState(
    () => mostRecentlyActivatedRightChatPanel(panels)?.id ?? null,
  );
  const addAnchorRef = useRef<HTMLDivElement | null>(null);
  const tabButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const previousPanelIdsRef = useRef<Set<string>>(new Set(panels.map((panel) => panel.id)));
  const previousActivationVersionsRef = useRef<Map<string, number>>(
    new Map(panels.map((panel) => [panel.id, panel.activationVersion])),
  );
  const activePanel = panels.find((panel) => panel.id === activePanelId) ?? panels.at(-1) ?? null;
  const activeProfileRef = activePanel?.session?.currentProfile ?? profileLibrary.lastUsed;
  const activeProfileState = profileStateForRef(profileLibrary, activeProfileRef);
  const activeProfileSkills = activeProfileState
    ? composerSkillsForProfile(activeProfileState, extensionCatalog)
    : profileSkills;
  const activeActionCatalog = activeProfileState
    ? [
        ...actionCatalog.filter((action) => !isOpenPondProfileAction(action)),
        ...buildOpenPondProfileActionCatalog(activeProfileState),
      ]
    : actionCatalog;
  const profileTarget: ComposerProfileTargetState | null =
    composerProfileTargetForLibrary(profileLibrary, activeProfileRef);

  useEffect(() => {
    const previousPanelIds = previousPanelIdsRef.current;
    const previousActivationVersions = previousActivationVersionsRef.current;
    let addedPanel: RightChatPanelView | null = null;
    let activatedPanel: RightChatPanelView | null = null;
    for (const panel of panels) {
      if (!previousPanelIds.has(panel.id)) addedPanel = panel;
      if (
        previousPanelIds.has(panel.id)
        && panel.activationVersion > (previousActivationVersions.get(panel.id) ?? 0)
      ) {
        activatedPanel = panel;
      }
    }
    previousPanelIdsRef.current = new Set(panels.map((panel) => panel.id));
    previousActivationVersionsRef.current = new Map(
      panels.map((panel) => [panel.id, panel.activationVersion]),
    );
    setActivePanelId((current) => {
      if (activatedPanel) return activatedPanel.id;
      if (addedPanel) return addedPanel.id;
      if (current && panels.some((panel) => panel.id === current)) return current;
      return panels.at(-1)?.id ?? null;
    });
  }, [panels]);

  useEffect(() => {
    if (!addMenuOpen) return undefined;
    function handlePointerDown(event: PointerEvent) {
      if (addAnchorRef.current?.contains(event.target as Node)) return;
      setAddMenuOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setAddMenuOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [addMenuOpen]);

  const selectPanel = useCallback((panelId: string, focus = false) => {
    setActivePanelId(panelId);
    onActivatePanel(panelId);
    if (focus) window.requestAnimationFrame(() => tabButtonRefs.current.get(panelId)?.focus());
  }, [onActivatePanel]);

  const selectFiles = useCallback((focus = false) => {
    onSelectFiles();
    if (!focus) return;
    window.requestAnimationFrame(() => {
      document.getElementById("right-sidebar-files-tab")?.focus();
    });
  }, [onSelectFiles]);

  const handleTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, panelId: string) => {
    const currentIndex = panels.findIndex((panel) => panel.id === panelId);
    if (currentIndex < 0) return;
    const tabIndex = currentIndex + 1;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (tabIndex + 1) % (panels.length + 1);
    if (event.key === "ArrowLeft") nextIndex = (tabIndex - 1 + panels.length + 1) % (panels.length + 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = panels.length;
    if (nextIndex === null) return;
    event.preventDefault();
    if (nextIndex === 0) {
      selectFiles(true);
      return;
    }
    const nextPanel = panels[nextIndex - 1];
    if (nextPanel) selectPanel(nextPanel.id, true);
  }, [panels, selectFiles, selectPanel]);

  const handleFilesTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") return;
    const nextPanel = event.key === "ArrowLeft" || event.key === "End"
      ? panels.at(-1)
      : panels[0];
    if (nextPanel) selectPanel(nextPanel.id, true);
  }, [panels, selectPanel]);

  return (
    <aside className="workspace-diff-panel right-chat-panel-stack" aria-label="Side chats">
      <div
        className="workspace-diff-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side chat panel"
        onPointerDown={onResizeStart}
      />
      <div className="workspace-diff-topbar right-chat-topbar">
        <div className="workspace-diff-tabs" role="tablist" aria-label="Right sidebar views">
          <button
            type="button"
            className="workspace-diff-tab"
            role="tab"
            id="right-sidebar-files-tab"
            aria-controls="right-sidebar-files-panel"
            aria-selected={false}
            tabIndex={-1}
            onClick={() => selectFiles(false)}
            onKeyDown={handleFilesTabKeyDown}
          >
            <FolderOpen size={14} />
            <span>Files</span>
          </button>
          {panels.map((panel) => {
            const active = panel.id === activePanel?.id;
            return (
              <div className={`workspace-diff-tab right-chat-tab ${active ? "active" : ""}`} key={panel.id}>
                <button
                  type="button"
                  className="workspace-diff-tab-main"
                  role="tab"
                  id={`right-chat-tab-${panel.id}`}
                  aria-controls={`right-chat-panel-${panel.id}`}
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  title={panel.title}
                  ref={(element) => {
                    if (element) tabButtonRefs.current.set(panel.id, element);
                    else tabButtonRefs.current.delete(panel.id);
                  }}
                  onClick={() => selectPanel(panel.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, panel.id)}
                >
                  <span>{panel.title}</span>
                </button>
                <button
                  type="button"
                  className="workspace-diff-tab-close"
                  title={`Close ${panel.title}`}
                  aria-label={`Close ${panel.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClosePanel(panel.id);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <div className="workspace-diff-add-anchor" ref={addAnchorRef}>
            <button
              type="button"
              className={`workspace-diff-add-tab ${addMenuOpen ? "active" : ""}`}
              title="Add to right sidebar"
              aria-label="Add to right sidebar"
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((open) => !open)}
            >
              <Plus size={15} />
            </button>
            {addMenuOpen ? (
              <div className="workspace-diff-add-menu right-chat-add-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false);
                    onAddChat();
                  }}
                >
                  <MessageSquare size={13} />
                  <span>New task</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false);
                    onSelectFiles();
                  }}
                >
                  <FolderOpen size={13} />
                  <span>Files</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="right-chat-stack-body panes-1">
        {activePanel ? (
          <RightChatPane
            busy={busy}
            createImproveActions={createImproveActions}
            codexPermissionMode={codexPermissionMode}
            codexReasoningEffort={codexReasoningEffort}
            openPondCommandAccessMode={openPondCommandAccessMode}
            connection={connection}
            connectedAppMentions={connectedAppMentions}
            actionCatalog={activeActionCatalog}
            key={activePanel.id}
            mentionApps={mentionApps}
            codexPersonalSkills={codexPersonalSkills}
            profileSkills={activeProfileSkills}
            profileTarget={activePanel.provider === "codex" ? null : profileTarget}
            panel={activePanel}
            initialScrollState={{
              scrollTop: activePanel.scrollTop,
              stickyToBottom: activePanel.stickyToBottom,
            }}
            projectTarget={projectTarget}
            providerSettings={providerSettings}
            accountBaseUrl={accountBaseUrl}
            billingOrganizationSlug={billingOrganizationSlug}
            billingTeamId={billingTeamId}
            showToast={showToast}
            workspaceTarget={workspaceTarget}
            onCodexPermissionModeChange={onCodexPermissionModeChange}
            onCodexReasoningEffortChange={onCodexReasoningEffortChange}
            onOpenPondCommandAccessModeChange={(mode) => onOpenPondCommandAccessModeChange(mode, activePanel.session)}
            onModelChange={(model) => onModelChange(activePanel.id, model)}
            onOpenFileInSidebar={onOpenFileInSidebar}
            onOpenProfileSettings={onOpenProfileSettings}
            onOpenSession={onOpenSession}
            onProviderChange={(provider) => onProviderChange(activePanel.id, provider)}
            onProviderSetupOpen={onProviderSetupOpen}
            onPromptChange={(prompt) => onPromptChange(activePanel.id, prompt)}
            onProfileTargetChange={(value) => onProfileTargetChange(activePanel.sessionId, value)}
            onScrollStateChange={(state) => onScrollStateChange(activePanel.id, state)}
            onProjectTargetChange={onProjectTargetChange}
            onResolveApproval={onResolveApproval}
            onShowBrowserPanel={onShowBrowserPanel}
            onStop={() => onStop(activePanel.sessionId)}
            onSubmit={(attachments, action, command, options) => onSubmit(activePanel.id, attachments, action, command, options)}
            onWorkspaceTargetChange={onWorkspaceTargetChange}
          />
        ) : null}
      </div>
    </aside>
  );
}
