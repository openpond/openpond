import { publishManagedArtifact, withManagedArtifact, atomicWriteFile } from "@openpond/persistence";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ChatAttachment,
  ChatAttachmentSummary,
} from "@openpond/contracts";
import { countTextLines } from "@openpond/contracts";

const ATTACHMENT_CONTEXT_TEXT_LIMIT = 120_000;
const MAX_CHAT_ATTACHMENT_IMAGE_BYTES = 15 * 1024 * 1024;
export const CHAT_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const CHAT_ATTACHMENT_IMAGE_CONTENT_TYPES = new Map<string, string>([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const CHAT_ATTACHMENT_IMAGE_MEDIA_TYPES = new Set(
  CHAT_ATTACHMENT_IMAGE_CONTENT_TYPES.values()
);
const CHAT_ATTACHMENT_TEXT_CONTENT_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-sh",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
]);
const CHAT_ATTACHMENT_TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mdx",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export type ChatAttachmentContextItem = ChatAttachmentSummary & {
  localPath?: string;
  storageName?: string;
  text?: string;
};

export type ChatAttachmentImageFile = {
  path: string;
  contentType: string;
  bytes: Buffer;
  sizeBytes: number;
};

export type ChatAttachmentTextFile = {
  path: string;
  contentType: string;
  content: string;
  sizeBytes: number;
};

export async function materializeChatAttachments(input: {
  storageHome: string;
  attachmentRootDir: string;
  sessionId: string;
  turnId: string;
  attachments?: ChatAttachment[];
}): Promise<ChatAttachmentContextItem[]> {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) return [];

  const turnDir = path.join(
    input.attachmentRootDir,
    safeChatAttachmentPathSegment(input.sessionId),
    safeChatAttachmentPathSegment(input.turnId)
  );
  const usedNames = new Set<string>();
  const contexts: ChatAttachmentContextItem[] = [];

  for (const [index, attachment] of attachments.entries()) {
    const summary = chatAttachmentSummary(attachment);
    const context: ChatAttachmentContextItem = {
      ...summary,
      ...(attachment.text ? { text: attachment.text } : {}),
    };

    if (attachment.contentsBase64) {
      await fs.mkdir(turnDir, { recursive: true });
      const safeName = uniqueSafeFileName(
        attachment.relativePath || attachment.name,
        usedNames,
        index + 1
      );
      const localPath = path.join(turnDir, safeName);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      const bytes = Buffer.from(attachment.contentsBase64, "base64");
      const artifact = await publishManagedArtifact(input.storageHome, {
        owner: { domain: "chat_attachment", id: JSON.stringify([input.sessionId, input.turnId, safeName]) },
        displayName: attachment.name, mediaType: attachment.mediaType, bytes,
      });
      await atomicWriteFile(localPath, bytes);
      context.localPath = artifact.path;
      context.storageName = safeName;
    }

    contexts.push(context);
  }

  return contexts;
}

export function chatAttachmentSummaries(
  attachments?: ChatAttachment[],
  previewContext?: {
    sessionId: string;
    turnId: string;
    materialized: ChatAttachmentContextItem[];
  }
): ChatAttachmentSummary[] {
  const materializedById = new Map(
    previewContext?.materialized.map((item) => [item.id, item]) ?? []
  );
  return (attachments ?? []).map((attachment) => {
    const summary = chatAttachmentSummary(attachment);
    const materialized = materializedById.get(attachment.id);
    const previewContentType = chatAttachmentImageContentType(
      attachment.mediaType,
      materialized?.storageName ?? attachment.name
    );
    if (
      previewContext &&
      summary.kind === "image" &&
      materialized?.localPath &&
      materialized.storageName &&
      previewContentType
    ) {
      return {
        ...summary,
        imagePreview: {
          sessionId: previewContext.sessionId,
          turnId: previewContext.turnId,
          attachmentId: attachment.id,
          storageName: materialized.storageName,
          contentType: previewContentType,
        },
      };
    }
    return previewContext &&
      materialized?.localPath &&
      materialized.storageName &&
      attachment.sizeBytes <= CHAT_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES &&
      chatAttachmentTextPreviewSupported(
        attachment.mediaType,
        materialized.storageName
      )
      ? {
          ...summary,
          filePreview: {
            sessionId: previewContext.sessionId,
            turnId: previewContext.turnId,
            attachmentId: attachment.id,
            storageName: materialized.storageName,
            contentType: attachment.mediaType,
          },
        }
      : summary;
  });
}

export function chatAttachmentContext(
  attachments?: ChatAttachmentContextItem[]
): string {
  if (!attachments || attachments.length === 0) return "";

  const lines = [
    "<attachments>",
    `The user attached ${attachments.length} file${
      attachments.length === 1 ? "" : "s"
    } with this message.`,
  ];
  let remainingTextChars = ATTACHMENT_CONTEXT_TEXT_LIMIT;

  for (const [index, attachment] of attachments.entries()) {
    const location = attachment.localPath
      ? ` Saved locally at: ${attachment.localPath}`
      : "";
    lines.push(
      `${index + 1}. ${attachment.name} (${attachment.mediaType}, ${formatBytes(
        attachment.sizeBytes
      )}, ${attachment.kind}).${location}`
    );

    const text = attachment.text?.trim();
    if (text && remainingTextChars > 0) {
      const value =
        text.length > remainingTextChars
          ? `${text.slice(
              0,
              Math.max(0, remainingTextChars - 34)
            )}\n[attachment text truncated]`
          : text;
      lines.push("Text content:");
      lines.push("~~~text");
      lines.push(value);
      lines.push("~~~");
      remainingTextChars -= value.length;
    }
  }

  lines.push("</attachments>");
  return lines.join("\n");
}

