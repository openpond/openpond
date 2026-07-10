import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "../../styles/team-chat/team-chat.css";
import type {
  ChatAttachment,
  ChatProvider,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondCommandAccessMode,
  ProviderSettings,
  TeamChatHostedAiThread,
  TeamChatMember,
  TeamChatMessage,
  TeamChatThread,
  TeamChatThreadDetail,
} from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import type { ContextWindowStatus } from "../../lib/context-window";
import type { WorkspaceTargetState } from "../../lib/workspace-location";
import { teamChatThreadTitle } from "../../lib/team-chat-thread";
import { Composer } from "../chat/Composer";
import type { ComposerProjectTargetState } from "../chat/ComposerControls";
import { MarkdownText } from "../chat/MarkdownText";
import { Bot, MessageSquare, RefreshCw, SquarePen, Trash2, X } from "../icons";

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

export type TeamChatViewProps = {
  currentUserId: string | null;
  members: TeamChatMember[];
  detail: TeamChatThreadDetail | null;
  aiThread: TeamChatHostedAiThread | null;
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
  }) => Promise<boolean>;
  onOpenAiThread: (conversationId: string) => Promise<void>;
  onCloseAiThread: () => void;
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
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const stickToLatestRef = useRef(true);
  const membersById = useMemo(
    () => new Map(props.members.map((member) => [member.userId, member])),
    [props.members],
  );
  const title = props.detail
    ? teamChatThreadTitle(props.detail.thread, props.currentUserId)
    : "Team";
  const teamProvider = TEAM_CHAT_PROVIDER_IDS.has(props.provider) ? props.provider : "codex";
  const teamModel = teamProvider === props.provider ? props.model : "gpt-5.6-sol";
  const lastMessageSequence = props.detail?.messages.at(-1)?.sequence ?? 0;
  useEffect(() => {
    if (!stickToLatestRef.current) return;
    const element = messagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lastMessageSequence, props.detail?.thread.id]);

  async function submitTeamMessage(attachments: ChatAttachment[] = []): Promise<boolean> {
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
    const sent = await props.onSendMessage({
      body: prompt,
      useModel,
      providerId: teamProvider,
      modelId: teamModel,
      mentionUserIds: mentionedTeamMemberIds(prompt, props.members),
      attachments,
    });
    if (sent) setPrompt("");
    return sent;
  }

  return (
    <section className="team-chat-view">
      <div className="team-chat-main">
        <header className="team-chat-header">
          <div>
            <h2>{title}</h2>
            {props.detail?.thread.kind === "dm" ? (
              <span>{dmMemberStatus(props.detail.thread, props.currentUserId)}</span>
            ) : null}
          </div>
        </header>
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
          className="team-chat-messages"
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
                onEdit={props.onEditMessage}
                onDelete={props.onDeleteMessage}
                onRetry={props.onRetryMessage}
                onDismissFailed={props.onDismissFailedMessage}
                connection={props.connection}
              />
            ))
          ) : (
            <div className="team-chat-empty">No messages yet</div>
          )}
        </div>
        <div className="team-chat-composer-shell">
          <Composer
            mode="dock"
            surface="team"
            teamUseModel={useModel}
            teamMentionMembers={props.members.filter(
              (member) => member.userId !== props.currentUserId,
            )}
            onTeamUseModelChange={setUseModel}
            prompt={prompt}
            contextWindowStatus={props.contextWindowStatus}
            busy={props.busy}
            running={false}
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
            onSubmit={async (attachments) => {
              return submitTeamMessage(attachments ?? []);
            }}
            onStop={() => false}
          />
        </div>
      </div>
    </section>
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

