import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promises as fs } from "node:fs";
import { artifactReference, publishManagedArtifact } from "@openpond/persistence";
import {
  CHAT_ATTACHMENT_LIMITS,
  ChatAttachmentSummarySchema,
  countTextLines,
  type ChatAttachmentSummary,
  type RuntimeEvent,
} from "@openpond/contracts";
import {
  CHAT_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES,
  chatAttachmentImageContentType,
  chatAttachmentTextPreviewSupported,
  safeChatAttachmentPathSegment,
} from "./chat-attachments.js";

export type CodexNativeFileMention = {
  label: string;
  localPath: string;
};

export type CodexImageReference = {
  label: string | null;
  localPath: string | null;
};

const NATIVE_FILE_MENTION_INLINE_PATTERN =
  /^[ \t]*##[ \t]+(.+?):[ \t]+((?:\/|[A-Za-z]:[\\/])[^\r\n]+)[ \t]*$/gm;
const NATIVE_FILE_MENTION_MULTILINE_PATTERN =
  /^[ \t]*##[ \t]+(.+?):[ \t]*\r?\n[ \t]*((?:\/|[A-Za-z]:[\\/])[^\r\n]+)[ \t]*$/gm;
const NATIVE_FILE_MEDIA_TYPES = new Map<string, string>([
  [".csv", "text/csv"],
  [".html", "text/html"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
]);

export function codexNativeFileMentions(
  text: string,
  codexHome: string,
): CodexNativeFileMention[] {
  const filesHeader = /^\s*# Files mentioned by the user:\s*$/im.exec(text);
  if (!filesHeader) return [];
  const afterHeader = text.slice(filesHeader.index + filesHeader[0].length);
  const requestHeader = /^\s*## My request(?: for Codex)?:\s*$/im.exec(afterHeader);
  if (!requestHeader) return [];
  const mentions: CodexNativeFileMention[] = [];
  const seenPaths = new Set<string>();
  const mentionBlock = afterHeader.slice(0, requestHeader.index);
  const attachmentRoot = path.resolve(codexHome, "attachments");
  for (const pattern of [
    NATIVE_FILE_MENTION_INLINE_PATTERN,
    NATIVE_FILE_MENTION_MULTILINE_PATTERN,
  ]) {
    for (const match of mentionBlock.matchAll(pattern)) {
      const label = match?.[1]?.trim();
      const localPath = match?.[2]?.trim();
      if (!label || !localPath) continue;
      const target = path.resolve(localPath);
      if (!target.startsWith(`${attachmentRoot}${path.sep}`)) continue;
      if (seenPaths.has(target)) continue;
      seenPaths.add(target);
      mentions.push({ label, localPath: target });
    }
  }
  return mentions;
}

/** Finish importing before returning preview refs to the HTTP media endpoint. */
export async function publishCodexHistoryAttachments(input: {
  storageHome: string;
  attachmentRootDir: string;
  events: RuntimeEvent[];
}): Promise<void> {
  for (const event of input.events) {
    if (event.name !== "turn.started" || !Array.isArray(event.args?.attachments)) continue;
    const summaries = event.args.attachments;
    for (const [index, value] of summaries.entries()) {
      const parsed = ChatAttachmentSummarySchema.safeParse(value);
      if (!parsed.success) continue;
      const attachment = parsed.data;
      const preview = attachment.imagePreview ?? attachment.filePreview;
      if (!preview) continue;
      const unavailable = () => {
        delete attachment.imagePreview;
        delete attachment.filePreview;
        summaries[index] = attachment;
      };
      if (preview.sessionId !== event.sessionId) { unavailable(); continue; }
      const owner = { domain: "chat_attachment" as const,
        id: JSON.stringify([preview.sessionId, preview.turnId, preview.storageName]) };
      if (artifactReference(input.storageHome, owner)) continue;
      const turnDir = path.resolve(input.attachmentRootDir, safeChatAttachmentPathSegment(preview.sessionId), safeChatAttachmentPathSegment(preview.turnId));
      const sourceFile = path.resolve(turnDir, preview.storageName);
      if (!sourceFile.startsWith(`${turnDir}${path.sep}`)) { unavailable(); continue; }
      // Imported files must be ordinary files under the attachment root; never
      // follow a substituted symlink when publishing a durable reference.
      const source = await Promise.all([
        fs.lstat(sourceFile), fs.realpath(sourceFile), fs.realpath(input.attachmentRootDir),
      ]).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!source) { unavailable(); continue; }
      const [stat, realSource, realRoot] = source;
      if (!stat.isFile() || realSource !== path.join(realRoot, path.relative(path.resolve(input.attachmentRootDir), sourceFile))
        || stat.size > CHAT_ATTACHMENT_LIMITS.maxAttachmentBytes) { unavailable(); continue; }
      await publishManagedArtifact(input.storageHome, { owner, sourceFile, displayName: attachment.name, mediaType: attachment.mediaType });
    }
  }
}

