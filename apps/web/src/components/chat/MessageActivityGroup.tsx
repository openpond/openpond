import { useState } from "react";
import {
  ChevronDown,
  CircleAlert,
  FileText,
  Globe2,
  ImageIcon,
  ListFilter,
  Search,
  SquarePen,
  SquareTerminal,
  type LucideIcon,
} from "../icons";
import type { ClientConnection } from "../../api";
import { useLocalImageUrl } from "../../hooks/useLocalImageUrl";
import { useWorkspaceImageUrl } from "../../hooks/useWorkspaceImageUrl";
import type { ActivityItem, ChatMessage } from "../../lib/app-models";
import {
  summarizeActivityGroup,
  summarizeShellCommand,
  type ActivityGroupSummaryKind,
} from "../../lib/chat-activity-summary";
import { workspaceFileName } from "../../lib/workspace-images";
import { ImageLightbox } from "../common/ImageLightbox";

const COMMAND_OUTPUT_VISIBLE_LINES = 5;

export function ActivityGroup({
  activeWorkspaceAppId,
  connection,
  message,
}: {
  activeWorkspaceAppId: string | null;
  connection: ClientConnection | null;
  message: ChatMessage;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openImage, setOpenImage] = useState<ActivityItem["imagePreview"] | null>(null);
  const activities = message.activities ?? [];
  const summary = summarizeActivityGroup(activities);
  const summaryImage = activities.find((activity) => activity.imagePreview)?.imagePreview ?? null;
  const openImageSrc = useActivityImageUrl(openImage, connection, activeWorkspaceAppId);
  const danger = activities.some((activity) => activity.controlKind === "turn_aborted");

  return (
    <article className="activity-group">
      <button
        type="button"
        aria-expanded={expanded}
        className={`activity-summary ${danger ? "danger" : ""}`}
        onClick={() => setExpanded((current) => !current)}
      >
        {summaryImage ? (
          <ActivitySummaryImage activeWorkspaceAppId={activeWorkspaceAppId} connection={connection} image={summaryImage} />
        ) : (
          <ActivitySummaryIcon kind={summary.kind} />
        )}
        <ActivitySummaryText summary={summary.text} />
        <ChevronDown className={`activity-summary-toggle ${expanded ? "expanded" : ""}`} size={14} />
      </button>
      {expanded && (
        <div className="activity-details">
          {activities.map((activity) => (
            <ActivityDetailRow
              activeWorkspaceAppId={activeWorkspaceAppId}
              activity={activity}
              connection={connection}
              key={activity.id}
              onOpenImage={setOpenImage}
            />
          ))}
        </div>
      )}
      <ImageLightbox
        open={Boolean(openImageSrc)}
        src={openImageSrc}
        title={openImage?.path ?? ""}
        onClose={() => setOpenImage(null)}
      />
    </article>
  );
}

function ActivityDetailRow({
  activeWorkspaceAppId,
  activity,
  connection,
  onOpenImage,
}: {
  activeWorkspaceAppId: string | null;
  activity: ActivityItem;
  connection: ClientConnection | null;
  onOpenImage: (image: ActivityItem["imagePreview"] | null) => void;
}) {
  const imageSrc = useActivityImageUrl(activity.imagePreview ?? null, connection, activeWorkspaceAppId);
  return (
    <div
      className={`activity-detail-row ${activity.controlKind === "turn_aborted" ? "danger" : ""}`}
      key={activity.id}
    >
      <span>{activity.label}</span>
      <div className="activity-detail-main">
        {activity.content && (
          activity.kind === "command" ? (
            <ShellCommandCode className="activity-detail-command" command={activity.content} />
          ) : isMultilineActivity(activity.content) ? (
            <pre className="activity-detail-output">{activity.content}</pre>
          ) : (
            <code>{activity.content}</code>
          )
        )}
        {activity.detail && (
          <pre className="activity-detail-output">{compactActivityOutput(activity.detail)}</pre>
        )}
        {activity.imagePreview && imageSrc && (
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
        )}
      </div>
    </div>
  );
}

