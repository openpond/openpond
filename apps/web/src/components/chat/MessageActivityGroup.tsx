import { useId, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  CircleAlert,
  Bot,
  FileText,
  FolderOpen,
  Globe2,
  ImageIcon,
  ListFilter,
  Lightbulb,
  PanelRight,
  Play,
  Search,
  SquarePen,
  SquareTerminal,
  type LucideIcon,
} from "../icons";
import type { ClientConnection } from "../../api";
import { useLocalImageUrl } from "../../hooks/useLocalImageUrl";
import { useLocalVideoUrl } from "../../hooks/useLocalVideoUrl";
import { useWorkspaceImageUrl } from "../../hooks/useWorkspaceImageUrl";
import type { ActivityItem, ChatMessage } from "../../lib/app-models";
import {
  summarizeActivityGroup,
  summarizeShellCommand,
  type ActivityGroupSummaryKind,
} from "../../lib/chat-activity-summary";
import {
  formatWorkTraceDuration,
  workTracePresentation,
} from "../../lib/chat-work-trace";
import { workspaceFileName } from "../../lib/workspace-images";
import { revealLocalFile } from "../../lib/desktop-files";
import { ImageLightbox } from "../common/ImageLightbox";
import {
  SubagentAvatarButton,
  SubagentAvatarGroup,
  subagentOpenSessions,
  subagentRoleLabel,
} from "./SubagentAvatarGroup";
import { HarnessRefinerReceipt } from "./HarnessRefinerReceipt";
import { ChatActivitySummary } from "./ChatActivitySummary";
import { ActivityFileArtifact } from "./ActivityFileArtifact";

const SUBAGENT_MESSAGE_VISIBLE_LINES = 5;
const SUBAGENT_MESSAGE_COLLAPSE_MIN_CHARS = 280;

