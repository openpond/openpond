import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type {
  BootstrapPayload,
  ChatAttachment,
  ChatProvider,
  CodexPersonalSkill,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondCommandAccessMode,
  OpenPondApp,
  OpenPondProfileSkill,
  ResolveApprovalRequest,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import { openBrowserLink } from "../../lib/browser-sidebar-links";
import {
  buildChatTimelineRows,
  shouldShowThinkingIndicator,
} from "../../lib/chat-timeline-rows";
import type { ConnectedAppMentionOption } from "../../lib/connected-app-mentions";
import type { ComposerSlashCommand } from "../../lib/composer-slash-commands";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import type { WorkspaceTargetState, WorkspaceTargetValue } from "../../lib/workspace-location";
import { ApprovalRequestCard } from "../chat/ApprovalRequestCard";
import {
  Composer,
  type ComposerProjectTargetState,
  type ComposerSubmitOptions,
} from "../chat/Composer";
import type { ComposerCreateImproveActions } from "../chat/ComposerCreateImproveStrip";
import { MessageRow, ThinkingIndicator } from "../chat/Messages";
import type { RightChatPanelView, RightChatScrollState } from "./right-chat-panel-types";

export function RightChatPane({
  panel,
  createImproveActions,
  initialScrollState,
  codexPermissionMode,
  codexReasoningEffort,
  openPondCommandAccessMode,
  connection,
  connectedAppMentions,
  mentionApps,
  codexPersonalSkills,
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
  onScrollStateChange,
  onProjectTargetChange,
  onResolveApproval,
  onShowBrowserPanel,
  onStop,
  onSubmit,
  onWorkspaceTargetChange,
}: {
  panel: RightChatPanelView;
  createImproveActions: ComposerCreateImproveActions;
  initialScrollState: RightChatScrollState | null;
  busy: boolean;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  openPondCommandAccessMode: OpenPondCommandAccessMode;
  connection: ClientConnection | null;
  connectedAppMentions: ConnectedAppMentionOption[];
  mentionApps: OpenPondApp[];
  codexPersonalSkills: CodexPersonalSkill[];
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
  onScrollStateChange: (state: RightChatScrollState) => void;
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
  const stickyToBottomRef = useRef(initialScrollState?.stickyToBottom ?? true);
  const initialScrollRestoredRef = useRef(false);
  const showThinking = panel.running
    && !panel.pendingApproval
    && shouldShowThinkingIndicator(panel.messages);
  const createImproveRuntime = useMemo(
    () => panel.createImproveRun
      ? { ...createImproveActions, run: panel.createImproveRun }
      : null,
    [createImproveActions, panel.createImproveRun],
  );
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
    if (!element) return;
    if (!initialScrollRestoredRef.current) {
      initialScrollRestoredRef.current = true;
      element.scrollTop = initialScrollState?.stickyToBottom
        ? element.scrollHeight
        : initialScrollState?.scrollTop ?? 0;
      return;
    }
    if (stickyToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [contentKey, initialScrollState]);

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
          stickyToBottomRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <= 72;
          onScrollStateChange({
            scrollTop: element.scrollTop,
            stickyToBottom: stickyToBottomRef.current,
          });
        }}
      >
        {timelineRows.map((row) => row.type === "thinking" ? (
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
        ))}
      </div>
      <div className={`composer-stack dock right-chat-composer ${panel.pendingApproval ? "has-approval" : ""}`}>
        <ApprovalRequestCard approval={panel.pendingApproval} onResolve={onResolveApproval} />
        <Composer
          mode="dock"
          prompt={panel.prompt}
          mentionApps={mentionApps}
          connectedAppMentions={connectedAppMentions}
          profileSkills={panel.provider === "codex" ? codexPersonalSkills : profileSkills}
          selectedMentionAppId={null}
          contextWindowStatus={panel.contextWindowStatus}
          goalRuntime={panel.goalRuntime}
          createImproveRuntime={createImproveRuntime}
          busy={panel.running}
          running={panel.running}
          submissionScopeKey={panel.sessionId ?? panel.id}
          steerAutoDispatchBlocked={panel.steerAutoDispatchBlocked}
          steerAutoDispatchReady={panel.steerAutoDispatchReady}
          showProjectFooter={false}
          connection={connection}
          providerSettings={providerSettings}
          provider={panel.provider}
          model={panel.model}
          projectTarget={projectTarget}
          actionCatalog={[]}
          workspaceTarget={workspaceTarget}
          codexPermissionMode={codexPermissionMode}
          codexReasoningEffort={codexReasoningEffort}
          openPondCommandAccessMode={
            panel.provider === "codex"
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
