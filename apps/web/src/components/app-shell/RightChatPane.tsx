import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  BootstrapPayload,
  AppPreferences,
  ChatAttachment,
  ChatAttachmentSummary,
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
import { useNewMessageIds } from "../../hooks/useNewMessageIds";
import { openBrowserLink } from "../../lib/browser-sidebar-links";
import { IncrementalChatProjector } from "../../lib/incremental-chat-projector";
import {
  buildChatTimelineRows,
  isLatestAssistantMessageForTurn,
  latestAssistantMessageIdsByTurn,
  shouldShowThinkingIndicator,
} from "../../lib/chat-timeline-rows";
import type { ConnectedAppMentionOption } from "../../lib/connected-app-mentions";
import type { ComposerSlashCommand } from "../../lib/composer-slash-commands";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import {
  latestGoalRuntimeForSession,
  latestContextUsageForSession,
  buildRuntimeIndexes,
} from "../../lib/runtime-indexes";
import { contextWindowStatusFromUsage } from "../../lib/context-window";
import { latestCreateImproveRunProjection } from "../../lib/create-pipeline-runtime";
import { appendPendingUserChatMessage } from "../../lib/pending-chat-messages";
import type { RuntimeEventStore } from "../../lib/runtime-event-store";
import { useRuntimeEventSession } from "../../hooks/useRuntimeEventSession";
import { useSessionTurnCache } from "../../hooks/useSessionTurnCache";
import { useChatContentScrollScheduler } from "../../hooks/useChatContentScrollScheduler";
import type { WorkspaceTargetState, WorkspaceTargetValue } from "../../lib/workspace-location";
import { ApprovalRequestCard } from "../chat/ApprovalRequestCard";
import {
  Composer,
  type ComposerProjectTargetState,
  type ComposerSubmitOptions,
} from "../chat/Composer";
import type { ComposerProfileTargetState } from "../chat/ComposerControls";
import type { ComposerCreateImproveActions } from "../chat/ComposerCreateImproveStrip";
import { MessageRow, ThinkingIndicator } from "../chat/Messages";
import type { RightChatPanelView, RightChatScrollState } from "./right-chat-panel-types";

