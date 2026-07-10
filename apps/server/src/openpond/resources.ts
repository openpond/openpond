import { promises as fs } from "node:fs";
import path from "node:path";
import type { RuntimeEvent } from "@openpond/contracts";
import {
  isGeneratedWorkspacePath,
  normalizeWorkspaceFilePath,
  workspaceImageContentType,
} from "../workspace/workspaces.js";

export { searchLocalWorkspaceResources } from "./workspace-resource-search.js";
export type {
  ResourceReadRequest,
  ResourceReadResult,
  ResourceSearchRequest,
  ResourceSearchResult,
} from "./resource-types.js";
import type {
  ResourceReadRequest,
  ResourceReadResult,
  ResourceSearchRequest,
  ResourceSearchResult,
} from "./resource-types.js";

const DEFAULT_RESOURCE_MAX_BYTES = 60_000;
const MAX_RESOURCE_MAX_BYTES = 240_000;
const DEFAULT_RESOURCE_SEARCH_LIMIT = 20;
const MAX_RESOURCE_SEARCH_LIMIT = 100;
const TEXT_SAMPLE_BYTES = 4096;
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".db",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp4",
  ".pdf",
  ".png",
  ".sqlite",
  ".tar",
  ".webp",
  ".xls",
  ".xlsm",
  ".xlsx",
  ".zip",
]);

type ParsedResourceRef =
  | { scope: "workspace"; kind: "file"; identifier: string }
  | { scope: "workspace"; kind: "dir"; identifier: string }
  | { scope: "events"; kind: "event"; identifier: string }
  | { scope: "events"; kind: "check-result"; identifier: string; index: number }
  | { scope: "messages"; kind: "message"; identifier: string }
  | { scope: "artifacts"; kind: "artifact"; identifier: string; artifactRef: string }
  | { scope: "goal-context"; kind: "goal-context"; identifier: string };

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "other";
  ref: string;
};

export async function readLocalWorkspaceResource(input: {
  repoPath: string;
  request: ResourceReadRequest;
}): Promise<ResourceReadResult> {
  const parsed = parseResourceRef(input.request.ref);
  if (parsed.scope !== "workspace") {
    throw new Error(`Unsupported resource scope: ${parsed.scope}`);
  }
  if (parsed.kind === "dir") {
    return readWorkspaceDirectoryResource(input.repoPath, parsed.identifier, input.request);
  }
  return readWorkspaceFileResource(input.repoPath, parsed.identifier, input.request);
}