function TeamChatMessageRow(props: {
  message: TeamChatMessage;
  author: TeamChatMember | null;
  own: boolean;
  onOpenAiThread: (conversationId: string) => Promise<void>;
  onEdit: (message: TeamChatMessage, body: string) => Promise<boolean>;
  onDelete: (message: TeamChatMessage) => Promise<boolean>;
  onRetry: (message: TeamChatMessage) => Promise<boolean>;
  onDismissFailed: (message: TeamChatMessage) => void;
  connection: ClientConnection | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.message.body);
  const aiRef = props.message.refs.find((ref) => ref.refType === "hosted_ai_thread");
  const aiStatus = typeof aiRef?.preview.status === "string" ? aiRef.preview.status : null;
  const deliveryStatus =
    typeof props.message.metadata.deliveryStatus === "string"
      ? props.message.metadata.deliveryStatus
      : null;
  const uploadProgress =
    typeof props.message.metadata.uploadProgress === "string"
      ? props.message.metadata.uploadProgress
      : null;
  return (
    <article className={`team-chat-message${props.own ? " own" : ""}`}>
      <TeamAvatar member={props.author} />
      <div className="team-chat-message-content">
        <header>
          <strong>{props.author?.name ?? "Team member"}</strong>
          <time>{messageTime(props.message.createdAt)}</time>
          {props.message.editedAt ? <span>edited</span> : null}
          {deliveryStatus === "sending" ? <span>sending</span> : null}
          {deliveryStatus === "sending" && uploadProgress ? (
            <span>uploaded {uploadProgress}</span>
          ) : null}
          {deliveryStatus === "failed" ? <span className="failed">not sent</span> : null}
          {deliveryStatus === "failed" ? (
            <div className="team-chat-message-actions visible">
              <button
                type="button"
                data-tooltip="Retry message"
                aria-label="Retry message"
                onClick={() => void props.onRetry(props.message)}
              >
                <RefreshCw size={13} />
              </button>
              <button
                type="button"
                data-tooltip="Remove failed message"
                aria-label="Remove failed message"
                onClick={() => props.onDismissFailed(props.message)}
              >
                <X size={13} />
              </button>
            </div>
          ) : props.own && !props.message.deletedAt && !deliveryStatus ? (
            <div className="team-chat-message-actions">
              {!aiRef ? (
                <button
                  type="button"
                  data-tooltip="Edit message"
                  aria-label="Edit message"
                  onClick={() => setEditing(true)}
                >
                  <SquarePen size={13} />
                </button>
              ) : null}
              <button
                type="button"
                data-tooltip="Delete message"
                aria-label="Delete message"
                onClick={() => void props.onDelete(props.message)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ) : null}
        </header>
        {editing ? (
          <form
            className="team-chat-message-edit"
            onSubmit={(event) => {
              event.preventDefault();
              void props.onEdit(props.message, draft).then((saved) => {
                if (saved) setEditing(false);
              });
            }}
          >
            <textarea
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                setEditing(false);
                setDraft(props.message.body);
              }}
            />
            <div>
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button type="submit" disabled={!draft.trim()}>
                Save
              </button>
            </div>
          </form>
        ) : (
          <div className={props.message.deletedAt ? "deleted" : ""}>
            {props.message.deletedAt ? "Message deleted" : props.message.body}
          </div>
        )}
        {!props.message.deletedAt && props.message.attachments.length > 0 ? (
          <TeamChatMessageImages message={props.message} connection={props.connection} />
        ) : null}
        {aiRef ? (
          <button
            type="button"
            className="team-chat-thread-link"
            onClick={() => void props.onOpenAiThread(aiRef.refId)}
          >
            <MessageSquare size={14} />
            <span>Thread</span>
            {aiStatus && aiStatus !== "completed" ? (
              <small>{threadStatusLabel(aiStatus)}</small>
            ) : null}
            <span aria-hidden="true">›</span>
          </button>
        ) : null}
      </div>
    </article>
  );
}

