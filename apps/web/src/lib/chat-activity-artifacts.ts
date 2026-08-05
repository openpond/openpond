import type { RuntimeEvent } from "@openpond/contracts";
import type { ActivityItem } from "./app-models";
import { asRecord, parseMaybeJson, stringValue } from "./chat-message-utils";
import { isWorkspaceImagePath, workspaceFileName } from "./workspace-images";

export function activityImagePreview(
  item: RuntimeEvent,
): ActivityItem["imagePreview"] | undefined {
  if (!isViewImageEvent(item)) return undefined;
  const data = asRecord(item.data);
  const previewPath =
    typeof data?.openpondImagePreviewPath === "string"
      ? data.openpondImagePreviewPath
      : null;
  const fallbackPath =
    previewPath ??
    findImagePathValue(item.data) ??
    findImagePathValue(item.args) ??
    findImagePathValue(item.output);
  if (!fallbackPath || !isWorkspaceImagePath(fallbackPath)) return undefined;
  return {
    path: fallbackPath,
    appId: item.appId ?? null,
    title: workspaceFileName(fallbackPath),
  };
}

export function activityArtifacts(
  item: RuntimeEvent,
): NonNullable<ActivityItem["artifacts"]> {
  if (item.name !== "tool.completed" && item.name !== "workspace_action_result") {
    return [];
  }
  const artifacts: NonNullable<ActivityItem["artifacts"]> = [];
  const seen = new Set<string>();
  collectActivityArtifacts(item.data, artifacts, seen);
  return artifacts.slice(0, 12);
}

function collectActivityArtifacts(
  value: unknown,
  output: NonNullable<ActivityItem["artifacts"]>,
  seen: Set<string>,
  depth = 0,
): void {
  if (depth > 7 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectActivityArtifacts(item, output, seen, depth + 1);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  const path = stringValue(record, ["path", "artifactRef"]);
  const contentType = stringValue(record, ["contentType", "mimeType"]);
  if (path && contentType && !seen.has(path)) {
    seen.add(path);
    output.push({
      path,
      title: stringValue(record, ["title", "name"]) ?? workspaceFileName(path),
      contentType,
      sizeBytes: typeof record.sizeBytes === "number" ? record.sizeBytes : null,
    });
  }
  for (const child of Object.values(record)) {
    collectActivityArtifacts(child, output, seen, depth + 1);
  }
}

export function isViewImageEvent(item: RuntimeEvent): boolean {
  if (item.name !== "tool.started" && item.name !== "tool.completed") return false;
  const data = asRecord(item.data);
  if (
    typeof data?.openpondImagePreviewPath === "string" &&
    data.openpondImagePreviewPath.trim()
  ) {
    return true;
  }
  const candidates = [
    item.output,
    item.action,
    stringValue(data, [
      "tool",
      "toolName",
      "tool_name",
      "name",
      "functionName",
      "function_name",
      "command",
    ]),
    stringValue(asRecord(data?.input), [
      "tool",
      "toolName",
      "tool_name",
      "name",
    ]),
    stringValue(asRecord(data?.arguments), [
      "tool",
      "toolName",
      "tool_name",
      "name",
    ]),
    stringValue(asRecord(data?.args), [
      "tool",
      "toolName",
      "tool_name",
      "name",
    ]),
  ].filter((value): value is string => Boolean(value));
  return candidates.some((value) => value.toLowerCase().includes("view_image"));
}

function findImagePathValue(value: unknown, depth = 0, key = ""): string | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") {
    if (isImagePathKey(key) && isWorkspaceImagePath(value.trim())) return value.trim();
    const parsed = parseMaybeJson(value);
    if (parsed !== null) {
      const nested = findImagePathValue(parsed, depth + 1, key);
      if (nested) return nested;
    }
    return extractImagePathFromText(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = findImagePathValue(item, depth + 1, key);
      if (candidate) return candidate;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const [childKey, child] of Object.entries(record)) {
    if (!isImagePathKey(childKey)) continue;
    const candidate = findImagePathValue(child, depth + 1, childKey);
    if (candidate) return candidate;
  }
  for (const [childKey, child] of Object.entries(record)) {
    if (isImagePathKey(childKey)) continue;
    const candidate = findImagePathValue(child, depth + 1, childKey);
    if (candidate) return candidate;
  }
  return null;
}

function isImagePathKey(key: string): boolean {
  return /^(path|filePath|filepath|imagePath|image|localPath|uri|url)$/i.test(key);
}

function extractImagePathFromText(value: string): string | null {
  const match =
    /(?:file:\/\/)?(?:\/|\.\/|[\w.-]+\/)[^\s"'`<>]+\.(?:avif|gif|jpe?g|png|webp)\b/i.exec(
      value,
    );
  if (!match) return null;
  if (!match[0].startsWith("file://")) return match[0];
  try {
    return decodeURIComponent(new URL(match[0]).pathname);
  } catch {
    return match[0].replace(/^file:\/\//i, "");
  }
}