export function readSessionResource(input: {
  events: RuntimeEvent[];
  sessionId: string;
  request: ResourceReadRequest;
}): ResourceReadResult {
  const parsed = parseResourceRef(input.request.ref);
  if (parsed.scope === "events") {
    if (parsed.kind === "check-result") {
      const item = scopedEvents(input.events, input.sessionId).find((event) => event.id === parsed.identifier);
      if (!item) throw new Error(`Check result event not found: ${parsed.identifier}`);
      const check = checkResultsFromEvent(item)[parsed.index];
      if (!check) throw new Error(`Check result not found: ${parsed.identifier}:${parsed.index}`);
      const output = checkOutputText(check);
      const content = trimUtf8Text(output, normalizeMaxBytes(input.request.maxBytes));
      return {
        ref: checkResultRef(item.id, parsed.index),
        kind: "event.check-result",
        title: check.command ? `Check ${check.command}` : `Check ${parsed.index + 1}`,
        contentType: "text/plain",
        ...(input.request.mode === "metadata" ? {} : { contentText: content.text }),
        metadata: {
          eventId: item.id,
          sessionId: item.sessionId ?? null,
          turnId: item.turnId ?? null,
          checkIndex: parsed.index,
          command: check.command ?? null,
          ok: check.ok ?? null,
          code: check.code ?? null,
        },
        relatedRefs: [eventRef(item.id)],
        truncation: input.request.mode === "metadata"
          ? { truncated: false, originalBytes: content.truncation.originalBytes, returnedBytes: 0 }
          : content.truncation,
      };
    }
    const item = scopedEvents(input.events, input.sessionId).find((event) => event.id === parsed.identifier);
    if (!item) throw new Error(`Event resource not found: ${parsed.identifier}`);
    const content = trimUtf8Text(JSON.stringify(item, null, 2), normalizeMaxBytes(input.request.maxBytes));
    return {
      ref: eventRef(item.id),
      kind: "session.event",
      title: `${item.name}${item.action ? ` ${item.action}` : ""}`,
      contentType: "application/json",
      ...(input.request.mode === "metadata" ? {} : { contentText: content.text }),
      metadata: {
        eventId: item.id,
        sessionId: item.sessionId ?? null,
        turnId: item.turnId ?? null,
        name: item.name,
        action: item.action ?? null,
        status: item.status ?? null,
        timestamp: item.timestamp,
      },
      relatedRefs: item.turnId ? messageRefsForTurn(input.events, input.sessionId, item.turnId) : [],
      truncation: input.request.mode === "metadata"
        ? { truncated: false, originalBytes: content.truncation.originalBytes, returnedBytes: 0 }
        : content.truncation,
    };
  }
  if (parsed.scope === "messages") {
    const item = messageResourceForEvent(input.events, input.sessionId, parsed.identifier);
    if (!item) throw new Error(`Message resource not found: ${parsed.identifier}`);
    const content = trimUtf8Text(item.content, normalizeMaxBytes(input.request.maxBytes));
    return {
      ref: messageRef(item.event.id),
      kind: `session.message.${item.role}`,
      title: item.title,
      contentType: "text/plain",
      ...(input.request.mode === "metadata" ? {} : { contentText: content.text }),
      metadata: {
        eventId: item.event.id,
        sessionId: item.event.sessionId ?? null,
        turnId: item.event.turnId ?? null,
        role: item.role,
        timestamp: item.event.timestamp,
      },
      relatedRefs: item.event.turnId ? eventRefsForTurn(input.events, input.sessionId, item.event.turnId) : [],
      truncation: input.request.mode === "metadata"
        ? { truncated: false, originalBytes: content.truncation.originalBytes, returnedBytes: 0 }
      : content.truncation,
    };
  }
  if (parsed.scope === "artifacts") {
    const item = scopedEvents(input.events, input.sessionId).find((event) => event.id === parsed.identifier);
    if (!item) throw new Error(`Artifact event not found: ${parsed.identifier}`);
    const artifact = artifactResourcesFromEvent(item).find((candidate) => candidate.artifactRef === parsed.artifactRef);
    if (!artifact) throw new Error(`Artifact resource not found: ${parsed.artifactRef}`);
    const contentType = contentTypeForPath(artifact.artifactRef) ?? "application/octet-stream";
    const contentText = artifact.contentText ?? null;
    const content = contentText ? trimUtf8Text(contentText, normalizeMaxBytes(input.request.maxBytes)) : null;
    const binary = artifact.binary ?? (!contentText && isLikelyBinaryArtifactRef(artifact.artifactRef));
    return {
      ref: artifactResourceRef(item.id, artifact.artifactRef),
      kind: "event.artifact",
      title: artifact.title ?? artifact.artifactRef,
      contentType,
      ...(input.request.mode === "metadata" || !content ? {} : { contentText: content.text }),
      metadata: {
        eventId: item.id,
        sessionId: item.sessionId ?? null,
        turnId: item.turnId ?? null,
        artifactRef: artifact.artifactRef,
        sourceKey: artifact.sourceKey,
        binary,
      },
      relatedRefs: [eventRef(item.id)],
      truncation: content && input.request.mode !== "metadata"
        ? content.truncation
        : {
            truncated: false,
            originalBytes: content ? content.truncation.originalBytes : 0,
            returnedBytes: 0,
            reason: binary ? "binary-or-external-artifact" : "metadata-only",
          },
    };
  }
  if (parsed.scope === "goal-context") {
    const item = scopedEvents(input.events, input.sessionId).find((event) => event.id === parsed.identifier);
    const goal = item ? goalContextFromEvent(item) : null;
    if (!goal) {
      const document = goalContextDocumentForRef(input.events, input.sessionId, parsed.identifier);
      if (!document) throw new Error(`Goal context resource not found: ${parsed.identifier}`);
      const content = document.contentText
        ? trimUtf8Text(document.contentText, normalizeMaxBytes(input.request.maxBytes))
        : null;
      return {
        ref: goalContextRef(document.id),
        kind: "goal-context.document",
        title: document.title,
        contentType: document.contentType,
        ...(input.request.mode === "metadata" || !content ? {} : { contentText: content.text }),
        metadata: {
          eventId: document.event.id,
          sessionId: document.event.sessionId ?? null,
          turnId: document.event.turnId ?? null,
          documentId: document.id,
          revisionId: document.revisionId,
          title: document.title,
          role: document.role,
          bindingMode: document.bindingMode,
          required: document.required,
          source: document.source,
          contentHash: document.contentHash,
        },
        relatedRefs: [eventRef(document.event.id)],
        truncation: content && input.request.mode !== "metadata"
          ? content.truncation
          : {
              truncated: false,
              originalBytes: content ? content.truncation.originalBytes : 0,
              returnedBytes: 0,
              reason: "metadata-only",
            },
      };
    }
    if (!item) throw new Error(`Goal context resource not found: ${parsed.identifier}`);
    const content = trimUtf8Text(goal.contentText, normalizeMaxBytes(input.request.maxBytes));
    return {
      ref: goalContextRef(item.id),
      kind: "goal-context.runtime",
      title: goal.title,
      contentType: goal.contentType,
      ...(input.request.mode === "metadata" ? {} : { contentText: content.text }),
      metadata: {
        eventId: item.id,
        sessionId: item.sessionId ?? null,
        turnId: item.turnId ?? null,
        sourceKind: goal.sourceKind,
        goalId: goal.goalId,
        status: goal.status,
      },
      relatedRefs: [eventRef(item.id)],
      truncation: input.request.mode === "metadata"
        ? { truncated: false, originalBytes: content.truncation.originalBytes, returnedBytes: 0 }
        : content.truncation,
    };
  }
  throw new Error(`Unsupported session resource ref: ${input.request.ref}`);
}

