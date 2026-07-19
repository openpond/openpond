import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "../../styles/team-chat/team-chat.css";
import "../../styles/workspace/git-dialogs.css";
import type {
  ChatAttachment,
  ChatProvider,
  BootstrapPayload,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondCommandAccessMode,
  ProviderSettings,
  TeamChatHostedAiThread,
  TeamChatAgentConversation,
  TeamChatMember,
  TeamChatMessage,
  TeamChatThreadDetail,
} from "@openpond/contracts";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import type { ContextWindowStatus } from "../../lib/context-window";
import type { WorkspaceTargetState } from "../../lib/workspace-location";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import {
  isLocalTeamProfileAgentAction,
  localTeamProfileAgentId,
  teamChatActionCatalogWithProfileAgents,
} from "../../lib/team-chat-profile-agents";
import { mentionedTeamMemberIds } from "../../lib/team-chat-mentions";
import {
  teamChatReplyAuthorLabel,
  teamChatReplyTargetFromMessage,
} from "../../lib/team-chat-reply";
import { teamChatThreadTitle } from "../../lib/team-chat-thread";
import { Composer } from "../chat/Composer";
import type { ComposerProjectTargetState } from "../chat/ComposerControls";
import { MarkdownText } from "../chat/MarkdownText";
import { ConfirmDialog, useConfirmDialog } from "../common/ConfirmDialog";
import { Bot, MessageSquare, RefreshCw, X } from "../icons";
import { TeamChatMessageRow } from "./TeamChatMessageRow";
import {
  TeamChatComposerReply,
  TeamChatReplyContextMenu,
  teamChatMessageDomId,
  teamChatReplyMenuPosition,
  type TeamChatReplyMenuState,
} from "./TeamChatReply";

const NO_PROJECT_TARGET: ComposerProjectTargetState = {
  value: "none",
  label: "No project",
  detail: "Team conversation",
  options: [],
  busy: false,
};

const NO_WORKSPACE_TARGET: WorkspaceTargetState = {
  value: "local",
  label: "Local",
  detail: "Local execution",
  options: [],
  action: {
    value: "local",
    label: "Local",
    detail: "Local execution",
    disabled: false,
  },
  busy: false,
};

const TEAM_CHAT_PROVIDER_IDS = new Set<ChatProvider>([
  "codex",
  "openai",
  "xai",
  "openrouter",
  "deepseek",
  "zai",
  "moonshot",
  "together",
  "groq",
  "fireworks",
  "custom-openai-compatible",
]);

export function restoreFailedTeamChatPrompt(
  currentPrompt: string,
  submittedPrompt: string,
): string {
  if (!submittedPrompt || currentPrompt === submittedPrompt) return currentPrompt;
  if (!currentPrompt) return submittedPrompt;
  return `${submittedPrompt}\n\n${currentPrompt}`;
}

export type TeamChatViewProps = {
  currentUserId: string | null;
  members: TeamChatMember[];
  agents: SandboxActionCatalogEntry[];
  profile: BootstrapPayload["profile"] | null;
  teamId: string | null;
  teamName: string | null;
  detail: TeamChatThreadDetail | null;
  aiThread: TeamChatHostedAiThread | null;
  agentConversation: TeamChatAgentConversation | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  connection: ClientConnection | null;
  providerSettings: ProviderSettings | null;
  provider: ChatProvider;
  model: string;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  openPondCommandAccessMode: OpenPondCommandAccessMode;
  contextWindowStatus: ContextWindowStatus;
  showToast: ShowAppToast;
  onProviderChange: (provider: ChatProvider) => void;
  onModelChange: (model: string) => void;
  onCodexPermissionModeChange: (mode: CodexPermissionMode) => void;
  onCodexReasoningEffortChange: (effort: CodexReasoningEffort) => void;
  onOpenPondCommandAccessModeChange: (mode: OpenPondCommandAccessMode) => void;
  onOpenProviderSettings: () => void;
  onSendMessage: (input: {
    body: string;
    useModel: boolean;
    providerId: string;
    modelId: string;
    mentionUserIds?: string[];
    attachments?: ChatAttachment[];
    replyToMessage?: TeamChatMessage | null;
    selectedActionKey?: string | null;
    approvalId?: string | null;
  }) => Promise<boolean>;
  onPublishProfileAgent: (
    agentId: string,
  ) => Promise<SandboxActionCatalogEntry>;
  onOpenAiThread: (conversationId: string) => Promise<void>;
  onOpenAgentConversation: (agentRunId: string) => Promise<void>;
  onCloseAiThread: () => void;
  onCloseAgentConversation: () => void;
  onSendAgentTurn: (input: {
    body: string;
    clientRequestId: string;
  }) => Promise<boolean>;
  onSendAiTurn: (input: { body: string; providerId: string; modelId: string }) => Promise<boolean>;
  onStopAiTurn: () => Promise<boolean>;
  onEditMessage: (message: TeamChatMessage, body: string) => Promise<boolean>;
  onDeleteMessage: (message: TeamChatMessage) => Promise<boolean>;
  onRetryMessage: (message: TeamChatMessage) => Promise<boolean>;
  onDismissFailedMessage: (message: TeamChatMessage) => void;
  onLoadMoreMessages: () => Promise<boolean>;
  onRetryLoad: () => Promise<void>;
};

