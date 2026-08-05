import type { ChatAttachment } from "@openpond/contracts";
import { CHAT_ATTACHMENT_LIMITS } from "@openpond/contracts";
import { FileText, ImageIcon, Paperclip, X } from "../icons";

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "csv",
  "css",
  "html",
  "js",
  "json",
  "jsx",
  "log",
  "md",
  "mdx",
  "py",
  "sql",
  "svg",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

export const COMPOSER_PASTED_TEXT_MIN_CHARS = 2_000;
const PASTED_TEXT_ATTACHMENT_NAME_PATTERN = /^Pasted text(?: (\d+))?\.txt$/;

export type ComposerAttachmentDraft = {
  id: string;
  file: File;
  name: string;
  mediaType: string;
  sizeBytes: number;
  kind: ChatAttachment["kind"];
  relativePath?: string;
  previewUrl?: string;
};

export function createComposerPastedTextFile(
  text: string,
  existingAttachments: readonly Pick<ComposerAttachmentDraft, "name">[],
): File | null {
  if (text.length < COMPOSER_PASTED_TEXT_MIN_CHARS) return null;
  const usedPasteNumbers = new Set<number>();
  for (const attachment of existingAttachments) {
    const match = PASTED_TEXT_ATTACHMENT_NAME_PATTERN.exec(attachment.name);
    if (match) usedPasteNumbers.add(match[1] ? Number(match[1]) : 1);
  }
  let pasteNumber = 1;
  while (usedPasteNumbers.has(pasteNumber)) pasteNumber += 1;
  const name =
    pasteNumber === 1 ? "Pasted text.txt" : `Pasted text ${pasteNumber}.txt`;
  return new File([text], name, { type: "text/plain" });
}

export function ComposerAttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachmentDraft;
  onRemove: () => void;
}) {
  const Icon =
    attachment.kind === "image"
      ? ImageIcon
      : attachment.kind === "text"
      ? FileText
      : Paperclip;
  const showMeta = attachment.kind !== "image";
  return (
    <div className={`composer-attachment-card ${attachment.kind}`}>
      <div className="composer-attachment-thumb" aria-hidden="true">
        {attachment.previewUrl ? (
          <img alt="" decoding="async" src={attachment.previewUrl} />
        ) : (
          <Icon size={22} />
        )}
      </div>
      {showMeta ? (
        <div className="composer-attachment-meta">
          <strong>{attachment.name}</strong>
          <span>{formatBytes(attachment.sizeBytes)}</span>
        </div>
      ) : null}
      <button
        type="button"
        className="composer-attachment-remove"
        aria-label={`Remove ${attachment.name}`}
        onClick={onRemove}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function createAttachmentId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function composerAttachmentKind(file: File): ChatAttachment["kind"] {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("text/")) return "text";
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_ATTACHMENT_EXTENSIONS.has(extension) ? "text" : "file";
}

export async function readComposerAttachmentPayload(
  attachment: ComposerAttachmentDraft
): Promise<ChatAttachment> {
  const [contentsBase64, text] = await Promise.all([
    fileToBase64(attachment.file),
    attachment.kind === "text"
      ? fileToText(attachment.file)
      : Promise.resolve(undefined),
  ]);
  return {
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    ...(attachment.relativePath
      ? { relativePath: attachment.relativePath }
      : {}),
    contentsBase64,
    ...(text ? { text: trimAttachmentText(text) } : {}),
  };
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let amount = value / 1024;
  for (const unit of units) {
    if (amount < 1024) return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
    amount /= 1024;
  }
  return `${amount.toFixed(0)} TB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const [, base64 = ""] = result.split(",", 2);
      resolve(base64);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

function trimAttachmentText(value: string): string {
  if (value.length <= CHAT_ATTACHMENT_LIMITS.maxTextChars) return value;
  const suffix = "\n[attachment text truncated]";
  return `${value.slice(
    0,
    Math.max(0, CHAT_ATTACHMENT_LIMITS.maxTextChars - suffix.length)
  )}${suffix}`;
}