export function searchSessionResources(input: {
  events: RuntimeEvent[];
  sessionId: string;
  request: ResourceSearchRequest;
}): ResourceSearchResult {
  if (
    input.request.scope !== "events" &&
    input.request.scope !== "messages" &&
    input.request.scope !== "artifacts" &&
    input.request.scope !== "goal-context"
  ) {
    throw new Error(`Unsupported session resource search scope: ${input.request.scope}`);
  }
  const query = input.request.query.trim();
  if (!query) throw new Error("Resource search query is required");
  const limit = normalizeLimit(input.request.limit, DEFAULT_RESOURCE_SEARCH_LIMIT, MAX_RESOURCE_SEARCH_LIMIT);
  const lowerQuery = query.toLowerCase();
  const items: ResourceSearchResult["items"] = [];
  if (input.request.scope === "events") {
    for (const item of scopedEvents(input.events, input.sessionId)) {
      const haystack = eventSearchText(item);
      if (!haystack.includes(lowerQuery)) continue;
      items.push({
        ref: eventRef(item.id),
        title: `${item.name}${item.action ? ` ${item.action}` : ""}`,
        snippet: snippetFromText(haystack, lowerQuery),
        score: 0.7,
        metadata: {
          source: "session.events",
          eventId: item.id,
          turnId: item.turnId ?? null,
          name: item.name,
          action: item.action ?? null,
          timestamp: item.timestamp,
        },
      });
      if (items.length >= limit) break;
    }
  } else if (input.request.scope === "messages") {
    for (const item of messageResources(input.events, input.sessionId)) {
      const haystack = item.content.toLowerCase();
      if (!haystack.includes(lowerQuery)) continue;
      items.push({
        ref: messageRef(item.event.id),
        title: item.title,
        snippet: snippetFromText(item.content, lowerQuery),
        score: 0.8,
        metadata: {
          source: "session.messages",
          eventId: item.event.id,
          turnId: item.event.turnId ?? null,
          role: item.role,
          timestamp: item.event.timestamp,
        },
      });
      if (items.length >= limit) break;
    }
  } else if (input.request.scope === "artifacts") {
    for (const event of scopedEvents(input.events, input.sessionId)) {
      for (const artifact of artifactResourcesFromEvent(event)) {
        const haystack = artifactSearchText(event, artifact);
        if (!haystack.includes(lowerQuery)) continue;
        items.push({
          ref: artifactResourceRef(event.id, artifact.artifactRef),
          title: artifact.title ?? artifact.artifactRef,
          snippet: snippetFromText(haystack, lowerQuery),
          score: 0.75,
          metadata: {
            source: "session.artifacts",
            eventId: event.id,
            turnId: event.turnId ?? null,
            artifactRef: artifact.artifactRef,
            sourceKey: artifact.sourceKey,
          },
        });
        if (items.length >= limit) break;
      }
      if (items.length >= limit) break;
      for (const [index, check] of checkResultsFromEvent(event).entries()) {
        const haystack = checkSearchText(check);
        if (!haystack.includes(lowerQuery)) continue;
        items.push({
          ref: checkResultRef(event.id, index),
          title: check.command ? `Check ${check.command}` : `Check ${index + 1}`,
          snippet: snippetFromText(haystack, lowerQuery),
          score: 0.72,
          metadata: {
            source: "session.checks",
            eventId: event.id,
            turnId: event.turnId ?? null,
            checkIndex: index,
            command: check.command ?? null,
            ok: check.ok ?? null,
            code: check.code ?? null,
          },
        });
        if (items.length >= limit) break;
      }
      if (items.length >= limit) break;
    }
  } else {
    const roleFilter = stringValue(input.request.filters?.role);
    const seen = new Set<string>();
    for (const event of scopedEvents(input.events, input.sessionId)) {
      const goal = goalContextFromEvent(event);
      if (goal && !roleFilter) {
        const haystack = goal.searchText;
        if (haystack.includes(lowerQuery)) {
          const ref = goalContextRef(event.id);
          seen.add(ref);
          items.push({
            ref,
            title: goal.title,
            snippet: snippetFromText(goal.contentText, lowerQuery),
            score: 0.78,
            metadata: {
              source: "session.goal-context",
              eventId: event.id,
              turnId: event.turnId ?? null,
              sourceKind: goal.sourceKind,
              goalId: goal.goalId,
              status: goal.status,
              timestamp: event.timestamp,
            },
          });
          if (items.length >= limit) break;
        }
      }
      for (const document of goalContextDocumentsFromEvent(event)) {
        if (roleFilter && document.role !== roleFilter) continue;
        const haystack = document.searchText;
        if (!haystack.includes(lowerQuery)) continue;
        const ref = goalContextRef(document.id);
        if (seen.has(ref)) continue;
        seen.add(ref);
        items.push({
          ref,
          title: document.title,
          snippet: snippetFromText(document.contentText ?? document.searchText, lowerQuery),
          score: document.role === "primary_context" ? 0.86 : 0.8,
          metadata: {
            source: "session.goal-context.documents",
            eventId: event.id,
            turnId: event.turnId ?? null,
            documentId: document.id,
            revisionId: document.revisionId,
            title: document.title,
            role: document.role,
            bindingMode: document.bindingMode,
            required: document.required,
            sourceRef: stringValue(document.source?.sourceRef),
            commitSha: stringValue(document.source?.commitSha),
            path: stringValue(document.source?.path),
          },
        });
        if (items.length >= limit) break;
      }
      if (items.length >= limit) break;
    }
  }
  return {
    query,
    scope: input.request.scope,
    items,
    truncated: items.length >= limit,
  };
}

