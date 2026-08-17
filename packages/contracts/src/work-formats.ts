export type WorkFormatFamily =
  | "document"
  | "code"
  | "spreadsheet"
  | "presentation"
  | "pdf"
  | "data"
  | "image"
  | "audio"
  | "video"
  | "site";

export type WorkPreviewMode =
  | "markdown"
  | "text"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "native_app"
  | "browser";

export type WorkValidationMode =
  | "structural"
  | "visual"
  | "playback"
  | "browser";

export type WorkFormatCapability = {
  family: WorkFormatFamily;
  extensions: readonly string[];
  contentTypes: readonly string[];
  preview: WorkPreviewMode;
  validation: readonly WorkValidationMode[];
  creation: "built_in" | "node_package" | "connected_provider";
};

export const WORK_FORMAT_CAPABILITIES = [
  {
    family: "document",
    extensions: [".md", ".txt"],
    contentTypes: ["text/markdown", "text/plain"],
    preview: "markdown",
    validation: ["structural"],
    creation: "built_in",
  },
  {
    family: "code",
    extensions: [
      ".css",
      ".js",
      ".jsx",
      ".mjs",
      ".py",
      ".sql",
      ".ts",
      ".tsx",
      ".yaml",
      ".yml",
    ],
    contentTypes: [
      "application/javascript",
      "application/sql",
      "application/yaml",
      "text/css",
      "text/javascript",
      "text/typescript",
      "text/yaml",
    ],
    preview: "text",
    validation: ["structural"],
    creation: "built_in",
  },
  {
    family: "document",
    extensions: [".docx"],
    contentTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    preview: "native_app",
    validation: ["structural", "visual"],
    creation: "node_package",
  },
  {
    family: "spreadsheet",
    extensions: [".xlsx"],
    contentTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    preview: "native_app",
    validation: ["structural", "visual"],
    creation: "node_package",
  },
  {
    family: "presentation",
    extensions: [".pptx"],
    contentTypes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    preview: "native_app",
    validation: ["structural", "visual"],
    creation: "node_package",
  },
  {
    family: "pdf",
    extensions: [".pdf"],
    contentTypes: ["application/pdf"],
    preview: "pdf",
    validation: ["structural", "visual"],
    creation: "node_package",
  },
  {
    family: "data",
    extensions: [".csv", ".tsv", ".json"],
    contentTypes: ["text/csv", "text/tab-separated-values", "application/json"],
    preview: "text",
    validation: ["structural"],
    creation: "built_in",
  },
  {
    family: "image",
    extensions: [".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"],
    contentTypes: [
      "image/avif",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/svg+xml",
      "image/webp",
    ],
    preview: "image",
    validation: ["structural", "visual"],
    creation: "node_package",
  },
  {
    family: "audio",
    extensions: [".m4a", ".mp3", ".wav"],
    contentTypes: ["audio/mp4", "audio/mpeg", "audio/wav"],
    preview: "audio",
    validation: ["structural", "playback"],
    creation: "node_package",
  },
  {
    family: "video",
    extensions: [".mov", ".mp4", ".webm"],
    contentTypes: ["video/quicktime", "video/mp4", "video/webm"],
    preview: "video",
    validation: ["structural", "playback"],
    creation: "node_package",
  },
  {
    family: "site",
    extensions: [".html"],
    contentTypes: ["text/html"],
    preview: "browser",
    validation: ["structural", "browser"],
    creation: "built_in",
  },
] as const satisfies readonly WorkFormatCapability[];

export const WORK_OUTPUT_CONTENT_TYPES: Readonly<Record<string, string>> =
  Object.freeze({
    ".avif": "image/avif",
    ".csv": "text/csv",
    ".css": "text/css",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".gif": "image/gif",
    ".html": "text/html",
    ".js": "text/javascript",
    ".jsx": "text/javascript",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".m4a": "audio/mp4",
    ".md": "text/markdown",
    ".mjs": "text/javascript",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".py": "text/plain",
    ".svg": "image/svg+xml",
    ".sql": "application/sql",
    ".tsv": "text/tab-separated-values",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".txt": "text/plain",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
  });

export function workFormatCapabilityForContentType(
  contentType: string
): WorkFormatCapability | null {
  return (
    WORK_FORMAT_CAPABILITIES.find((capability) =>
      capability.contentTypes.includes(contentType as never)
    ) ?? null
  );
}

export function workOutputMediaTypesCompatible(
  expectedContentType: string,
  actualContentType: string
): boolean {
  if (expectedContentType === actualContentType) return true;
  if (expectedContentType !== "text/plain") return false;
  return workFormatCapabilityForContentType(actualContentType)?.family === "code";
}
