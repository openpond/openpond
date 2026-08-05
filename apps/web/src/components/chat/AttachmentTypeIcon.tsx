import type { ChatAttachmentSummary } from "@openpond/contracts";
import type { ComponentProps } from "react";
import {
  Archive,
  Code2,
  File,
  FileAudio,
  FileSpreadsheet,
  FileText,
  FileVideo,
  ImageIcon,
  Presentation,
} from "../icons";

const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "css",
  "go",
  "h",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "mdx",
  "php",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "toml",
  "ts",
  "tsx",
  "xml",
  "yaml",
  "yml",
]);
const SPREADSHEET_EXTENSIONS = new Set([
  "csv",
  "ods",
  "tsv",
  "xls",
  "xlsm",
  "xlsx",
]);
const ARCHIVE_EXTENSIONS = new Set([
  "7z",
  "bz2",
  "gz",
  "rar",
  "tar",
  "tgz",
  "xz",
  "zip",
]);
const DOCUMENT_EXTENSIONS = new Set([
  "doc",
  "docx",
  "epub",
  "md",
  "odt",
  "pdf",
  "rtf",
  "txt",
]);
const PRESENTATION_EXTENSIONS = new Set(["key", "odp", "ppt", "pptx"]);

export type AttachmentIconKind =
  | "archive"
  | "audio"
  | "code"
  | "document"
  | "file"
  | "image"
  | "presentation"
  | "spreadsheet"
  | "video";

export function attachmentIconKind(
  attachment: Pick<ChatAttachmentSummary, "kind" | "mediaType" | "name">,
): AttachmentIconKind {
  const mediaType = attachment.mediaType.toLowerCase();
  const extension = attachment.name.split(".").pop()?.toLowerCase() ?? "";
  if (attachment.kind === "image" || mediaType.startsWith("image/"))
    return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (
    SPREADSHEET_EXTENSIONS.has(extension) ||
    mediaType.includes("spreadsheet") ||
    mediaType.includes("excel")
  )
    return "spreadsheet";
  if (
    ARCHIVE_EXTENSIONS.has(extension) ||
    mediaType.includes("zip") ||
    mediaType.includes("compressed")
  )
    return "archive";
  if (
    PRESENTATION_EXTENSIONS.has(extension) ||
    mediaType.includes("presentation") ||
    mediaType.includes("powerpoint")
  )
    return "presentation";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (
    attachment.kind === "text" ||
    DOCUMENT_EXTENSIONS.has(extension) ||
    mediaType.startsWith("text/") ||
    mediaType === "application/pdf" ||
    mediaType.includes("document") ||
    mediaType.includes("msword")
  )
    return "document";
  return "file";
}

export function attachmentTypeLabel(
  attachment: Pick<ChatAttachmentSummary, "kind" | "mediaType" | "name">,
): string {
  if (attachment.mediaType.toLowerCase() === "application/pdf") return "PDF";
  const kind = attachmentIconKind(attachment);
  return kind === "spreadsheet"
    ? "Spreadsheet"
    : kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function formatAttachmentLineCount(value: number): string {
  return `${value.toLocaleString()} ${value === 1 ? "line" : "lines"}`;
}

const ICONS = {
  archive: Archive,
  audio: FileAudio,
  code: Code2,
  document: FileText,
  file: File,
  image: ImageIcon,
  presentation: Presentation,
  spreadsheet: FileSpreadsheet,
  video: FileVideo,
} as const;

export function AttachmentTypeIcon({
  attachment,
  ...props
}: {
  attachment: Pick<ChatAttachmentSummary, "kind" | "mediaType" | "name">;
} & ComponentProps<typeof File>) {
  const Icon = ICONS[attachmentIconKind(attachment)];
  return <Icon {...props} />;
}