function parseResourceRef(ref: string): ParsedResourceRef {
  const trimmed = ref.trim();
  if (trimmed.startsWith("workspace:file:")) {
    return { scope: "workspace", kind: "file", identifier: trimmed.slice("workspace:file:".length) };
  }
  if (trimmed.startsWith("workspace:dir:")) {
    return { scope: "workspace", kind: "dir", identifier: trimmed.slice("workspace:dir:".length) };
  }
  if (trimmed.startsWith("event:check-result:")) {
    const rest = trimmed.slice("event:check-result:".length);
    const separator = rest.lastIndexOf(":");
    const identifier = separator >= 0 ? rest.slice(0, separator) : "";
    const rawIndex = separator >= 0 ? rest.slice(separator + 1) : "";
    const index = Number.parseInt(rawIndex, 10);
    if (!identifier || !Number.isInteger(index) || index < 0) {
      throw new Error("Unsupported check result ref. Use event:check-result:<eventId>:<index>.");
    }
    return { scope: "events", kind: "check-result", identifier, index };
  }
  if (trimmed.startsWith("event:")) {
    return { scope: "events", kind: "event", identifier: trimmed.slice("event:".length) };
  }
  if (trimmed.startsWith("message:")) {
    return { scope: "messages", kind: "message", identifier: trimmed.slice("message:".length) };
  }
  if (trimmed.startsWith("artifact:")) {
    const rest = trimmed.slice("artifact:".length);
    const separator = rest.indexOf(":");
    const identifier = separator >= 0 ? rest.slice(0, separator) : "";
    const encodedRef = separator >= 0 ? rest.slice(separator + 1) : "";
    if (!identifier || !encodedRef) throw new Error("Unsupported artifact ref. Use artifact:<eventId>:<encodedRef>.");
    return {
      scope: "artifacts",
      kind: "artifact",
      identifier,
      artifactRef: decodeURIComponent(encodedRef),
    };
  }
  if (trimmed.startsWith("goal-context:")) {
    return { scope: "goal-context", kind: "goal-context", identifier: trimmed.slice("goal-context:".length) };
  }
  throw new Error("Unsupported resource ref. Use workspace:file:<path>, workspace:dir:<path>, event:<eventId>, event:check-result:<eventId>:<index>, message:<eventId>, artifact:<eventId>:<encodedRef>, or goal-context:<eventId>.");
}