export function formatPromptWithAttachmentContext(
  prompt: string,
  attachmentContext: string
): string {
  const trimmedPrompt = prompt.trim() || "Please review the attached files.";
  const trimmedContext = attachmentContext.trim();
  return trimmedContext
    ? `${trimmedPrompt}\n\n${trimmedContext}`
    : trimmedPrompt;
}

function chatAttachmentSummary(
  attachment: ChatAttachment
): ChatAttachmentSummary {
  const lineCount =
    attachment.lineCount ??
    (attachment.text !== undefined ? countTextLines(attachment.text) : undefined);
  return {
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    ...(lineCount !== undefined ? { lineCount } : {}),
    ...(attachment.relativePath
      ? { relativePath: attachment.relativePath }
      : {}),
  };
}

export async function readChatAttachmentImageFile(input: {
  storageHome: string;
  attachmentRootDir: string;
  sessionId: string;
  turnId: string;
  storageName: string;
  contentType: string;
}): Promise<ChatAttachmentImageFile | null> {
  const sessionSegment = safeChatAttachmentPathSegment(input.sessionId);
  const turnSegment = safeChatAttachmentPathSegment(input.turnId);
  const storageName = cleanStorageName(input.storageName);
  const contentType = chatAttachmentImageContentType(
    input.contentType,
    storageName ?? ""
  );
  if (!storageName || !contentType) return null;

  const turnDir = path.resolve(
    input.attachmentRootDir,
    sessionSegment,
    turnSegment
  );
  const target = path.resolve(turnDir, storageName);
  if (target !== turnDir && !target.startsWith(`${turnDir}${path.sep}`))
    return null;

  return withManagedArtifact(input.storageHome, { domain: "chat_attachment", id: JSON.stringify([input.sessionId, input.turnId, storageName]) }, async (file, reference) => {
    if (reference.sizeBytes > MAX_CHAT_ATTACHMENT_IMAGE_BYTES) return null;
    return { path: storageName, contentType, bytes: await fs.readFile(file), sizeBytes: reference.sizeBytes };
  });
}

export async function readChatAttachmentTextFile(input: {
  storageHome: string;
  attachmentRootDir: string;
  sessionId: string;
  turnId: string;
  storageName: string;
  contentType: string;
}): Promise<ChatAttachmentTextFile | null> {
  const target = chatAttachmentStoredFilePath(input);
  if (
    !target ||
    !chatAttachmentTextPreviewSupported(input.contentType, input.storageName)
  )
    return null;

  return withManagedArtifact(input.storageHome, { domain: "chat_attachment", id: JSON.stringify([input.sessionId, input.turnId, target.storageName]) }, async (file, reference) => {
    if (reference.sizeBytes > CHAT_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES) return null;
    return { path: target.storageName, contentType: input.contentType, content: await fs.readFile(file, "utf8"), sizeBytes: reference.sizeBytes };
  });
}

export function chatAttachmentImageContentType(
  mediaType: string,
  fileName: string
): string | null {
  const normalizedMediaType =
    mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (CHAT_ATTACHMENT_IMAGE_MEDIA_TYPES.has(normalizedMediaType))
    return normalizedMediaType;
  return (
    CHAT_ATTACHMENT_IMAGE_CONTENT_TYPES.get(
      path.extname(fileName).toLowerCase()
    ) ?? null
  );
}

export function safeChatAttachmentPathSegment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

function cleanStorageName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed))
    return null;
  return path.basename(trimmed);
}

function chatAttachmentStoredFilePath(input: {
  attachmentRootDir: string;
  sessionId: string;
  turnId: string;
  storageName: string;
}): { absolutePath: string; storageName: string } | null {
  const storageName = cleanStoragePath(input.storageName);
  if (!storageName) return null;
  const turnDir = path.resolve(
    input.attachmentRootDir,
    safeChatAttachmentPathSegment(input.sessionId),
    safeChatAttachmentPathSegment(input.turnId)
  );
  const absolutePath = path.resolve(turnDir, storageName);
  if (!absolutePath.startsWith(`${turnDir}${path.sep}`)) return null;
  return { absolutePath, storageName };
}

function cleanStoragePath(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    return null;
  return parts.join("/");
}

export function chatAttachmentTextPreviewSupported(
  contentType: string,
  fileName: string
): boolean {
  const normalizedType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalizedType.startsWith("text/")) return true;
  if (CHAT_ATTACHMENT_TEXT_CONTENT_TYPES.has(normalizedType)) return true;
  return CHAT_ATTACHMENT_TEXT_EXTENSIONS.has(
    path.extname(fileName).toLowerCase()
  );
}

function uniqueSafeFileName(
  name: string,
  usedNames: Set<string>,
  fallbackIndex: number
): string {
  const normalized = name
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => part.replace(/[^a-zA-Z0-9._ -]+/g, "-").trim())
    .filter(Boolean)
    .join("/");
  const safeName = normalized || `attachment-${fallbackIndex}`;
  let candidate = safeName;
  let index = 2;
  while (usedNames.has(candidate)) {
    const extension = path.extname(safeName);
    const base = extension ? safeName.slice(0, -extension.length) : safeName;
    candidate = `${base}-${index}${extension}`;
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let amount = value / 1024;
  for (const unit of units) {
    if (amount < 1024) return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
    amount /= 1024;
  }
  return `${amount.toFixed(0)} TB`;
}