function TeamChatMessageImages(props: {
  message: TeamChatMessage;
  connection: ClientConnection | null;
}) {
  const localPreviews = new Map(
    Array.isArray(props.message.metadata.localAttachmentPreviews)
      ? props.message.metadata.localAttachmentPreviews.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const candidate = value as { id?: unknown; url?: unknown };
          return typeof candidate.id === "string" && typeof candidate.url === "string"
            ? [[candidate.id, candidate.url] as const]
            : [];
        })
      : [],
  );
  return (
    <div className="team-chat-message-images">
      {props.message.attachments.map((attachment) => (
        <TeamChatMessageImage
          key={attachment.id}
          attachmentId={attachment.id}
          alt={attachment.name}
          teamId={props.message.teamId}
          connection={props.connection}
          localUrl={localPreviews.get(attachment.clientAttachmentId) ?? null}
        />
      ))}
    </div>
  );
}

function TeamChatMessageImage(props: {
  attachmentId: string;
  alt: string;
  teamId: string;
  connection: ClientConnection | null;
  localUrl: string | null;
}) {
  const [url, setUrl] = useState<string | null>(props.localUrl);
  const [failed, setFailed] = useState(false);
  const refreshCountRef = useRef(0);

  async function refreshUrl(): Promise<void> {
    if (!props.connection || props.localUrl) {
      if (!props.localUrl) setFailed(true);
      return;
    }
    setFailed(false);
    try {
      const result = await api.teamChatAttachmentDownload(
        props.connection,
        props.teamId,
        props.attachmentId,
      );
      setUrl(result.url);
    } catch {
      setUrl(null);
      setFailed(true);
    }
  }

  useEffect(() => {
    setUrl(props.localUrl);
    setFailed(false);
    refreshCountRef.current = 0;
    if (!props.localUrl) void refreshUrl();
    // The identifiers define the signed URL request; refreshUrl intentionally stays local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.attachmentId, props.connection, props.localUrl, props.teamId]);

  return url ? (
    <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${props.alt}`}>
      <img
        src={url}
        alt={props.alt}
        loading="lazy"
        onError={() => {
          if (!props.localUrl && refreshCountRef.current < 1) {
            refreshCountRef.current += 1;
            void refreshUrl();
            return;
          }
          setUrl(null);
          setFailed(true);
        }}
      />
    </a>
  ) : failed ? (
    <button
      type="button"
      className="team-chat-message-image-retry"
      aria-label={`Retry ${props.alt}`}
      data-tooltip="Retry image"
      onClick={() => {
        refreshCountRef.current = 0;
        if (props.localUrl) {
          setFailed(false);
          setUrl(props.localUrl);
        } else {
          void refreshUrl();
        }
      }}
    >
      <RefreshCw size={18} />
    </button>
  ) : (
    <div
      className="team-chat-message-image-loading"
      role="status"
      aria-label={`Loading ${props.alt}`}
    />
  );
}

function threadStatusLabel(status: string): string {
  if (status === "pending") return "Starting";
  if (status === "running") return "Responding";
  if (status === "failed") return "Failed";
  if (status === "interrupted") return "Interrupted";
  if (status === "cancelled") return "Cancelled";
  return status;
}

function TeamAvatar({ member }: { member: TeamChatMember | null }) {
  if (member?.image) {
    return <img className="team-chat-avatar" src={member.image} alt="" />;
  }
  const initials = (member?.name ?? "T")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return <span className="team-chat-avatar fallback">{initials}</span>;
}

function dmMemberStatus(thread: TeamChatThread, currentUserId: string | null): string {
  const other = thread.participants.find((participant) => participant.userId !== currentUserId);
  return other?.handle ? `@${other.handle}` : "Direct message";
}

function messageTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";
}

function mentionedTeamMemberIds(body: string, members: TeamChatMember[]): string[] {
  const tokens = new Set(
    Array.from(body.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)/g), (match) =>
      (match[1] ?? "").toLowerCase(),
    ),
  );
  return members
    .filter((member) => {
      const handle = member.handle?.toLowerCase();
      const normalizedName = member.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      return (handle && tokens.has(handle)) || tokens.has(normalizedName);
    })
    .map((member) => member.userId);
}