async function readWorkspaceFileResource(
  repoPath: string,
  identifier: string,
  request: ResourceReadRequest,
): Promise<ResourceReadResult> {
  const filePath = normalizeRequiredWorkspacePath(identifier);
  const targetPath = await resolveWorkspacePath(repoPath, filePath);
  const stat = await fs.lstat(targetPath);
  if (!stat.isFile()) throw new Error(`Not a file resource: ${filePath}`);

  const contentType = contentTypeForPath(filePath);
  const maxBytes = normalizeMaxBytes(request.maxBytes);
  const binary = await isBinaryFile(targetPath, filePath);
  const metadata = {
    path: filePath,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    binary,
  };
  if (request.mode === "metadata" || binary) {
    return {
      ref: workspaceFileRef(filePath),
      kind: "workspace.file",
      title: filePath,
      contentType,
      metadata,
      relatedRefs: [],
      truncation: {
        truncated: false,
        originalBytes: stat.size,
        returnedBytes: 0,
        reason: binary ? "binary" : undefined,
      },
    };
  }

  const content = await readTextWithLimit(targetPath, stat.size, maxBytes);
  return {
    ref: workspaceFileRef(filePath),
    kind: "workspace.file",
    title: filePath,
    contentType,
    contentText: content.text,
    metadata: {
      ...metadata,
      lineCount: countLines(content.text),
    },
    relatedRefs: [workspaceDirRef(path.dirname(filePath) === "." ? "" : path.dirname(filePath))],
    truncation: content.truncation,
  };
}

async function readWorkspaceDirectoryResource(
  repoPath: string,
  identifier: string,
  request: ResourceReadRequest,
): Promise<ResourceReadResult> {
  const dirPath = normalizeOptionalWorkspacePath(identifier);
  const targetPath = await resolveWorkspacePath(repoPath, dirPath);
  const stat = await fs.lstat(targetPath);
  if (!stat.isDirectory()) throw new Error(`Not a directory resource: ${dirPath || "."}`);

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const visible: WorkspaceDirectoryEntry[] = entries
    .map((entry) => {
      const entryPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
      if (isGeneratedWorkspacePath(entryPath)) return null;
      return {
        name: entry.name,
        path: entryPath,
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        ref: entry.isDirectory() ? workspaceDirRef(entryPath) : workspaceFileRef(entryPath),
      };
    })
    .filter((entry): entry is WorkspaceDirectoryEntry => Boolean(entry))
    .sort((left, right) => left.path.localeCompare(right.path));
  const maxBytes = normalizeMaxBytes(request.maxBytes);
  const fullText = visible.map((entry) => `${entry.kind === "directory" ? "dir" : "file"} ${entry.path}`).join("\n");
  const content = trimUtf8Text(fullText, maxBytes);

  return {
    ref: workspaceDirRef(dirPath),
    kind: "workspace.dir",
    title: dirPath || ".",
    contentType: "inode/directory",
    ...(request.mode === "metadata" ? {} : { contentText: content.text }),
    metadata: {
      path: dirPath,
      entryCount: visible.length,
      entries: visible,
      modifiedAt: stat.mtime.toISOString(),
    },
    relatedRefs: visible.slice(0, 50).map((entry) => entry.ref),
    truncation: content.truncation,
  };
}

async function resolveWorkspacePath(repoPath: string, relativePath: string): Promise<string> {
  const root = await fs.realpath(repoPath);
  const target = path.resolve(root, relativePath || ".");
  assertInside(root, target);
  const realTarget = await fs.realpath(target);
  assertInside(root, realTarget);
  return realTarget;
}

function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Resource path escapes the workspace root");
  }
}

function normalizeRequiredWorkspacePath(input: string): string {
  const normalized = normalizeWorkspaceFilePath(input);
  if (!normalized) throw new Error("Resource path is required");
  return normalized;
}

function normalizeOptionalWorkspacePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed === ".") return "";
  return normalizeRequiredWorkspacePath(trimmed);
}

function normalizeMaxBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_RESOURCE_MAX_BYTES;
  return Math.min(Math.floor(value), MAX_RESOURCE_MAX_BYTES);
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function workspaceFileRef(filePath: string): string {
  return `workspace:file:${filePath}`;
}

function workspaceDirRef(dirPath: string): string {
  return `workspace:dir:${dirPath || "."}`;
}

function eventRef(eventId: string): string {
  return `event:${eventId}`;
}

function checkResultRef(eventId: string, index: number): string {
  return `event:check-result:${eventId}:${index}`;
}

function messageRef(eventId: string): string {
  return `message:${eventId}`;
}

function artifactResourceRef(eventId: string, artifactRef: string): string {
  return `artifact:${eventId}:${encodeURIComponent(artifactRef)}`;
}

function goalContextRef(identifier: string): string {
  return `goal-context:${encodeURIComponent(identifier)}`;
}

function scopedEvents(events: RuntimeEvent[], sessionId: string): RuntimeEvent[] {
  return events.filter((event) => event.sessionId === sessionId);
}

type MessageResource = {
  event: RuntimeEvent;
  role: "user" | "assistant";
  title: string;
  content: string;
};

function messageResources(events: RuntimeEvent[], sessionId: string): MessageResource[] {
  const output: MessageResource[] = [];
  for (const item of scopedEvents(events, sessionId)) {
    if (item.name === "turn.started") {
      const prompt = typeof item.args?.prompt === "string" ? item.args.prompt : "";
      if (prompt.trim()) output.push({ event: item, role: "user", title: "User message", content: prompt });
    } else if (item.name === "assistant.delta" && item.output?.trim()) {
      output.push({ event: item, role: "assistant", title: "Assistant message", content: item.output });
    }
  }
  return output;
}

