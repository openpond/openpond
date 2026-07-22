import { promises as fs } from "node:fs";
import path from "node:path";
import type { OpenPondCommandRunResult } from "./command-access.js";

export type CommandArtifact = {
  artifactRef: string;
  path: string;
  title: string;
  contentType: string;
  sizeBytes: number;
  binary: true;
};

const ARTIFACT_CONTENT_TYPES = new Map<string, string>([
  [".avif", "image/avif"],
  [".csv", "text/csv"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".m4a", "audio/mp4"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".tsv", "text/tab-separated-values"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".zip", "application/zip"],
]);

const ARTIFACT_EXTENSION_PATTERN = [...ARTIFACT_CONTENT_TYPES.keys()]
  .map((extension) => extension.slice(1))
  .join("|");
const ABSOLUTE_ARTIFACT_PATTERN = new RegExp(
  `((?:/|[A-Za-z]:[\\\\/])[^\\n\\r\"'<>|]*?\\.(?:${ARTIFACT_EXTENSION_PATTERN}))(?=$|[\\s\"',;})\\]])`,
  "gi",
);
const RELATIVE_ARTIFACT_PATTERN = new RegExp(
  `(?:^|[\\s\"'=:])((?:\\.{0,2}[\\\\/])?[A-Za-z0-9_.-][^\\n\\r\"'<>|]*?\\.(?:${ARTIFACT_EXTENSION_PATTERN}))(?=$|[\\s\"',;})\\]])`,
  "gi",
);

export async function discoverCommandArtifacts(
  result: Pick<OpenPondCommandRunResult, "cwd" | "stdout" | "stderr">,
  limit = 12,
): Promise<CommandArtifact[]> {
  const candidates = new Set<string>();
  collectJsonPaths(result.stdout, candidates);
  collectTextPaths(result.stdout, candidates);

  const artifacts: CommandArtifact[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : result.cwd
        ? path.resolve(result.cwd, candidate)
        : null;
    if (!resolved || seen.has(resolved)) continue;
    const contentType = ARTIFACT_CONTENT_TYPES.get(path.extname(resolved).toLowerCase());
    if (!contentType) continue;
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) continue;
      seen.add(resolved);
      artifacts.push({
        artifactRef: resolved,
        path: resolved,
        title: path.basename(resolved),
        contentType,
        sizeBytes: stat.size,
        binary: true,
      });
      if (artifacts.length >= limit) break;
    } catch {
      // Command output often contains planned or removed paths; only preserve files that exist.
    }
  }
  return artifacts;
}

function collectTextPaths(value: string, output: Set<string>): void {
  for (const pattern of [ABSOLUTE_ARTIFACT_PATTERN, RELATIVE_ARTIFACT_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const candidate = match[1]?.trim().replace(/[.,:]+$/, "");
      if (candidate) output.add(candidate);
    }
  }
}

function collectJsonPaths(value: string, output: Set<string>): void {
  const candidates = [value.trim(), ...value.split(/\r?\n/).map((line) => line.trim())];
  for (const candidate of candidates) {
    if (!candidate || (!candidate.startsWith("{") && !candidate.startsWith("["))) continue;
    try {
      collectJsonStrings(JSON.parse(candidate), output);
    } catch {
      // The text scanner below handles non-JSON command output.
    }
  }
}

function collectJsonStrings(value: unknown, output: Set<string>, depth = 0): void {
  if (depth > 8 || value == null) return;
  if (typeof value === "string") {
    const extension = path.extname(value).toLowerCase();
    if (ARTIFACT_CONTENT_TYPES.has(extension)) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, output, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectJsonStrings(item, output, depth + 1);
    }
  }
}
