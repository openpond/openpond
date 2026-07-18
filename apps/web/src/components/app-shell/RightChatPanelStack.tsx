import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  Approval,
  BootstrapPayload,
  ChatAttachment,
  ChatProvider,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondCommandAccessMode,
  OpenPondApp,
  OpenPondProfileSkill,
  ResolveApprovalRequest,
  Session,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import type { RightChatPanel, ShowAppToast } from "../../app/app-state";
import type { ChatMessage } from "../../lib/app-models";
import type { ContextWindowStatus } from "../../lib/context-window";
import type { ConnectedAppMentionOption } from "../../lib/connected-app-mentions";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import type { WorkspaceTargetState, WorkspaceTargetValue } from "../../lib/workspace-location";
import { openBrowserLink } from "../../lib/browser-sidebar-links";
import {
  buildChatTimelineRows,
  shouldShowThinkingIndicator,
} from "../../lib/chat-timeline-rows";
import { ApprovalRequestCard } from "../chat/ApprovalRequestCard";
import { Composer, type ComposerProjectTargetState, type ComposerSubmitOptions } from "../chat/Composer";
import type { ComposerSlashCommand } from "../../lib/composer-slash-commands";
import { MessageRow, ThinkingIndicator } from "../chat/Messages";
import { FolderOpen, MessageSquare, Plus, X } from "../icons";

export type RightChatPanelView = RightChatPanel & {
  session: Session | null;
  title: string;
  messages: ChatMessage[];
  contextWindowStatus: ContextWindowStatus;
  goalRuntime: GoalRuntimeStatus | null;
  pendingApproval: Approval | null;
  running: boolean;
  steerAutoDispatchBlocked: boolean;
  steerAutoDispatchReady: boolean;
  workspaceRootPath: string | null;
  activeWorkspaceAppId: string | null;
};