function messageResourceForEvent(events: RuntimeEvent[], sessionId: string, eventId: string): MessageResource | null {
  return messageResources(events, sessionId).find((item) => item.event.id === eventId) ?? null;
}

function messageRefsForTurn(events: RuntimeEvent[], sessionId: string, turnId: string): string[] {
  return messageResources(events, sessionId)
    .filter((item) => item.event.turnId === turnId)
    .map((item) => messageRef(item.event.id));
}

function eventRefsForTurn(events: RuntimeEvent[], sessionId: string, turnId: string): string[] {
  return scopedEvents(events, sessionId)
    .filter((item) => item.turnId === turnId)
    .map((item) => eventRef(item.id));
}

function eventSearchText(item: RuntimeEvent): string {
  return [
    item.name,
    item.action,
    item.status,
    item.output,
    item.error,
    item.args ? JSON.stringify(item.args) : "",
    item.data ? JSON.stringify(item.data) : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

type EventArtifactResource = {
  artifactRef: string;
  sourceKey: string;
  title?: string | null;
  contentText?: string | null;
  binary?: boolean;
};

type EventCheckResult = {
  ok?: boolean | null;
  command?: string | null;
  code?: number | null;
  stdout?: string | null;
  stderr?: string | null;
};

type EventGoalContextResource = {
  title: string;
  contentType: string;
  contentText: string;
  searchText: string;
  sourceKind: string;
  goalId: string | null;
  status: string | null;
};

type EventGoalContextDocumentResource = {
  event: RuntimeEvent;
  id: string;
  title: string;
  role: string;
  bindingMode: string | null;
  revisionId: string | null;
  required: boolean | null;
  source: Record<string, unknown> | null;
  contentHash: string | null;
  contentType: string;
  contentText?: string | null;
  searchText: string;
};

const ARTIFACT_REF_KEYS = new Set([
  "artifactRef",
  "artifactRefs",
  "traceArtifactRef",
  "traceArtifactRefs",
  "evalArtifactRef",
  "evalArtifactRefs",
  "evalResultArtifactRefs",
  "validatorArtifactRefs",
]);

function artifactResourcesFromEvent(event: RuntimeEvent): EventArtifactResource[] {
  const resources = new Map<string, EventArtifactResource>();
  const add = (artifact: EventArtifactResource) => {
    if (!artifact.artifactRef.trim()) return;
    const existing = resources.get(artifact.artifactRef);
    resources.set(artifact.artifactRef, {
      artifactRef: artifact.artifactRef,
      sourceKey: artifact.sourceKey || existing?.sourceKey || "data",
      title: artifact.title ?? existing?.title,
      contentText: artifact.contentText ?? existing?.contentText,
      binary: artifact.binary ?? existing?.binary,
    });
  };
  collectArtifactResources(event.data, "data", add);
  collectArtifactResources(event.args, "args", add);
  return [...resources.values()];
}

function collectArtifactResources(
  value: unknown,
  sourceKey: string,
  add: (artifact: EventArtifactResource) => void,
): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectArtifactResources(item, `${sourceKey}[${index}]`, add);
    }
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (ARTIFACT_REF_KEYS.has(key)) {
      for (const ref of stringValues(child)) {
        add({ artifactRef: ref, sourceKey: `${sourceKey}.${key}` });
      }
    }
    if (key === "artifacts" && Array.isArray(child)) {
      for (const [index, item] of child.entries()) {
        const artifactRecord = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
        const ref =
          stringValue(artifactRecord?.ref) ??
          stringValue(artifactRecord?.path) ??
          stringValue(artifactRecord?.artifactRef);
        if (!ref) continue;
        add({
          artifactRef: ref,
          sourceKey: `${sourceKey}.artifacts[${index}]`,
          title: stringValue(artifactRecord?.title) ?? stringValue(artifactRecord?.name),
          contentText:
            stringValue(artifactRecord?.contentText) ??
            stringValue(artifactRecord?.content) ??
            stringValue(artifactRecord?.text),
          binary: artifactRecord?.binary === true,
        });
      }
    }
    collectArtifactResources(child, `${sourceKey}.${key}`, add);
  }
}

function checkResultsFromEvent(event: RuntimeEvent): EventCheckResult[] {
  const output: EventCheckResult[] = [];
  collectCheckResults(event.data, output);
  return output;
}