export function mergeCodexNativeImageReferences(
  taggedReferences: CodexImageReference[],
  nativeFileMentions: CodexNativeFileMention[],
): CodexImageReference[] {
  const taggedPaths = new Set(
    taggedReferences
      .map((reference) => reference.localPath)
      .filter((localPath): localPath is string => Boolean(localPath))
      .map((localPath) => path.resolve(localPath)),
  );
  return [
    ...taggedReferences,
    ...nativeFileMentions
      .filter(
        (mention) =>
          Boolean(chatAttachmentImageContentType("", mention.localPath)) &&
          !taggedPaths.has(mention.localPath),
      )
      .map((mention) => ({
        label: mention.label,
        localPath: mention.localPath,
      })),
  ];
}

export function codexNativeFileAttachments(input: {
  attachmentRootDir?: string;
  mentions: CodexNativeFileMention[];
  offset: number;
  sessionId: string;
  turnId: string;
}): ChatAttachmentSummary[] {
  const attachments: ChatAttachmentSummary[] = [];
  for (const [index, mention] of input.mentions.entries()) {
    if (chatAttachmentImageContentType("", mention.localPath)) continue;
    let sizeBytes: number;
    try {
      const stat = lstatSync(mention.localPath);
      if (
        !stat.isFile() ||
        stat.size > CHAT_ATTACHMENT_LIMITS.maxAttachmentBytes
      )
        continue;
      sizeBytes = stat.size;
    } catch {
      continue;
    }
    const mediaType = nativeFileMediaType(mention.localPath);
    const kind = chatAttachmentTextPreviewSupported(
      mediaType,
      mention.localPath,
    )
      ? "text"
      : "file";
    const id = `${input.turnId}_native_file_${input.offset + index + 1}`;
    const name = mention.label.slice(0, 240);
    const summary: ChatAttachmentSummary = {
      id,
      name,
      mediaType,
      sizeBytes,
      kind,
    };
    if (
      kind !== "text" ||
      !input.attachmentRootDir ||
      sizeBytes > CHAT_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES
    ) {
      attachments.push(summary);
      continue;
    }
    const storageName = nativeFileStorageName(id, mention.localPath);
    const turnDir = path.join(
      input.attachmentRootDir,
      safeChatAttachmentPathSegment(input.sessionId),
      safeChatAttachmentPathSegment(input.turnId),
    );
    const target = path.join(turnDir, storageName);
    try {
      const bytes = readFileSync(mention.localPath);
      mkdirSync(turnDir, { recursive: true });
      if (!existsSync(target)) writeFileSync(target, bytes, { mode: 0o600 });
      attachments.push({
        ...summary,
        lineCount: countTextLines(bytes.toString("utf8")),
        filePreview: {
          sessionId: input.sessionId,
          turnId: input.turnId,
          attachmentId: id,
          storageName,
          contentType: mediaType,
        },
      });
    } catch {
      attachments.push(summary);
    }
  }
  return attachments;
}

function nativeFileMediaType(localPath: string): string {
  return (
    NATIVE_FILE_MEDIA_TYPES.get(path.extname(localPath).toLowerCase()) ??
    "application/octet-stream"
  );
}

function nativeFileStorageName(attachmentId: string, localPath: string): string {
  const fileName =
    path
      .basename(localPath)
      .replace(/[^a-zA-Z0-9._ -]+/g, "-")
      .trim() || "attachment";
  const safeId = attachmentId.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `${safeId}-${fileName}`;
}

export function codexHistoryTextAttachmentMetadata(input: {
  attachmentId: string;
  attachmentRootDir?: string;
  localPath?: string;
  mediaType: string;
  name: string;
  sessionId: string;
  sizeBytes: number;
}): Pick<ChatAttachmentSummary, "filePreview" | "lineCount"> {
  if (
    !input.localPath ||
    !input.attachmentRootDir ||
    !chatAttachmentTextPreviewSupported(input.mediaType, input.name)
  ) {
    return {};
  }
  const target = path.resolve(input.localPath);
  const sessionDir = path.resolve(
    input.attachmentRootDir,
    safeChatAttachmentPathSegment(input.sessionId),
  );
  if (!target.startsWith(`${sessionDir}${path.sep}`)) return {};
  const [storedTurnId, ...storageParts] = path
    .relative(sessionDir, target)
    .replaceAll("\\", "/")
    .split("/");
  const storageName = storageParts.join("/");
  if (!storedTurnId || !storageName) return {};
  try {
    const stat = statSync(target);
    if (
      !stat.isFile() ||
      stat.size > CHAT_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES ||
      !attachmentSizeMatchesRecordedValue(stat.size, input.sizeBytes)
    ) {
      return {};
    }
    return {
      filePreview: {
        sessionId: input.sessionId,
        turnId: storedTurnId,
        attachmentId: input.attachmentId,
        storageName,
        contentType: input.mediaType,
      },
      lineCount: countTextLines(readFileSync(target, "utf8")),
    };
  } catch {
    return {};
  }
}

function attachmentSizeMatchesRecordedValue(
  actualBytes: number,
  recordedBytes: number,
): boolean {
  const roundingTolerance =
    recordedBytes < 1_024
      ? 0
      : recordedBytes < 10 * 1_024
        ? 52
        : recordedBytes < 1_024 * 1_024
          ? 512
          : recordedBytes < 10 * 1_024 * 1_024
            ? 52_429
            : 524_288;
  return Math.abs(actualBytes - recordedBytes) <= roundingTolerance;
}
