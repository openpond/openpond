import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  countTextLines,
  type ChatAttachmentSummary,
} from "@openpond/contracts";
import {
  CHAT_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES,
  chatAttachmentTextPreviewSupported,
  safeChatAttachmentPathSegment,
} from "./chat-attachments.js";

export function codexHistoryTextAttachmentMetadata(input: {
  attachmentId: string;
  attachmentRootDir?: string;
  localPath?: string;
  mediaType: string;
  name: string;
  sessionId: string;
  turnId: string;
}): Pick<ChatAttachmentSummary, "filePreview" | "lineCount"> {
  if (
    !input.localPath ||
    !input.attachmentRootDir ||
    !chatAttachmentTextPreviewSupported(input.mediaType, input.name)
  ) {
    return {};
  }
  const target = path.resolve(input.localPath);
  const expectedDir = path.resolve(
    input.attachmentRootDir,
    safeChatAttachmentPathSegment(input.sessionId),
    safeChatAttachmentPathSegment(input.turnId),
  );
  if (!target.startsWith(`${expectedDir}${path.sep}`)) return {};
  const storageName = path.relative(expectedDir, target).replaceAll("\\", "/");
  try {
    const stat = statSync(target);
    if (!stat.isFile() || stat.size > CHAT_ATTACHMENT_TEXT_PREVIEW_MAX_BYTES) {
      return {};
    }
    return {
      filePreview: {
        sessionId: input.sessionId,
        turnId: input.turnId,
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