function goalContextFromEvent(event: RuntimeEvent): EventGoalContextResource | null {
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : null;
  const kind = stringValue(data?.kind);
  if (kind === "thread_goal") {
    const goal = data?.goal && typeof data.goal === "object" && !Array.isArray(data.goal)
      ? (data.goal as Record<string, unknown>)
      : null;
    if (!goal) return null;
    const contentText = JSON.stringify(goal, null, 2);
    const objective = stringValue(goal.objective);
    return {
      title: objective ? `Goal: ${objective}` : "Thread goal",
      contentType: "application/json",
      contentText,
      searchText: [event.name, event.output, contentText].filter(Boolean).join(" ").toLowerCase(),
      sourceKind: kind,
      goalId: stringValue(goal.id),
      status: stringValue(goal.status),
    };
  }
  if (kind === "goal_context") {
    const contentText = event.output?.trim() || JSON.stringify(data, null, 2);
    return {
      title: "Goal context",
      contentType: event.output?.trim() ? "text/plain" : "application/json",
      contentText,
      searchText: [event.name, event.output, data ? JSON.stringify(data) : ""].filter(Boolean).join(" ").toLowerCase(),
      sourceKind: kind,
      goalId: null,
      status: null,
    };
  }
  return null;
}

function goalContextDocumentForRef(
  events: RuntimeEvent[],
  sessionId: string,
  identifier: string,
): EventGoalContextDocumentResource | null {
  const decodedIdentifier = safeDecodeURIComponent(identifier);
  for (const event of scopedEvents(events, sessionId)) {
    for (const document of goalContextDocumentsFromEvent(event)) {
      if (document.id === identifier || document.id === decodedIdentifier) return document;
    }
  }
  return null;
}

function goalContextDocumentsFromEvent(event: RuntimeEvent): EventGoalContextDocumentResource[] {
  const output: EventGoalContextDocumentResource[] = [];
  const add = (candidate: unknown) => {
    const record = asRecord(candidate);
    if (!record || !looksLikeGoalContextDocument(record)) return;
    const source = asRecord(record.source);
    const id =
      stringValue(record.id) ??
      stringValue(record.documentId) ??
      stringValue(source?.path) ??
      stringValue(record.title);
    if (!id) return;
    const title =
      stringValue(record.title) ??
      stringValue(record.name) ??
      stringValue(source?.path) ??
      id;
    const role =
      stringValue(record.role) ??
      stringValue(record.contextRole) ??
      "supporting_context";
    const bindingMode =
      stringValue(record.bindingMode) ??
      stringValue(record.binding) ??
      null;
    const contentHash = stringValue(record.contentHash) ?? stringValue(record.hash);
    const revisionId =
      stringValue(record.revisionId) ??
      stringValue(record.revision) ??
      stringValue(source?.commitSha) ??
      stringValue(source?.sourceRef) ??
      contentHash;
    const contentText =
      stringValue(record.contentText) ??
      stringValue(record.markdown) ??
      stringValue(record.body) ??
      stringValue(record.content) ??
      null;
    const contentType =
      stringValue(record.contentType) ??
      (contentText ? "text/markdown" : "application/json");
    output.push({
      event,
      id,
      title,
      role,
      bindingMode,
      revisionId,
      required: typeof record.required === "boolean" ? record.required : null,
      source,
      contentHash,
      contentType,
      contentText,
      searchText: [
        id,
        title,
        role,
        bindingMode,
        revisionId,
        contentHash,
        source ? JSON.stringify(source) : "",
        contentText,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    });
  };
  collectGoalContextDocumentCandidates(event.data, add);
  collectGoalContextDocumentCandidates(event.args, add);
  return output;
}

function collectGoalContextDocumentCandidates(
  value: unknown,
  add: (candidate: unknown) => void,
): void {
  const record = asRecord(value);
  if (!record) {
    if (Array.isArray(value)) {
      for (const item of value) collectGoalContextDocumentCandidates(item, add);
    }
    return;
  }
  for (const key of ["contextItems", "goalContextItems", "contextDocuments", "goalContextDocuments"]) {
    const child = record[key];
    if (Array.isArray(child)) {
      for (const item of child) add(item);
    }
  }
  const context = asRecord(record.context);
  if (Array.isArray(context?.items)) {
    for (const item of context.items) add(item);
  }
  const goal = asRecord(record.goal);
  if (goal && goal !== record) collectGoalContextDocumentCandidates(goal, add);
}

function looksLikeGoalContextDocument(record: Record<string, unknown>): boolean {
  const kind = stringValue(record.kind);
  const sourceKind = stringValue(asRecord(record.source)?.kind);
  const role = stringValue(record.role);
  return (
    kind === "document" ||
    sourceKind === "profile_goal_doc" ||
    role === "primary_context" ||
    role === "supporting_context" ||
    role === "handoff" ||
    role === "test_plan"
  );
}

function collectCheckResults(value: unknown, output: EventCheckResult[]): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectCheckResults(item, output);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.checks)) {
    for (const item of record.checks) {
      if (!item || typeof item !== "object") continue;
      const check = item as Record<string, unknown>;
      output.push({
        ok: typeof check.ok === "boolean" ? check.ok : null,
        command: stringValue(check.command),
        code: typeof check.code === "number" ? check.code : null,
        stdout: stringValue(check.stdout),
        stderr: stringValue(check.stderr),
      });
    }
  }
  for (const child of Object.values(record)) {
    if (child === record.checks) continue;
    collectCheckResults(child, output);
  }
}

