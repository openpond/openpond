import type { FileOutputRef } from "@openpond/contracts";

export type OutputFileType =
  | "audio"
  | "document"
  | "file"
  | "html"
  | "image"
  | "pdf"
  | "presentation"
  | "table"
  | "text"
  | "video";

export type OutputFilePresentation = {
  label: string;
  type: OutputFileType;
};

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function outputFilePresentation(
  output: Pick<FileOutputRef, "contentType" | "title">
): OutputFilePresentation {
  const contentType = output.contentType.toLowerCase();
  const title = output.title.toLowerCase();
  if (contentType === DOCX_CONTENT_TYPE || title.endsWith(".docx")) {
    return { label: "Document", type: "document" };
  }
  if (contentType === "application/pdf" || title.endsWith(".pdf")) {
    return { label: "PDF", type: "pdf" };
  }
  if (contentType === PPTX_CONTENT_TYPE || title.endsWith(".pptx")) {
    return { label: "Presentation", type: "presentation" };
  }
  if (
    contentType === XLSX_CONTENT_TYPE ||
    contentType === "text/csv" ||
    contentType === "text/tab-separated-values" ||
    title.endsWith(".xlsx") ||
    title.endsWith(".csv") ||
    title.endsWith(".tsv")
  ) {
    return { label: "Table", type: "table" };
  }
  if (contentType === "text/html" || title.endsWith(".html")) {
    return { label: "HTML", type: "html" };
  }
  if (
    contentType === "application/json" ||
    contentType === "text/markdown" ||
    contentType === "text/plain"
  ) {
    return { label: "Text", type: "text" };
  }
  if (contentType.startsWith("image/")) {
    return { label: "Image", type: "image" };
  }
  if (contentType.startsWith("audio/")) {
    return { label: "Audio", type: "audio" };
  }
  if (contentType.startsWith("video/")) {
    return { label: "Video", type: "video" };
  }
  return { label: "File", type: "file" };
}

export function sortOutputFilesNewestFirst(
  outputs: FileOutputRef[]
): FileOutputRef[] {
  return [...outputs].sort(
    (left, right) =>
      outputTimestamp(right.createdAt) - outputTimestamp(left.createdAt) ||
      right.revision - left.revision
  );
}

function outputTimestamp(createdAt: string): number {
  const timestamp = new Date(createdAt).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