export function RightChatPanelStack({
  panels,
  busy,
  codexPermissionMode,
  codexReasoningEffort,
  openPondCommandAccessMode,
  connection,
  connectedAppMentions,
  mentionApps,
  profileSkills,
  projectTarget,
  providerSettings,
  accountBaseUrl,
  billingOrganizationSlug,
  billingTeamId,
  showToast,
  workspaceTarget,
  onAddChat,
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
  busy: boolean;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  openPondCommandAccessMode: OpenPondCommandAccessMode;
  connection: ClientConnection | null;
  connectedAppMentions: ConnectedAppMentionOption[];
  mentionApps: OpenPondApp[];
  profileSkills: OpenPondProfileSkill[];
  projectTarget: ComposerProjectTargetState;
  providerSettings?: BootstrapPayload["providers"] | null;
  accountBaseUrl?: string | null;
  billingOrganizationSlug?: string | null;
  billingTeamId?: string | null;
  showToast: ShowAppToast;
  workspaceTarget: WorkspaceTargetState;
  onAddChat: () => void;
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
  const [activePanelId, setActivePanelId] = useState(() => panels.at(-1)?.id ?? null);
  const addAnchorRef = useRef<HTMLDivElement | null>(null);
  const tabButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const previousPanelIdsRef = useRef<Set<string>>(new Set(panels.map((panel) => panel.id)));
  const activePanel = panels.find((panel) => panel.id === activePanelId) ?? panels.at(-1) ?? null;

  useEffect(() => {
    const previousPanelIds = previousPanelIdsRef.current;
    let addedPanel: RightChatPanelView | null = null;
    for (const panel of panels) {
      if (!previousPanelIds.has(panel.id)) addedPanel = panel;
    }
    previousPanelIdsRef.current = new Set(panels.map((panel) => panel.id));
    setActivePanelId((current) => {
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
    if (focus) window.requestAnimationFrame(() => tabButtonRefs.current.get(panelId)?.focus());
  }, []);

  const handleTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, panelId: string) => {
    const currentIndex = panels.findIndex((panel) => panel.id === panelId);
    if (currentIndex < 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % panels.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + panels.length) % panels.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = panels.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextPanel = panels[nextIndex];
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
            aria-selected={false}
            onClick={onSelectFiles}
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
            codexPermissionMode={codexPermissionMode}
            codexReasoningEffort={codexReasoningEffort}
            openPondCommandAccessMode={openPondCommandAccessMode}
            connection={connection}
            connectedAppMentions={connectedAppMentions}
            key={activePanel.id}
            mentionApps={mentionApps}
            profileSkills={profileSkills}
            panel={activePanel}
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

function RightChatPane({
  panel,
  codexPermissionMode,
  codexReasoningEffort,
  openPondCommandAccessMode,
  connection,
  connectedAppMentions,
  mentionApps,
  profileSkills,
  projectTarget,
  providerSettings,
  accountBaseUrl,
  billingOrganizationSlug,
  billingTeamId,
  showToast,
  workspaceTarget,
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
  onProjectTargetChange,
  onResolveApproval,
  onShowBrowserPanel,
  onStop,
  onSubmit,
  onWorkspaceTargetChange,
}: {
  panel: RightChatPanelView;
  busy: boolean;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  openPondCommandAccessMode: OpenPondCommandAccessMode;
  connection: ClientConnection | null;
  connectedAppMentions: ConnectedAppMentionOption[];
  mentionApps: OpenPondApp[];
  profileSkills: OpenPondProfileSkill[];
  projectTarget: ComposerProjectTargetState;
  providerSettings?: BootstrapPayload["providers"] | null;
  accountBaseUrl?: string | null;
  billingOrganizationSlug?: string | null;
  billingTeamId?: string | null;
  showToast: ShowAppToast;
  workspaceTarget: WorkspaceTargetState;
  onCodexPermissionModeChange: (mode: CodexPermissionMode) => void;
  onCodexReasoningEffortChange: (effort: CodexReasoningEffort) => void;
  onOpenPondCommandAccessModeChange: (mode: OpenPondCommandAccessMode) => void;
  onModelChange: (model: string) => void;
  onOpenFileInSidebar: (path: string) => void;
  onOpenProfileSettings: () => void;
  onOpenSession?: (sessionId: string) => void;
  onProviderChange: (provider: ChatProvider) => void;
  onProviderSetupOpen: () => void;
  onPromptChange: (prompt: string) => void;
  onProjectTargetChange: (value: string) => void;
  onResolveApproval: (
    approvalId: string,
    decision: ResolveApprovalRequest["decision"],
  ) => Promise<void>;
  onShowBrowserPanel: () => void;
  onStop: () => Promise<boolean>;
  onSubmit: (
    attachments?: ChatAttachment[],
    action?: SandboxActionCatalogEntry | null,
    command?: ComposerSlashCommand | null,
    options?: ComposerSubmitOptions,
  ) => Promise<boolean>;
  onWorkspaceTargetChange: (target: WorkspaceTargetValue) => void;
}) {
  const threadRef = useRef<HTMLDivElement | null>(null);
  const stickyToBottomRef = useRef(true);
  const showThinking = panel.running && !panel.pendingApproval && shouldShowThinkingIndicator(panel.messages);
  const timelineRows = useMemo(
    () => buildChatTimelineRows(panel.messages, { showThinkingIndicator: showThinking }),
    [panel.messages, showThinking],
  );
  const latestMessage = panel.messages.at(-1);
  const contentKey = [
    panel.id,
    panel.sessionId ?? "draft",
    timelineRows.length,
    latestMessage?.id ?? "",
    latestMessage?.content?.length ?? 0,
    latestMessage?.timestamp ?? "",
    showThinking ? "thinking" : "",
  ].join(":");

  useLayoutEffect(() => {
    const element = threadRef.current;
    if (!element || !stickyToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [contentKey]);

  const handleOpenBrowserLink = useCallback(
    (href: string, options?: { explicitFile?: boolean; newTab?: boolean }) => {
      const conversationId = panel.sessionId ?? `side-chat:${panel.id}`;
      void openBrowserLink({
        conversationId,
        href,
        explicitFile: options?.explicitFile,
        newTab: options?.newTab,
      }).then((opened) => {
        if (opened) onShowBrowserPanel();
      });
    },
    [onShowBrowserPanel, panel.id, panel.sessionId],
  );

  return (
    <section
      className={`right-chat-pane ${panel.pendingApproval ? "has-approval" : ""}`}
      id={`right-chat-panel-${panel.id}`}
      role="tabpanel"
      aria-labelledby={`right-chat-tab-${panel.id}`}
    >
      <div
        className="chat-thread right-chat-thread"
        ref={threadRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickyToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 72;
        }}
      >
        {timelineRows.length > 0
          ? timelineRows.map((row) =>
            row.type === "thinking" ? (
              <ThinkingIndicator key={row.id} />
            ) : (
              <MessageRow
                activeWorkspaceAppId={panel.activeWorkspaceAppId}
                accountBaseUrl={accountBaseUrl}
                billingOrganizationSlug={billingOrganizationSlug}
                billingTeamId={billingTeamId}
                connection={connection}
                key={row.id}
                message={row.message}
                onOpenBrowserLink={handleOpenBrowserLink}
                onOpenFileInSidebar={onOpenFileInSidebar}
                onOpenProfileSettings={onOpenProfileSettings}
                onOpenSession={onOpenSession}
                workspaceRootPath={panel.workspaceRootPath}
                showFooter={row.showFooter}
              />
            ),
          )
          : null}
      </div>
      <div className={`composer-stack dock right-chat-composer ${panel.pendingApproval ? "has-approval" : ""}`}>
        <ApprovalRequestCard approval={panel.pendingApproval} onResolve={onResolveApproval} />
        <Composer
          mode="dock"
          prompt={panel.prompt}
          mentionApps={mentionApps}
          connectedAppMentions={connectedAppMentions}
          profileSkills={profileSkills}
          selectedMentionAppId={null}
          contextWindowStatus={panel.contextWindowStatus}
          goalRuntime={panel.goalRuntime}
          createImproveRuntime={null}
          busy={panel.running}
          running={panel.running}
          submissionScopeKey={panel.sessionId ?? panel.id}
          steerAutoDispatchBlocked={panel.steerAutoDispatchBlocked}
          steerAutoDispatchReady={panel.steerAutoDispatchReady}
          showProjectFooter={false}
          connection={connection}
          providerSettings={providerSettings}
          provider={panel.session?.provider ?? panel.provider}
          model={panel.session?.modelRef?.modelId ?? panel.model}
          projectTarget={projectTarget}
          actionCatalog={[]}
          workspaceTarget={workspaceTarget}
          codexPermissionMode={codexPermissionMode}
          codexReasoningEffort={codexReasoningEffort}
          openPondCommandAccessMode={
            panel.session?.provider === "codex"
              ? openPondCommandAccessMode
              : panel.session?.openPondCommandAccessMode ?? openPondCommandAccessMode
          }
          onProviderChange={onProviderChange}
          onProviderSetupOpen={onProviderSetupOpen}
          onProjectTargetChange={onProjectTargetChange}
          onWorkspaceTargetChange={onWorkspaceTargetChange}
          onModelChange={onModelChange}
          onCodexPermissionModeChange={onCodexPermissionModeChange}
          onCodexReasoningEffortChange={onCodexReasoningEffortChange}
          onOpenPondCommandAccessModeChange={onOpenPondCommandAccessModeChange}
          onPromptChange={onPromptChange}
          onMentionAppSelect={undefined}
          showToast={showToast}
          onSubmit={onSubmit}
          onStop={onStop}
        />
      </div>
    </section>
  );
}