function artifactSearchText(event: RuntimeEvent, artifact: EventArtifactResource): string {
  return [
    artifact.artifactRef,
    artifact.title,
    artifact.sourceKey,
    event.name,
    event.action,
    event.output,
    artifact.contentText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function checkSearchText(check: EventCheckResult): string {
  return [check.command, check.code, check.ok, check.stdout, check.stderr]
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
}

function checkOutputText(check: EventCheckResult): string {
  const parts = [
    check.command ? `$ ${check.command}` : null,
    typeof check.code === "number" ? `exit code: ${check.code}` : null,
    check.stdout ? `stdout:\n${check.stdout}` : null,
    check.stderr ? `stderr:\n${check.stderr}` : null,
  ].filter(Boolean);
  return parts.join("\n\n") || JSON.stringify(check, null, 2);
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isLikelyBinaryArtifactRef(value: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(value).toLowerCase());
}

function snippetFromText(value: string, lowerQuery: string): string {
  const lower = value.toLowerCase();
  const index = lower.indexOf(lowerQuery);
  if (index < 0) return value.slice(0, 200);
  const start = Math.max(0, index - 80);
  const end = Math.min(value.length, index + lowerQuery.length + 120);
  return value.slice(start, end);
}

function contentTypeForPath(filePath: string): string | null {
  const imageType = workspaceImageContentType(filePath);
  if (imageType) return imageType;
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".json") return "application/json";
  if (extension === ".md" || extension === ".mdx") return "text/markdown";
  if ([".css", ".csv", ".html", ".js", ".jsx", ".ts", ".tsx", ".txt", ".yaml", ".yml"].includes(extension)) {
    return "text/plain";
  }
  return null;
}

async function isBinaryFile(targetPath: string, filePath: string): Promise<boolean> {
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return true;
  const file = await fs.open(targetPath, "r");
  try {
    const sample = Buffer.alloc(TEXT_SAMPLE_BYTES);
    const { bytesRead } = await file.read(sample, 0, sample.length, 0);
    return sample.subarray(0, bytesRead).includes(0);
  } finally {
    await file.close();
  }
}

async function readTextWithLimit(
  targetPath: string,
  sizeBytes: number,
  maxBytes: number,
): Promise<Pick<ResourceReadResult, "truncation"> & { text: string }> {
  if (sizeBytes <= maxBytes) {
    const buffer = await fs.readFile(targetPath);
    return {
      text: buffer.toString("utf8"),
      truncation: { truncated: false, originalBytes: sizeBytes, returnedBytes: buffer.length },
    };
  }

  const headBytes = Math.max(1, Math.floor(maxBytes / 2));
  const tailBytes = Math.max(1, maxBytes - headBytes);
  const file = await fs.open(targetPath, "r");
  try {
    const head = Buffer.alloc(headBytes);
    const tail = Buffer.alloc(tailBytes);
    const headRead = await file.read(head, 0, head.length, 0);
    const tailStart = Math.max(0, sizeBytes - tailBytes);
    const tailRead = await file.read(tail, 0, tail.length, tailStart);
    return {
      text: [
        head.subarray(0, headRead.bytesRead).toString("utf8"),
        "\n\n[resource truncated: middle omitted]\n\n",
        tail.subarray(0, tailRead.bytesRead).toString("utf8"),
      ].join(""),
      truncation: {
        truncated: true,
        originalBytes: sizeBytes,
        returnedBytes: headRead.bytesRead + tailRead.bytesRead,
        reason: "maxBytes",
      },
    };
  } finally {
    await file.close();
  }
}

function trimUtf8Text(value: string, maxBytes: number): Pick<ResourceReadResult, "truncation"> & { text: string } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return {
      text: value,
      truncation: { truncated: false, originalBytes: buffer.length, returnedBytes: buffer.length },
    };
  }
  const trimmed = buffer.subarray(0, maxBytes).toString("utf8");
  return {
    text: `${trimmed}\n\n[resource truncated]`,
    truncation: {
      truncated: true,
      originalBytes: buffer.length,
      returnedBytes: maxBytes,
      reason: "maxBytes",
    },
  };
}

function countLines(value: string): number {
  if (!value) return 0;
  return value.split(/\r?\n/).length;
}