export function ActivityGroup({
  activeWorkspaceAppId,
  connection,
  message,
  onOpenFileInSidebar,
  onOpenSession,
}: {
  activeWorkspaceAppId: string | null;
  connection: ClientConnection | null;
  message: ChatMessage;
  onOpenFileInSidebar?: (path: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const activities = message.activities ?? [];
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [openImage, setOpenImage] = useState<
    ActivityItem["imagePreview"] | null
  >(null);
  const toolListId = useId();
  const summary = useMemo(
    () => summarizeActivityGroup(activities),
    [activities]
  );
  const presentation = useMemo(
    () => workTracePresentation(activities, toolsExpanded),
    [activities, toolsExpanded]
  );
  const summaryImage =
    activities.find((activity) => activity.imagePreview)?.imagePreview ?? null;
  const artifacts = message.deliverables ?? [];
  const openImageSrc = useActivityImageUrl(
    openImage,
    connection,
    activeWorkspaceAppId
  );
  const running = message.traceState === "running";
  const danger =
    message.traceState === "failed" || message.traceState === "interrupted";
  const duration = formatWorkTraceDuration(
    message.traceStartedAt,
    message.traceCompletedAt
  );
  const summaryText = workTraceSummaryText(
    summary.text,
    message.traceState,
    duration,
    activities
  );
  const summaryOpenSessions = subagentOpenSessions(activities);
  const childMessageSummary =
    activities.length > 0 &&
    activities.every((activity) => activity.subagentMessage);

  if (childMessageSummary) {
    return (
      <>
        <SubagentMessageActivityGroup activities={activities} />
        <RefinerActivityRow activity={message.refinerActivity} />
      </>
    );
  }

  return (
    <>
      {activities.length > 0 || artifacts.length > 0 ? (
        <article
          className={`activity-group work-trace ${running ? "running" : "settled"}`}
        >
          {activities.length > 0 ? (
            <div className="activity-summary-row">
              <ChatActivitySummary
                controls={presentation.toolCount > 0 ? toolListId : undefined}
                danger={danger}
                expanded={presentation.toolsExpanded}
                icon={
                  summaryImage ? (
                    <ActivitySummaryImage
                      activeWorkspaceAppId={activeWorkspaceAppId}
                      connection={connection}
                      image={summaryImage}
                    />
                  ) : (
                    <ActivitySummaryIcon kind={summary.kind} />
                  )
                }
                onToggle={
                  presentation.toolCount > 0
                    ? () => setToolsExpanded((current) => !current)
                    : undefined
                }
                running={running}
              >
                {summaryText}
              </ChatActivitySummary>
              {summaryOpenSessions.length > 0 && onOpenSession ? (
                <SubagentAvatarGroup
                  onOpenSession={onOpenSession}
                  onShowAll={() => setToolsExpanded(true)}
                  sessions={summaryOpenSessions}
                />
              ) : null}
            </div>
          ) : null}
          {artifacts.length > 0 ? (
            <ActivityArtifacts
              artifacts={artifacts}
              connection={connection}
              onOpenFileInSidebar={onOpenFileInSidebar}
            />
          ) : null}
          {presentation.visibleActivities.length > 0 ? (
            <div className="work-trace-flow" id={toolListId}>
              {presentation.visibleActivities.map((activity) => (
                <ActivityToolRow
                  activeWorkspaceAppId={activeWorkspaceAppId}
                  activity={activity}
                  connection={connection}
                  key={activity.id}
                  onOpenImage={setOpenImage}
                  onOpenSession={onOpenSession}
                />
              ))}
            </div>
          ) : null}
          <ImageLightbox
            open={Boolean(openImageSrc)}
            src={openImageSrc}
            title={openImage?.path ?? ""}
            onClose={() => setOpenImage(null)}
          />
        </article>
      ) : null}
      <RefinerActivityRow activity={message.refinerActivity} />
    </>
  );
}

function RefinerActivityRow({
  activity,
}: {
  activity: ChatMessage["refinerActivity"];
}) {
  if (!activity) return null;
  return (
    <article className="refiner-activity-row">
      <HarnessRefinerReceipt activity={activity} />
    </article>
  );
}

function ActivityToolRow({
  activeWorkspaceAppId,
  activity,
  connection,
  onOpenImage,
  onOpenSession,
}: {
  activeWorkspaceAppId: string | null;
  activity: ActivityItem;
  connection: ClientConnection | null;
  onOpenImage: (image: ActivityItem["imagePreview"] | null) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  if (activity.subagentMessage) {
    return <SubagentMessageDetailRow activity={activity} />;
  }
  return (
    <div
      className={`activity-tool-row ${
        activity.controlKind === "turn_aborted" ? "danger" : ""
      }`}
    >
      <ChatActivitySummary
        className="activity-tool-summary"
        controls={detailsId}
        danger={activity.controlKind === "turn_aborted"}
        expanded={expanded}
        icon={
          activity.kind === "command" ? (
            <SquareTerminal
              aria-hidden
              className="activity-summary-kind-icon"
              size={12}
            />
          ) : undefined
        }
        onToggle={() => setExpanded((current) => !current)}
      >
        {activityToolRowLabel(activity)}
      </ChatActivitySummary>
      {expanded ? (
        <ActivityToolDetails
          activeWorkspaceAppId={activeWorkspaceAppId}
          activity={activity}
          connection={connection}
          detailsId={detailsId}
          onOpenImage={onOpenImage}
          onOpenSession={onOpenSession}
        />
      ) : null}
    </div>
  );
}

function ActivityToolDetails({
  activeWorkspaceAppId,
  activity,
  connection,
  detailsId,
  onOpenImage,
  onOpenSession,
}: {
  activeWorkspaceAppId: string | null;
  activity: ActivityItem;
  connection: ClientConnection | null;
  detailsId: string;
  onOpenImage: (image: ActivityItem["imagePreview"] | null) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const imageSrc = useActivityImageUrl(
    activity.imagePreview ?? null,
    connection,
    activeWorkspaceAppId
  );
  return (
    <div className="activity-tool-details" id={detailsId}>
          {activity.kind === "command" && activity.content ? (
            <CommandTerminal
              command={activity.content}
              exitCode={activity.terminal?.exitCode}
              output={activity.detail}
              state={activity.state}
            />
          ) : activity.content ? (
            isMultilineActivity(activity.content) ? (
              <pre className="activity-detail-output">{activity.content}</pre>
            ) : (
              <code className="activity-tool-content">{activity.content}</code>
            )
          ) : null}
          {activity.detail && activity.kind !== "command" ? (
            <pre className="activity-detail-output">
              {activity.detail.replace(/\r\n/g, "\n").trimEnd()}
            </pre>
          ) : null}
          {activity.meta ? (
            <small className="activity-detail-meta">{activity.meta}</small>
          ) : null}
          {activity.imagePreview && imageSrc ? (
            <button
              type="button"
              className="activity-image-preview"
              title={`Open ${activity.imagePreview.path}`}
              onClick={() => onOpenImage(activity.imagePreview ?? null)}
            >
              <img
                alt={workspaceFileName(activity.imagePreview.path)}
                decoding="async"
                loading="lazy"
                src={imageSrc}
              />
            </button>
          ) : null}
          {activity.openSession && onOpenSession ? (
            <SubagentAvatarButton
              className="activity-subagent-detail-avatar"
              openSession={activity.openSession}
              onOpenSession={onOpenSession}
            />
          ) : null}
        </div>
  );
}

function ActivityArtifacts({
  artifacts,
  connection,
  onOpenFileInSidebar,
}: {
  artifacts: NonNullable<ActivityItem["artifacts"]>;
  connection: ClientConnection | null;
  onOpenFileInSidebar?: (path: string) => void;
}) {
  return (
    <div className="activity-artifact-list">
      {artifacts.map((artifact) => {
        if (artifact.contentType.startsWith("video/")) {
          return (
            <ActivityVideoArtifact
              artifact={artifact}
              connection={connection}
              key={artifact.path}
              onOpenFileInSidebar={onOpenFileInSidebar}
            />
          );
        }
        if (artifact.contentType.startsWith("image/")) {
          return (
            <ActivityImageArtifact
              artifact={artifact}
              connection={connection}
              key={artifact.path}
            />
          );
        }
        return (
          <ActivityFileArtifact
            artifact={artifact}
            key={artifact.path}
            onOpenFileInSidebar={onOpenFileInSidebar}
          />
        );
      })}
    </div>
  );
}

function ActivityImageArtifact({
  artifact,
  connection,
}: {
  artifact: NonNullable<ActivityItem["artifacts"]>[number];
  connection: ClientConnection | null;
}) {
  const [open, setOpen] = useState(false);
  const src = useLocalImageUrl(connection, artifact.path);
  return (
    <div className="activity-artifact-image" title={artifact.path}>
      <button
        type="button"
        disabled={!src}
        onClick={() => setOpen(true)}
        title={`Open ${artifact.title}`}
      >
        {src ? (
          <img alt={artifact.title} decoding="async" loading="lazy" src={src} />
        ) : (
          <ImageIcon aria-hidden size={20} />
        )}
      </button>
      <strong>{artifact.title}</strong>
      <ImageLightbox
        open={open && Boolean(src)}
        src={src}
        title={artifact.title}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

function ActivityVideoArtifact({
  artifact,
  connection,
  onOpenFileInSidebar,
}: {
  artifact: NonNullable<ActivityItem["artifacts"]>[number];
  connection: ClientConnection | null;
  onOpenFileInSidebar?: (path: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [started, setStarted] = useState(false);
  const src = useLocalVideoUrl(connection, artifact.path);
  const startPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    void video
      .play()
      .then(() => setStarted(true))
      .catch(() => undefined);
  };
  return (
    <div className="activity-artifact-video" title={artifact.path}>
      <div className="activity-artifact-video-stage">
        {src ? (
          <video
            controls
            onPlay={() => setStarted(true)}
            preload="metadata"
            ref={videoRef}
            src={src}
          />
        ) : (
          <div className="activity-artifact-video-loading">
            Preparing video…
          </div>
        )}
        {src && !started ? (
          <button
            type="button"
            className="activity-artifact-video-play"
            onClick={startPlayback}
            aria-label={`Play ${artifact.title}`}
          >
            <Play aria-hidden fill="currentColor" size={22} />
          </button>
        ) : null}
      </div>
      <div className="activity-artifact-video-footer">
        <button
          type="button"
          className="activity-artifact-video-file"
          onClick={() => void revealLocalFile(artifact.path)}
          title={`Show ${artifact.path} in its folder`}
        >
          <FolderOpen aria-hidden size={13} />
          <span>
            <strong>{artifact.title}</strong>
            <code>{artifact.path}</code>
          </span>
          <small>
            {artifact.sizeBytes == null
              ? artifact.contentType
              : formatArtifactSize(artifact.sizeBytes)}
          </small>
        </button>
        {onOpenFileInSidebar ? (
          <button
            type="button"
            className="activity-artifact-video-sidebar"
            onClick={() => onOpenFileInSidebar(artifact.path)}
            title="Open video in sidebar"
          >
            <PanelRight aria-hidden size={13} />
            Open in sidebar
          </button>
        ) : null}
      </div>
    </div>
  );
}

function formatArtifactSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function SubagentMessageDetailRow({ activity }: { activity: ActivityItem }) {
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const message = activity.subagentMessage;
  if (!message) return null;
  const roleLabel = `${subagentRoleLabel(
    message.roleId ?? activity.openSession?.roleId
  )} subagent`;
  const baseTitle =
    message.direction === "received"
      ? `${roleLabel} update`
      : `Message to ${roleLabel.toLowerCase()}`;
  const title = message.modelRef?.modelId
    ? `${baseTitle} · ${message.modelRef.modelId}`
    : baseTitle;
  const facts = subagentMessageFacts(message);
  const collapsible = subagentMessageNeedsCollapse(message.body);
  return (
    <div
      className={`activity-child-message ${message.direction}`}
      key={activity.id}
    >
      <div className="activity-child-message-card">
        <div className="activity-child-message-header">
          <span className="activity-child-message-title">
            <Bot aria-hidden size={14} />
            <strong title={title}>{title}</strong>
          </span>
          <small>{message.kind.replace(/_/g, " ")}</small>
        </div>
        <p
          className={collapsible && !bodyExpanded ? "collapsed" : undefined}
          style={
            {
              "--subagent-message-visible-lines":
                SUBAGENT_MESSAGE_VISIBLE_LINES,
            } as CSSProperties
          }
        >
          {message.body}
        </p>
        {collapsible ? (
          <button
            type="button"
            className="activity-child-message-toggle"
            aria-expanded={bodyExpanded}
            onClick={() => setBodyExpanded((current) => !current)}
          >
            {bodyExpanded ? "Show less" : "Show more"}
          </button>
        ) : null}
        <details className="activity-child-message-details">
          <summary>Message details</summary>
          <div
            className="activity-child-message-facts"
            aria-label="Child message metadata"
          >
            {facts.map((fact) => (
              <span key={fact.label}>
                <small>{fact.label}</small>
                <code title={fact.value}>{fact.value}</code>
              </span>
            ))}
          </div>
        </details>
        {message.refs?.length ? (
          <div
            className="activity-child-message-refs"
            aria-label="Child message references"
          >
            {message.refs.map((ref) => (
              <span key={`${ref.kind}:${ref.id}`}>
                {ref.kind}:{ref.id} ({ref.label})
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SubagentMessageActivityGroup({
  activities,
}: {
  activities: ActivityItem[];
}) {
  const direction = activities[0]?.subagentMessage?.direction ?? "received";
  return (
    <article className={`activity-child-message-group ${direction}`}>
      {activities.map((activity) => (
        <SubagentMessageDetailRow activity={activity} key={activity.id} />
      ))}
    </article>
  );
}

function subagentMessageFacts(
  message: NonNullable<ActivityItem["subagentMessage"]>
): Array<{ label: string; value: string }> {
  return [
    { label: "Message", value: message.messageId },
    { label: "Kind", value: message.kind },
    { label: "From", value: message.fromRunId },
    message.roleId ? { label: "Role", value: message.roleId } : null,
    message.modelRef
      ? {
          label: "Model",
          value: `${message.modelRef.providerId}/${message.modelRef.modelId}`,
        }
      : null,
    message.childSessionId
      ? { label: "Child", value: message.childSessionId }
      : null,
    message.toRunId ? { label: "To run", value: message.toRunId } : null,
    message.toRole ? { label: "To role", value: message.toRole } : null,
    message.deliveryStatus
      ? { label: "Delivery", value: message.deliveryStatus }
      : null,
    message.wakeReason ? { label: "Wake", value: message.wakeReason } : null,
    message.createdAt ? { label: "Created", value: message.createdAt } : null,
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact));
}

export function subagentMessageNeedsCollapse(body: string): boolean {
  return (
    body.length > SUBAGENT_MESSAGE_COLLAPSE_MIN_CHARS ||
    body.split(/\r?\n/).length > SUBAGENT_MESSAGE_VISIBLE_LINES
  );
}

function workTraceSummaryText(
  summary: string,
  traceState: ChatMessage["traceState"],
  duration: string | null,
  activities: ActivityItem[]
): string {
  if (traceState === "running") {
    return latestWorkTraceActivitySummary(activities) || summary || "Working…";
  }
  if (traceState === "failed") {
    return `${duration ? `Failed after ${duration}` : "Failed"}${
      summary ? ` · ${summary}` : ""
    }`;
  }
  if (traceState === "interrupted") {
    return `${duration ? `Interrupted after ${duration}` : "Interrupted"}${
      summary ? ` · ${summary}` : ""
    }`;
  }
  if (traceState === "completed") {
    return `${duration ? `Worked for ${duration}` : "Worked"}${
      summary ? ` · ${summary}` : ""
    }`;
  }
  return summary;
}

function latestWorkTraceActivitySummary(
  activities: ActivityItem[]
): string | null {
  let latestVisible: ActivityItem | null = null;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind === "reasoning") continue;
    latestVisible ??= activity;
    if (activity.state === "running" || activity.state === "pending") {
      return activitySummaryText(activity);
    }
  }
  return latestVisible ? activitySummaryText(latestVisible) : null;
}

function activitySummaryText(activity: ActivityItem): string | null {
  if (activity.kind === "command") {
    if (activity.state === "failed") return "Command failed";
    return (
      summarizeShellCommand(activity.content, activity.state) ??
      (activity.state === "running" || activity.state === "pending"
        ? "Running command"
        : "Ran command")
    );
  }
  return activity.label.trim() || null;
}

export function activityToolRowLabel(activity: ActivityItem): string {
  if (activity.kind !== "command") return activity.label;
  if (activity.state === "running" || activity.state === "pending") {
    return activitySummaryText(activity) ?? "Running command";
  }
  const duration = formatCommandDuration(activity.terminal?.durationMs);
  if (activity.state === "failed") {
    return `Command failed${duration ? ` in ${duration}` : ""}`;
  }
  const summary = activitySummaryText(activity) ?? "Ran command";
  return `${summary}${duration ? ` in ${duration}` : ""}`;
}

function CommandTerminal({
  command,
  exitCode,
  output,
  state,
}: {
  command: string;
  exitCode?: number | null;
  output?: string;
  state: ActivityItem["state"];
}) {
  const terminalStatus =
    state === "running" || state === "pending"
      ? "Running…"
      : exitCode != null
        ? `Exit code ${exitCode}`
        : state === "completed"
          ? "Exit code 0"
          : "Failed";
  return (
    <section
      aria-label="Shell command output"
      className={`activity-command-terminal ${state ?? "completed"}`}
    >
      <header>Shell</header>
      <pre>
        <code className="shell-command-code">
          <span className="activity-command-prompt" aria-hidden>
            $&nbsp;
          </span>
          {highlightShellCommand(command)}
          {output ? (
            <span className="activity-command-output">
              {`\n${output.replace(/\r\n/g, "\n").trimEnd()}`}
            </span>
          ) : null}
        </code>
      </pre>
      <footer>{terminalStatus}</footer>
    </section>
  );
}

function formatCommandDuration(durationMs: number | undefined): string | null {
  if (durationMs == null || durationMs < 0) return null;
  if (durationMs < 60_000) return `${Math.max(1, Math.round(durationMs / 1000))}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function highlightShellCommand(command: string) {
  return tokenizeShellCommand(command).map((token, index) => (
    <span
      className={`shell-token ${token.kind}`}
      key={`${index}-${token.text}`}
    >
      {token.text}
    </span>
  ));
}

type ShellToken = {
  kind:
    | "plain"
    | "command"
    | "flag"
    | "string"
    | "operator"
    | "variable"
    | "path";
  text: string;
};

function tokenizeShellCommand(command: string): ShellToken[] {
  const tokens = command.match(
    /"[^"]*"|'[^']*'|&&|\|\||[|;&()<>]|\s+|[^\s|;&()<>]+/g
  ) ?? [command];
  let expectsCommand = true;
  return tokens.map((text) => {
    if (/^\s+$/.test(text)) return { kind: "plain", text };
    if (/^(?:&&|\|\||[|;&()<>])$/.test(text)) {
      expectsCommand = text !== ")" && text !== ">";
      return { kind: "operator", text };
    }
    if (/^(['"]).*\1$/.test(text)) return { kind: "string", text };
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(text))
      return { kind: "variable", text };
    if (expectsCommand) {
      expectsCommand = false;
      return { kind: "command", text };
    }
    if (/^-{1,2}[\w-]/.test(text)) return { kind: "flag", text };
    if (/^(?:\.{0,2}\/|~\/|[\w.-]+\/)/.test(text))
      return { kind: "path", text };
    return { kind: "plain", text };
  });
}

function ActivitySummaryImage({
  activeWorkspaceAppId,
  connection,
  image,
}: {
  activeWorkspaceAppId: string | null;
  connection: ClientConnection | null;
  image: NonNullable<ActivityItem["imagePreview"]>;
}) {
  const src = useActivityImageUrl(image, connection, activeWorkspaceAppId);
  if (!src) return null;
  return (
    <img
      aria-hidden
      className="activity-summary-image"
      decoding="async"
      loading="lazy"
      src={src}
      alt=""
    />
  );
}

function ActivitySummaryIcon({ kind }: { kind: ActivityGroupSummaryKind }) {
  const Icon = activitySummaryIcon(kind);
  return (
    <Icon
      aria-hidden
      className={`activity-summary-kind-icon ${kind}`}
      size={14}
    />
  );
}

function activitySummaryIcon(kind: ActivityGroupSummaryKind): LucideIcon {
  if (kind === "approval" || kind === "control") return CircleAlert;
  if (kind === "edit") return SquarePen;
  if (kind === "image") return ImageIcon;
  if (kind === "list") return ListFilter;
  if (kind === "read") return FileText;
  if (kind === "reasoning") return Lightbulb;
  if (kind === "search") return Search;
  if (kind === "subagent") return Bot;
  if (kind === "web") return Globe2;
  return SquareTerminal;
}

function useActivityImageUrl(
  image: ActivityItem["imagePreview"] | null,
  connection: ClientConnection | null,
  activeWorkspaceAppId: string | null
): string | null {
  const localPath =
    image && isAbsoluteLocalImagePath(image.path) ? image.path : null;
  const appId = image?.appId ?? activeWorkspaceAppId;
  const localUrl = useLocalImageUrl(connection, localPath);
  const workspaceUrl = useWorkspaceImageUrl(
    connection,
    localPath ? null : appId,
    localPath ? null : image?.path
  );
  return localPath ? localUrl : workspaceUrl;
}

function isAbsoluteLocalImagePath(path: string): boolean {
  return (
    /^file:\/\//i.test(path) || /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path)
  );
}

function isMultilineActivity(value: string): boolean {
  return value.includes("\n") || value.length > 160;
}