export function TeamChatView(props: TeamChatViewProps) {
  const [prompt, setPrompt] = useState("");
  const [useModel, setUseModel] = useState(false);
  const [replySelection, setReplySelection] = useState<{
    threadId: string;
    message: TeamChatMessage;
  } | null>(null);
  const [replyMenu, setReplyMenu] = useState<TeamChatReplyMenuState | null>(null);
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const stickToLatestRef = useRef(true);
  const activeThreadIdRef = useRef(props.detail?.thread.id ?? null);
  activeThreadIdRef.current = props.detail?.thread.id ?? null;
  const { confirmAction, confirmDialog, resolveConfirmDialog } = useConfirmDialog();
  const membersById = useMemo(
    () => new Map(props.members.map((member) => [member.userId, member])),
    [props.members],
  );
  const messagesById = useMemo(
    () => new Map((props.detail?.messages ?? []).map((message) => [message.id, message])),
    [props.detail?.messages],
  );
  const currentThreadId = props.detail?.thread.id ?? null;
  const selectedReplyMessage =
    replySelection?.threadId === currentThreadId
      ? (messagesById.get(replySelection.message.id) ?? replySelection.message)
      : null;
  const replyMessage = selectedReplyMessage?.deletedAt ? null : selectedReplyMessage;
  const replyTarget = replyMessage ? teamChatReplyTargetFromMessage(replyMessage) : null;
  const replyAuthorLabel = replyTarget
    ? teamChatReplyAuthorLabel(replyTarget, membersById)
    : null;
  const title = props.detail
    ? teamChatThreadTitle(props.detail.thread, props.currentUserId)
    : "Team";
  const teamProvider = TEAM_CHAT_PROVIDER_IDS.has(props.provider) ? props.provider : "codex";
  const teamModel = teamProvider === props.provider ? props.model : "gpt-5.6-sol";
  const teamActionCatalog = useMemo(
    () =>
      teamChatActionCatalogWithProfileAgents({
        hostedActions: props.agents,
        profile: props.profile,
        teamId: props.teamId,
      }),
    [props.agents, props.profile, props.teamId],
  );
  const lastMessageSequence = props.detail?.messages.at(-1)?.sequence ?? 0;
  useEffect(() => {
    if (!stickToLatestRef.current) return;
    const element = messagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lastMessageSequence, props.detail?.thread.id]);

  const beginReply = useCallback((message: TeamChatMessage) => {
    if (
      message.deletedAt ||
      message.id.startsWith("pending:") ||
      typeof message.metadata.deliveryStatus === "string"
    ) {
      return;
    }
    setReplySelection({ threadId: message.threadId, message });
    setUseModel(false);
    setReplyMenu(null);
    setComposerFocusRequestId((current) => current + 1);
  }, []);

  const closeReplyMenu = useCallback(() => setReplyMenu(null), []);

  const openReplyMenu = useCallback(
    (
      message: TeamChatMessage,
      input: {
        clientX: number;
        clientY: number;
        fallbackX: number;
        fallbackY: number;
      },
    ) => {
      const position = teamChatReplyMenuPosition({
        ...input,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
      setReplyMenu({ message, ...position });
    },
    [],
  );

  const jumpToMessage = useCallback((messageId: string) => {
    const element = document.getElementById(teamChatMessageDomId(messageId));
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.focus({ preventScroll: true });
  }, []);

  async function submitTeamMessage(
    attachments: ChatAttachment[] = [],
    action: SandboxActionCatalogEntry | null = null,
  ): Promise<boolean> {
    if (
      attachments.some(
        (attachment) =>
          attachment.kind !== "image" ||
          !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mediaType),
      )
    ) {
      props.showToast("Team chat supports PNG, JPEG, WebP, and GIF images.", "error");
      return false;
    }
    let resolvedAction = action;
    if (replyMessage && resolvedAction) {
      props.showToast("Remove the agent action before replying to a message.", "error");
      return false;
    }
    if (isLocalTeamProfileAgentAction(resolvedAction)) {
      const profileAgentId = localTeamProfileAgentId(resolvedAction);
      if (!profileAgentId) {
        throw new Error("The selected profile agent is missing its profile id.");
      }
      const approved = await confirmAction({
        title: `Publish ${resolvedAction.label ?? resolvedAction.name ?? "agent"} to Team?`,
        body: `This will upload the committed agent source to ${
          props.teamName ?? "this Team"
        }, create its hosted runtime, and then send your message.`,
        confirmLabel: "Publish and send",
        tone: "default",
      });
      if (!approved) return false;
      resolvedAction = await props.onPublishProfileAgent(profileAgentId);
    }
    const approvalRisk = resolvedAction?.approvalPolicy?.risk;
    let approvalId: string | null = null;
    if (
      resolvedAction?.approvalPolicy?.required &&
      approvalRisk &&
      approvalRisk !== "read"
    ) {
      const destructive = approvalRisk === "destructive";
      const approved = await confirmAction({
        title: destructive ? "Approve destructive action?" : "Approve external write?",
        body: `${resolvedAction.label ?? resolvedAction.name ?? "This agent action"} will use the workspace connection to ${
          destructive ? "perform a destructive operation" : "write external data"
        }. Approve this run only?`,
        confirmLabel: destructive ? "Approve destructive action" : "Approve write",
        tone: destructive ? "danger" : "default",
      });
      if (!approved) return false;
      approvalId = crypto.randomUUID();
    }
    const submittedPrompt = prompt;
    const submittedThreadId = props.detail?.thread.id ?? null;
    const submittedReply = replyMessage;
    const restorePrompt = () => {
      if (activeThreadIdRef.current !== submittedThreadId) return;
      setPrompt((current) => restoreFailedTeamChatPrompt(current, submittedPrompt));
      if (submittedReply) {
        setReplySelection((current) =>
          current ?? {
            threadId: submittedReply.threadId,
            message: submittedReply,
          },
        );
      }
    };
    setPrompt("");
    if (submittedReply) setReplySelection(null);
    try {
      const sent = await props.onSendMessage({
        body: submittedPrompt,
        useModel,
        providerId: teamProvider,
        modelId: teamModel,
        mentionUserIds: mentionedTeamMemberIds(submittedPrompt, props.members),
        attachments,
        replyToMessage: submittedReply,
        selectedActionKey: resolvedAction?.id ?? null,
        approvalId,
      });
      if (!sent) {
        restorePrompt();
      } else if (useModel) {
        setUseModel(false);
      }
      return sent;
    } catch (error) {
      restorePrompt();
      throw error;
    }
  }

  return (
    <section className="team-chat-view">
      <div className="team-chat-main conversation-surface-main">
        {props.error ? (
          <div className="team-chat-error" role="alert">
            <span>{props.error}</span>
            <button type="button" onClick={() => void props.onRetryLoad()}>
              <RefreshCw size={14} />
              Retry
            </button>
          </div>
        ) : null}
        <div
          className="team-chat-messages conversation-message-scroll"
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-busy={props.loading}
          aria-label={title}
          tabIndex={0}
          ref={messagesRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            stickToLatestRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 72;
          }}
        >
          {props.detail?.hasMoreBefore ? (
            <button
              type="button"
              className="team-chat-load-older"
              disabled={props.loading}
              onClick={() => void props.onLoadMoreMessages()}
            >
              {props.loading ? "Loading..." : "Load older messages"}
            </button>
          ) : null}
          {props.loading && !props.detail ? (
            <div className="team-chat-empty">Loading messages...</div>
          ) : props.detail?.messages.length ? (
            props.detail.messages.map((message) => (
              <TeamChatMessageRow
                key={message.id}
                message={message}
                author={
                  message.authorUserId ? (membersById.get(message.authorUserId) ?? null) : null
                }
                own={message.authorUserId === props.currentUserId}
                onOpenAiThread={props.onOpenAiThread}
                onOpenAgentConversation={props.onOpenAgentConversation}
                onEdit={props.onEditMessage}
                onDelete={props.onDeleteMessage}
                onRetry={props.onRetryMessage}
                onDismissFailed={props.onDismissFailedMessage}
                membersById={membersById}
                messagesById={messagesById}
                onReply={beginReply}
                onOpenReplyMenu={openReplyMenu}
                onJumpToMessage={jumpToMessage}
                connection={props.connection}
              />
            ))
          ) : (
            <div className="team-chat-empty">No messages yet</div>
          )}
        </div>
        <div className="team-chat-composer-shell conversation-composer-shell">
          {replyTarget && replyAuthorLabel ? (
            <TeamChatComposerReply
              authorLabel={replyAuthorLabel}
              target={replyTarget}
              onCancel={() => setReplySelection(null)}
              onJump={() => jumpToMessage(replyTarget.id)}
            />
          ) : null}
          <Composer
            mode="dock"
            surface="team"
            teamUseModel={useModel}
            teamUseModelLocked={Boolean(replyTarget)}
            teamMentionMembers={props.members.filter(
              (member) => member.userId !== props.currentUserId,
            )}
            actionCatalog={teamActionCatalog}
            onTeamUseModelChange={setUseModel}
            prompt={prompt}
            contextWindowStatus={props.contextWindowStatus}
            busy={props.busy}
            running={false}
            focusRequestId={composerFocusRequestId}
            submissionScopeKey={`team:${props.detail?.thread.id ?? "none"}`}
            showProjectFooter={false}
            connection={props.connection}
            providerSettings={props.providerSettings}
            provider={teamProvider}
            model={teamModel}
            projectTarget={NO_PROJECT_TARGET}
            workspaceTarget={NO_WORKSPACE_TARGET}
            codexPermissionMode={props.codexPermissionMode}
            codexReasoningEffort={props.codexReasoningEffort}
            openPondCommandAccessMode={props.openPondCommandAccessMode}
            onProviderChange={props.onProviderChange}
            onProviderSetupOpen={props.onOpenProviderSettings}
            onProjectTargetChange={() => undefined}
            onWorkspaceTargetChange={() => undefined}
            onModelChange={props.onModelChange}
            onCodexPermissionModeChange={props.onCodexPermissionModeChange}
            onCodexReasoningEffortChange={props.onCodexReasoningEffortChange}
            onOpenPondCommandAccessModeChange={props.onOpenPondCommandAccessModeChange}
            onPromptChange={setPrompt}
            showToast={props.showToast}
            onSubmit={async (attachments, action) => {
              return submitTeamMessage(attachments ?? [], action ?? null);
            }}
            onStop={() => false}
          />
        </div>
      </div>
      <TeamChatReplyContextMenu
        menu={replyMenu}
        onClose={closeReplyMenu}
        onReply={beginReply}
      />
      <ConfirmDialog state={confirmDialog} onResolve={resolveConfirmDialog} />
    </section>
  );
}

