import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  Approval,
  BootstrapPayload,
  ChatAttachment,
  ChatProvider,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondApp,
  ResolveApprovalRequest,
  Session,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import type { RightChatPanel, ShowAppToast } from "../../app/app-state";
import type { ChatMessage } from "../../lib/app-models";
import type { ContextWindowStatus } from "../../lib/context-window";
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
import { AlignLeft, MessageSquare, Plus, SquareCode, X } from "../icons";

export type RightChatPanelView = RightChatPanel & {
  session: Session | null;
  title: string;
  messages: ChatMessage[];
  contextWindowStatus: ContextWindowStatus;
  goalRuntime: GoalRuntimeStatus | null;
  pendingApproval: Approval | null;
  running: boolean;
  workspaceRootPath: string | null;
  activeWorkspaceAppId: string | null;
};

export function RightChatPanelStack({
  panels,
  busy,
  codexPermissionMode,
  codexReasoningEffort,
  connection,
  mentionApps,
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
  onModelChange,
  onOpenFileInSidebar,
  onOpenProfileSettings,
  onProviderChange,
  onProviderSetupOpen,
  onPromptChange,
  onProjectTargetChange,
  onResolveApproval,
  onResizeStart,
  onSelectReview,
  onSelectSummary,
  onShowBrowserPanel,
  onStop,
  onSubmit,
  onWorkspaceTargetChange,
}: {
  panels: RightChatPanelView[];
  busy: boolean;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  connection: ClientConnection | null;
  mentionApps: OpenPondApp[];
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
  onModelChange: (panelId: string, model: string) => void;
  onOpenFileInSidebar: (path: string) => void;
  onOpenProfileSettings: () => void;
  onProviderChange: (panelId: string, provider: ChatProvider) => void;
  onProviderSetupOpen: () => void;
  onPromptChange: (panelId: string, prompt: string) => void;
  onProjectTargetChange: (value: string) => void;
  onResolveApproval: (
    approvalId: string,
    decision: ResolveApprovalRequest["decision"],
  ) => Promise<void>;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelectReview: () => void;
  onSelectSummary: () => void;
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
  const [splitPercent, setSplitPercent] = useState(50);
  const addAnchorRef = useRef<HTMLDivElement | null>(null);
  const stackBodyRef = useRef<HTMLDivElement | null>(null);
  const visiblePanels = panels.slice(0, 2);

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

  const startSplitResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (visiblePanels.length !== 2) return;
    event.preventDefault();
    const body = stackBodyRef.current;
    if (!body) return;
    const bounds = body.getBoundingClientRect();
    const update = (clientY: number) => {
      const next = ((clientY - bounds.top) / Math.max(bounds.height, 1)) * 100;
      setSplitPercent(Math.max(28, Math.min(72, next)));
    };
    update(event.clientY);
    const handlePointerMove = (moveEvent: PointerEvent) => update(moveEvent.clientY);
    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  }, [visiblePanels.length]);

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
            onClick={onSelectSummary}
          >
            <AlignLeft size={14} />
            <span>Summary</span>
          </button>
          <button
            type="button"
            className="workspace-diff-tab"
            role="tab"
            aria-selected={false}
            onClick={onSelectReview}
          >
            <SquareCode className="workspace-diff-tab-icon" size={14} />
            <span>Review</span>
          </button>
          {visiblePanels.map((panel) => (
            <div className="workspace-diff-tab right-chat-tab active" key={panel.id}>
              <button
                type="button"
                className="workspace-diff-tab-main"
                role="tab"
                aria-selected
                title={panel.title}
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
          ))}
          <div className="workspace-diff-add-anchor" ref={addAnchorRef}>
            <button
              type="button"
              className={`workspace-diff-add-tab ${addMenuOpen ? "active" : ""}`}
              title="Add side chat"
              aria-label="Add side chat"
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
                  <span>New chat</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div
        className={`right-chat-stack-body panes-${visiblePanels.length}`}
        ref={stackBodyRef}
        style={{ "--right-chat-split": `${splitPercent}%` } as CSSProperties}
      >
        {visiblePanels.map((panel, index) => (
          <RightChatPane
            busy={busy}
            codexPermissionMode={codexPermissionMode}
            codexReasoningEffort={codexReasoningEffort}
            connection={connection}
            key={panel.id}
            mentionApps={mentionApps}
            panel={panel}
            projectTarget={projectTarget}
            providerSettings={providerSettings}
            accountBaseUrl={accountBaseUrl}
            billingOrganizationSlug={billingOrganizationSlug}
            billingTeamId={billingTeamId}
            showToast={showToast}
            workspaceTarget={workspaceTarget}
            onCodexPermissionModeChange={onCodexPermissionModeChange}
            onCodexReasoningEffortChange={onCodexReasoningEffortChange}
            onModelChange={(model) => onModelChange(panel.id, model)}
            onOpenFileInSidebar={onOpenFileInSidebar}
            onOpenProfileSettings={onOpenProfileSettings}
            onProviderChange={(provider) => onProviderChange(panel.id, provider)}
            onProviderSetupOpen={onProviderSetupOpen}
            onPromptChange={(prompt) => onPromptChange(panel.id, prompt)}
            onProjectTargetChange={onProjectTargetChange}
            onResolveApproval={onResolveApproval}
            onShowBrowserPanel={onShowBrowserPanel}
            onStop={() => onStop(panel.sessionId)}
              onSubmit={(attachments, action, command, options) => onSubmit(panel.id, attachments, action, command, options)}
            onWorkspaceTargetChange={onWorkspaceTargetChange}
          />
        ))}
        {visiblePanels.length === 2 ? (
          <div
            className="right-chat-splitter"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize side chats"
            onPointerDown={startSplitResize}
          />
        ) : null}
      </div>
    </aside>
  );
}