export function RightChatPane({
  panel,
  runtimeEventStore,
  actionCatalog,
  createImproveActions,
  contextCompaction,
  initialScrollState,
  codexPermissionMode,
  codexReasoningEffort,
  openPondCommandAccessMode,
  connection,
  connectedAppMentions,
  mentionApps,
  codexPersonalSkills,
  profileSkills,
  profileTarget,
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
  onOpenAttachmentInSidebar,
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
  onShowBrowserPanel,
  onStop,
  onSubmit,
  onWorkspaceTargetChange,
}: {
  panel: RightChatPanelView;
  runtimeEventStore: RuntimeEventStore;
  actionCatalog: SandboxActionCatalogEntry[];
  createImproveActions: ComposerCreateImproveActions;
  contextCompaction: AppPreferences["contextCompaction"];
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
  profileTarget: ComposerProfileTargetState | null;
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
  onOpenAttachmentInSidebar: (attachment: ChatAttachmentSummary) => Promise<void>;
  onOpenFileInSidebar: (path: string) => void;
  onOpenProfileSettings: () => void;
  onOpenSession?: (sessionId: string) => void;
  onProviderChange: (provider: ChatProvider) => void;
  onProviderSetupOpen: () => void;
  onPromptChange: (prompt: string) => void;
  onProfileTargetChange: (value: string) => void;
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
  const [chatProjector] = useState(() => new IncrementalChatProjector());
  const stickyToBottomRef = useRef(initialScrollState?.stickyToBottom ?? true);
  const initialScrollRestoredRef = useRef(false);
  const liveSessionSnapshot = useRuntimeEventSession(
    runtimeEventStore,
    panel.runtimeSource === "live" ? panel.sessionId : null,
  );
  const activePanelView = useMemo<RightChatPanelView>(() => {
    if (panel.runtimeSource === "history" || !panel.sessionId) return panel;
    const events = liveSessionSnapshot.events;
    const indexes = buildRuntimeIndexes(events, []);
    return {
      ...panel,
      messages: appendPendingUserChatMessage(
        chatProjector.project(events),
        panel.pendingUserMessage,
      ),
      createImproveRun: latestCreateImproveRunProjection({ events }),
      contextWindowStatus: contextWindowStatusFromUsage({
        provider: panel.provider,
        snapshot: latestContextUsageForSession(indexes, panel.sessionId),
        preferences: contextCompaction,
      }),
      goalRuntime: latestGoalRuntimeForSession(indexes, panel.sessionId),
    };
  }, [chatProjector, contextCompaction, liveSessionSnapshot, panel]);
  const showThinking = activePanelView.running
    && !activePanelView.pendingApproval
    && shouldShowThinkingIndicator(activePanelView.messages);
  const createImproveRuntime = useMemo(
    () => activePanelView.createImproveRun
      ? { ...createImproveActions, run: activePanelView.createImproveRun }
      : null,
    [activePanelView.createImproveRun, createImproveActions],
  );
  const timelineRows = useMemo(
    () => buildChatTimelineRows(activePanelView.messages, { showThinkingIndicator: showThinking }),
    [activePanelView.messages, showThinking],
  );
  const newMessageIds = useNewMessageIds(
    activePanelView.messages,
    activePanelView.sessionId ?? `draft:${activePanelView.id}`
  );
  const latestMessage = activePanelView.messages.at(-1);
  const latestAssistantByTurn = useMemo(
    () => latestAssistantMessageIdsByTurn(activePanelView.messages),
    [activePanelView.messages],
  );
  const turnCache = useSessionTurnCache({
    connection,
    latestTurnId: latestMessage?.turnId ?? null,
    sessionId: activePanelView.sessionId,
    turnRunning: activePanelView.running,
  });
  const contentKey = [
    activePanelView.id,
    activePanelView.sessionId ?? "draft",
    timelineRows.length,
    latestMessage?.id ?? "",
    latestMessage?.content?.length ?? 0,
    latestMessage?.timestamp ?? "",
    showThinking ? "thinking" : "",
  ].join(":");

  useLayoutEffect(() => {
    const element = threadRef.current;
    if (!element || initialScrollRestoredRef.current) return;
    initialScrollRestoredRef.current = true;
    element.scrollTop = initialScrollState?.stickyToBottom
      ? element.scrollHeight
      : initialScrollState?.scrollTop ?? 0;
  }, [initialScrollState]);
  useChatContentScrollScheduler({
    contentKey,
    onContentChange: (element) => {
      if (stickyToBottomRef.current) element.scrollTop = element.scrollHeight;
    },
    threadRef,
  });

  const handleOpenBrowserLink = useCallback(
    (href: string, options?: { explicitFile?: boolean; newTab?: boolean }) => {
      const conversationId = activePanelView.sessionId ?? `side-chat:${activePanelView.id}`;
      void openBrowserLink({
        conversationId,
        href,
        explicitFile: options?.explicitFile,
        newTab: options?.newTab,
      }).then((opened) => {
        if (opened) onShowBrowserPanel();
      });
    },
    [activePanelView.id, activePanelView.sessionId, onShowBrowserPanel],
  );
  const handleResolveUserQuestion = useCallback<NonNullable<
    import("react").ComponentProps<typeof MessageRow>["onResolveUserQuestion"]
  >>(async (_question, resolution) => {
    const displayPrompt = resolution.action === "answer"
      ? resolution.text
      : "Dismiss this question";
    const sent = await onSubmit([], null, null, {
      displayPrompt,
      promptOverride: displayPrompt,
      turnMetadata: { userQuestionResolution: resolution },
    });
    if (!sent) throw new Error("The question response could not be sent.");
  }, [onSubmit]);

  return (
    <section
      className={`right-chat-pane ${activePanelView.pendingApproval ? "has-approval" : ""}`}
      id={`right-chat-panel-${activePanelView.id}`}
      role="tabpanel"
      aria-labelledby={`right-chat-tab-${activePanelView.id}`}
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
            activeWorkspaceAppId={activePanelView.activeWorkspaceAppId}
            accountBaseUrl={accountBaseUrl}
            billingOrganizationSlug={billingOrganizationSlug}
            billingTeamId={billingTeamId}
            connection={connection}
            animateInitialContent={
              row.message.role === "assistant" &&
              newMessageIds.has(row.message.id)
            }
            key={row.id}
            kvCacheSummary={
              isLatestAssistantMessageForTurn(row.message, latestAssistantByTurn) && row.message.turnId
                ? turnCache.get(row.message.turnId) ?? null
                : null
            }
            message={row.message}
            onOpenBrowserLink={handleOpenBrowserLink}
            onOpenAttachmentInSidebar={onOpenAttachmentInSidebar}
            onOpenFileInSidebar={onOpenFileInSidebar}
            onOpenProfileSettings={onOpenProfileSettings}
            onResolveUserQuestion={handleResolveUserQuestion}
            onOpenSession={onOpenSession}
            userAttachmentDisplay={
              panel.provider === "codex" ? "compact" : "full"
            }
            workspaceRootPath={activePanelView.workspaceRootPath}
            showFooter={row.showFooter}
          />
        ))}
      </div>
      <div className={`composer-stack dock right-chat-composer ${activePanelView.pendingApproval ? "has-approval" : ""}`}>
        <ApprovalRequestCard approval={activePanelView.pendingApproval} onResolve={onResolveApproval} />
        <Composer
          mode="dock"
          prompt={panel.prompt}
          mentionApps={mentionApps}
          connectedAppMentions={connectedAppMentions}
          profileSkills={panel.provider === "codex" ? codexPersonalSkills : profileSkills}
          profileTarget={panel.provider === "codex" ? null : profileTarget}
          selectedMentionAppId={null}
          contextWindowStatus={activePanelView.contextWindowStatus}
          goalRuntime={activePanelView.goalRuntime}
          createImproveRuntime={createImproveRuntime}
          busy={activePanelView.running}
          running={activePanelView.running}
          submissionScopeKey={activePanelView.sessionId ?? activePanelView.id}
          showProjectFooter={false}
          connection={connection}
          providerSettings={providerSettings}
          provider={panel.provider}
          model={panel.model}
          projectTarget={projectTarget}
          actionCatalog={actionCatalog}
          workspaceTarget={workspaceTarget}
          codexPermissionMode={codexPermissionMode}
          codexReasoningEffort={codexReasoningEffort}
          openPondCommandAccessMode={
            panel.provider === "codex"
              ? openPondCommandAccessMode
              : activePanelView.session?.openPondCommandAccessMode ?? openPondCommandAccessMode
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
          onProfileTargetChange={onProfileTargetChange}
          onMentionAppSelect={undefined}
          showToast={showToast}
          onSubmit={onSubmit}
          onStop={onStop}
        />
      </div>
    </section>
  );
}