function ActivitySummaryText({ summary }: { summary: string }) {
  return <span className="activity-summary-text">{summary}</span>;
}

function ShellCommandCode({ className, command }: { className: string; command: string }) {
  const display = summarizeShellCommand(command) ?? command;
  return (
    <code className={`${className} shell-command-code`} title={command}>
      {display === command ? highlightShellCommand(command) : display}
    </code>
  );
}

function highlightShellCommand(command: string) {
  return tokenizeShellCommand(command).map((token, index) => (
    <span className={`shell-token ${token.kind}`} key={`${index}-${token.text}`}>
      {token.text}
    </span>
  ));
}

function compactActivityOutput(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trimEnd();
  const lines = normalized.split("\n");
  if (lines.length <= COMMAND_OUTPUT_VISIBLE_LINES) return normalized;
  const omitted = lines.length - COMMAND_OUTPUT_VISIBLE_LINES;
  return `${lines.slice(0, COMMAND_OUTPUT_VISIBLE_LINES).join("\n")}\n... ${omitted} ${omitted === 1 ? "line" : "lines"} omitted`;
}

type ShellToken = {
  kind: "plain" | "command" | "flag" | "string" | "operator" | "variable" | "path";
  text: string;
};

function tokenizeShellCommand(command: string): ShellToken[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|&&|\|\||[|;&()<>]|\s+|[^\s|;&()<>]+/g) ?? [command];
  let expectsCommand = true;
  return tokens.map((text) => {
    if (/^\s+$/.test(text)) return { kind: "plain", text };
    if (/^(?:&&|\|\||[|;&()<>])$/.test(text)) {
      expectsCommand = text !== ")" && text !== ">";
      return { kind: "operator", text };
    }
    if (/^(['"]).*\1$/.test(text)) return { kind: "string", text };
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(text)) return { kind: "variable", text };
    if (expectsCommand) {
      expectsCommand = false;
      return { kind: "command", text };
    }
    if (/^-{1,2}[\w-]/.test(text)) return { kind: "flag", text };
    if (/^(?:\.{0,2}\/|~\/|[\w.-]+\/)/.test(text)) return { kind: "path", text };
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
  return <img aria-hidden className="activity-summary-image" decoding="async" loading="lazy" src={src} alt="" />;
}

function ActivitySummaryIcon({ kind }: { kind: ActivityGroupSummaryKind }) {
  const Icon = activitySummaryIcon(kind);
  return <Icon aria-hidden className={`activity-summary-kind-icon ${kind}`} size={14} />;
}

function activitySummaryIcon(kind: ActivityGroupSummaryKind): LucideIcon {
  if (kind === "approval" || kind === "control") return CircleAlert;
  if (kind === "edit") return SquarePen;
  if (kind === "image") return ImageIcon;
  if (kind === "list") return ListFilter;
  if (kind === "read") return FileText;
  if (kind === "search") return Search;
  if (kind === "web") return Globe2;
  return SquareTerminal;
}

function useActivityImageUrl(
  image: ActivityItem["imagePreview"] | null,
  connection: ClientConnection | null,
  activeWorkspaceAppId: string | null,
): string | null {
  const localPath = image && isAbsoluteLocalImagePath(image.path) ? image.path : null;
  const appId = image?.appId ?? activeWorkspaceAppId;
  const localUrl = useLocalImageUrl(connection, localPath);
  const workspaceUrl = useWorkspaceImageUrl(connection, localPath ? null : appId, localPath ? null : image?.path);
  return localPath ? localUrl : workspaceUrl;
}

function isAbsoluteLocalImagePath(path: string): boolean {
  return /^file:\/\//i.test(path) || /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

function isMultilineActivity(value: string): boolean {
  return value.includes("\n") || value.length > 160;
}
