import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatAttachment, ChatAttachmentSummary } from "@openpond/contracts";

const ATTACHMENT_CONTEXT_TEXT_LIMIT = 120_000;

export type ChatAttachmentContextItem = ChatAttachmentSummary & {
  localPath?: string;
  text?: string;
};

export async function materializeChatAttachments(input: {
  attachmentRootDir: string;
  sessionId: string;
  turnId: string;
  attachments?: ChatAttachment[];
}): Promise<ChatAttachmentContextItem[]> {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) return [];

  const turnDir = path.join(
    input.attachmentRootDir,
    safePathSegment(input.sessionId),
    safePathSegment(input.turnId),
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
      const safeName = uniqueSafeFileName(attachment.name, usedNames, index + 1);
      const localPath = path.join(turnDir, safeName);
      await fs.writeFile(localPath, Buffer.from(attachment.contentsBase64, "base64"), { mode: 0o600 });
      context.localPath = localPath;
    }

    contexts.push(context);
  }

  return contexts;
}

export function chatAttachmentSummaries(attachments?: ChatAttachment[]): ChatAttachmentSummary[] {
  return (attachments ?? []).map(chatAttachmentSummary);
}

export function chatAttachmentContext(attachments?: ChatAttachmentContextItem[]): string {
  if (!attachments || attachments.length === 0) return "";

  const lines = [
    "<attachments>",
    `The user attached ${attachments.length} file${attachments.length === 1 ? "" : "s"} with this message.`,
  ];
  let remainingTextChars = ATTACHMENT_CONTEXT_TEXT_LIMIT;

  for (const [index, attachment] of attachments.entries()) {
    const location = attachment.localPath ? ` Saved locally at: ${attachment.localPath}` : "";
    lines.push(
      `${index + 1}. ${attachment.name} (${attachment.mediaType}, ${formatBytes(attachment.sizeBytes)}, ${attachment.kind}).${location}`,
    );

    const text = attachment.text?.trim();
    if (text && remainingTextChars > 0) {
      const value =
        text.length > remainingTextChars
          ? `${text.slice(0, Math.max(0, remainingTextChars - 34))}\n[attachment text truncated]`
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

export function formatPromptWithAttachmentContext(prompt: string, attachmentContext: string): string {
  const trimmedPrompt = prompt.trim() || "Please review the attached files.";
  const trimmedContext = attachmentContext.trim();
  return trimmedContext ? `${trimmedPrompt}\n\n${trimmedContext}` : trimmedPrompt;
}

function chatAttachmentSummary(attachment: ChatAttachment): ChatAttachmentSummary {
  return {
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
  };
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item";
}

function uniqueSafeFileName(name: string, usedNames: Set<string>, fallbackIndex: number): string {
  const normalized = path.basename(name).replace(/[^a-zA-Z0-9._ -]+/g, "-").trim();
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