function RightChatPane({
  panel,
  busy,
  codexPermissionMode,
  codexReasoningEffort,
  connection,
  mentionApps,
  projectTarget,
  providerSettings,
  accountBaseUrl,
  billingOrganizationSlug,
  billingTeamId,
  showToast,
  workspaceTarget,
  onCodexPermissionModeChange,
  onCodexReasoningEffortChange,
  onModelChange,
  onOpenFileInSidebar,
  onOpenProfileSettings,
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
  connection: ClientConnection | null;
  mentionApps: OpenPondApp[];
  projectTarget: ComposerProjectTargetState;
  providerSettings?: BootstrapPayload["providers"] | null;
  accountBaseUrl?: string | null;
  billingOrganizationSlug?: string | null;
  billingTeamId?: string | null;
  showToast: ShowAppToast;
  workspaceTarget: WorkspaceTargetState;
  onCodexPermissionModeChange: (mode: CodexPermissionMode) => void;
  onCodexReasoningEffortChange: (effort: CodexReasoningEffort) => void;
  onModelChange: (model: string) => void;
  onOpenFileInSidebar: (path: string) => void;
  onOpenProfileSettings: () => void;
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
    <section className={`right-chat-pane ${panel.pendingApproval ? "has-approval" : ""}`}>
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
          selectedMentionAppId={null}
          contextWindowStatus={panel.contextWindowStatus}
          goalRuntime={panel.goalRuntime}
          createPipelineRuntime={null}
          busy={panel.running}
          running={panel.running}
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
          onProviderChange={onProviderChange}
          onProviderSetupOpen={onProviderSetupOpen}
          onProjectTargetChange={onProjectTargetChange}
          onWorkspaceTargetChange={onWorkspaceTargetChange}
          onModelChange={onModelChange}
          onCodexPermissionModeChange={onCodexPermissionModeChange}
          onCodexReasoningEffortChange={onCodexReasoningEffortChange}
          onPromptChange={onPromptChange}
          onMentionAppSelect={undefined}
          onOpenGoalDetails={undefined}
          showToast={showToast}
          onSubmit={onSubmit}
          onStop={onStop}
        />
      </div>
    </section>
  );
}