export function TeamAgentConversationPanel(
  props: TeamChatViewProps & {
    onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  },
) {
  const [agentPrompt, setAgentPrompt] = useState("");
  const conversation = props.agentConversation!;
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const clientRequestIdRef = useRef<string | null>(null);
  const latestSequence = conversation.messages.at(-1)?.sequence ?? 0;
  const running = ["pending", "queued", "running"].includes(
    conversation.run.status,
  );

  useEffect(() => {
    const element = messagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [latestSequence, conversation.run.status]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onCloseAgentConversation();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onCloseAgentConversation]);

  async function submitAgentMessage(): Promise<boolean> {
    const clientRequestId =
      clientRequestIdRef.current ?? crypto.randomUUID();
    clientRequestIdRef.current = clientRequestId;
    const sent = await props.onSendAgentTurn({
      body: agentPrompt,
      clientRequestId,
    });
    if (sent) {
      clientRequestIdRef.current = null;
      setAgentPrompt("");
    }
    return sent;
  }

  return (
    <aside
      className="workspace-diff-panel team-ai-thread-panel"
      aria-label={`${conversation.agent.name} run`}
    >
      {props.onResizeStart ? (
        <div
          className="workspace-diff-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize agent run panel"
          onPointerDown={props.onResizeStart}
        />
      ) : null}
      <header>
        <div>
          <Bot size={15} />
          <strong>{conversation.agent.name}</strong>
          <span>{conversation.run.status}</span>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          className="team-chat-icon-button"
          aria-label="Close agent run"
          onClick={props.onCloseAgentConversation}
        >
          <X size={16} />
        </button>
      </header>
      <div
        className="team-ai-thread-messages"
        ref={messagesRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        tabIndex={0}
      >
        {conversation.messages.map((message) => (
          <article key={message.id} className={`team-ai-message ${message.role}`}>
            <div className="team-ai-message-author">
              {message.role === "assistant" ? <Bot size={14} /> : null}
              <strong>
                {message.role === "user"
                  ? "Team member"
                  : conversation.agent.name}
              </strong>
            </div>
            <MarkdownText connection={props.connection} content={message.body} />
          </article>
        ))}
        {conversation.messages.length === 0 ? (
          <div className="team-chat-empty">The agent run is starting.</div>
        ) : null}
      </div>
      <div className="team-ai-thread-composer">
        <Composer
          mode="dock"
          surface="team"
          teamUseModel={false}
          teamUseModelLocked
          prompt={agentPrompt}
          contextWindowStatus={props.contextWindowStatus}
          busy={props.busy || running}
          running={running}
          submissionScopeKey={`team-agent:${conversation.conversationId}`}
          showProjectFooter={false}
          connection={props.connection}
          providerSettings={props.providerSettings}
          provider={props.provider}
          model={props.model}
          projectTarget={NO_PROJECT_TARGET}
          workspaceTarget={NO_WORKSPACE_TARGET}
          codexPermissionMode={props.codexPermissionMode}
          codexReasoningEffort={props.codexReasoningEffort}
          openPondCommandAccessMode={props.openPondCommandAccessMode}
          onProviderChange={props.onProviderChange}
          onProviderSetupOpen={props.onOpenProviderSettings}
          onProjectTargetChange={() => undefined}
          onWorkspaceTargetChange={() => undefined}
          onModelChange={props.onModelChange}
          onCodexPermissionModeChange={props.onCodexPermissionModeChange}
          onCodexReasoningEffortChange={props.onCodexReasoningEffortChange}
          onOpenPondCommandAccessModeChange={
            props.onOpenPondCommandAccessModeChange
          }
          onPromptChange={(value) => {
            clientRequestIdRef.current = null;
            setAgentPrompt(value);
          }}
          showToast={props.showToast}
          onSubmit={submitAgentMessage}
          onStop={() => false}
        />
      </div>
    </aside>
  );
}

export function TeamAiThreadPanel(
  props: TeamChatViewProps & {
    onResizeStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  },
) {
  const [aiPrompt, setAiPrompt] = useState("");
  const thread = props.aiThread!;
  const membersById = new Map(props.members.map((member) => [member.userId, member]));
  const latestTurn = thread.turns.at(-1) ?? null;
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const latestSequence = thread.messages.at(-1)?.sequence ?? 0;
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const provider = TEAM_CHAT_PROVIDER_IDS.has(props.provider) ? props.provider : "codex";
  const model = provider === props.provider ? props.model : "gpt-5.6-sol";
  const running = Boolean(
    thread.activeTurn &&
    (thread.activeTurn.status === "pending" || thread.activeTurn.status === "running"),
  );
  useEffect(() => {
    const element = messagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [latestSequence, thread.activeTurn?.partialBody]);
  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onCloseAiThread();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onCloseAiThread]);

  async function submitAiMessage(): Promise<boolean> {
    const sent = await props.onSendAiTurn({
      body: aiPrompt,
      providerId: provider,
      modelId: model,
    });
    if (sent) setAiPrompt("");
    return sent;
  }

  return (
    <aside className="workspace-diff-panel team-ai-thread-panel" aria-label="AI thread">
      {props.onResizeStart ? (
        <div
          className="workspace-diff-resize-handle"
          role="separator"
          aria-label="Resize AI thread panel"
          aria-orientation="vertical"
          onPointerDown={props.onResizeStart}
        />
      ) : null}
      <header>
        <div>
          <MessageSquare size={15} />
          <strong>AI thread</strong>
          <span>{thread.messages.length} messages</span>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          className="team-chat-icon-button"
          data-tooltip="Close thread"
          aria-label="Close thread"
          onClick={props.onCloseAiThread}
        >
          <X size={16} />
        </button>
      </header>
      <div
        className="team-ai-thread-messages"
        ref={messagesRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        tabIndex={0}
      >
        {thread.messages.map((message) => (
          <article key={message.id} className={`team-ai-message ${message.role}`}>
            <div className="team-ai-message-author">
              {message.role === "assistant" ? <Bot size={14} /> : null}
              <strong>
                {message.role === "assistant"
                  ? "Model"
                  : message.createdByUserId
                    ? (membersById.get(message.createdByUserId)?.name ?? "Team member")
                    : "Team member"}
              </strong>
            </div>
            <MarkdownText connection={props.connection} content={message.body} />
          </article>
        ))}
        {thread.activeTurn?.partialBody ? (
          <article className="team-ai-message assistant streaming">
            <div className="team-ai-message-author">
              <Bot size={14} />
              <strong>Model</strong>
              <span>{thread.activeTurn.status}</span>
            </div>
            <MarkdownText connection={props.connection} content={thread.activeTurn.partialBody} />
          </article>
        ) : thread.activeTurn ? (
          <div className="team-ai-running">
            {thread.activeTurn.status === "pending"
              ? "Starting model..."
              : "Model is responding..."}
          </div>
        ) : latestTurn && ["failed", "interrupted", "cancelled"].includes(latestTurn.status) ? (
          <div className={`team-ai-turn-state ${latestTurn.status}`}>
            {latestTurn.status === "failed"
              ? "Model response failed"
              : latestTurn.status === "interrupted"
                ? "Model response was interrupted"
                : "Model response was cancelled"}
          </div>
        ) : null}
      </div>
      <div className="team-ai-thread-composer">
        <Composer
          mode="dock"
          surface="team"
          teamUseModel
          teamUseModelLocked
          prompt={aiPrompt}
          contextWindowStatus={props.contextWindowStatus}
          busy={running}
          running={running}
          submissionScopeKey={`team-ai:${thread.conversationId}`}
          showProjectFooter={false}
          connection={props.connection}
          providerSettings={props.providerSettings}
          provider={provider}
          model={model}
          projectTarget={NO_PROJECT_TARGET}
          workspaceTarget={NO_WORKSPACE_TARGET}
          codexPermissionMode={props.codexPermissionMode}
          codexReasoningEffort={props.codexReasoningEffort}
          openPondCommandAccessMode={props.openPondCommandAccessMode}
          onProviderChange={props.onProviderChange}
          onProviderSetupOpen={props.onOpenProviderSettings}
          onProjectTargetChange={() => undefined}
          onWorkspaceTargetChange={() => undefined}
          onModelChange={props.onModelChange}
          onCodexPermissionModeChange={props.onCodexPermissionModeChange}
          onCodexReasoningEffortChange={props.onCodexReasoningEffortChange}
          onOpenPondCommandAccessModeChange={props.onOpenPondCommandAccessModeChange}
          onPromptChange={setAiPrompt}
          showToast={props.showToast}
          onSubmit={submitAiMessage}
          onStop={props.onStopAiTurn}
        />
      </div>
    </aside>
  );
}
