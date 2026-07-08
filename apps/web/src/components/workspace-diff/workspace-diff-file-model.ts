import type { RuntimeEvent, WorkspaceDiffFile, WorkspaceDiffSummary } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import type { SandboxFileEntry, SandboxGitDiff, SandboxGitStatus, SandboxRecord } from "../../lib/sandbox-types";

export const FILE_TRUNCATED_MARKER = "\n\n[file truncated]";
const SANDBOX_SOURCE_READBACK_SCHEMA_VERSION = "openpond.sandboxSourceReadback.v1";

export async function readSandboxFile(
  connection: ClientConnection,
  sandboxId: string,
  path: string,
  runtimeEvents: RuntimeEvent[] = [],
): Promise<WorkspaceDiffFile> {
  let result: Awaited<ReturnType<typeof api.sandboxDownloadFile>>;
  try {
    result = await api.sandboxDownloadFile(connection, sandboxId, path, { maxBytes: 256 * 1024 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isStaleSandboxReadError(message)) throw error;
    const readbackFile = sandboxSourceReadbackFileFromEvents(runtimeEvents, sandboxId, path);
    if (readbackFile) return readbackFile;
    const hasReadbackArtifact = Boolean(latestSandboxSourceReadbackArtifact(runtimeEvents, sandboxId)?.artifact);
    const status = await api.sandbox(connection, sandboxId).catch(() => null);
    throw new Error(staleSandboxReadbackMessage(path, status?.sandbox ?? null, message, { hasReadbackArtifact }));
  }
  const content = result.file.isBinary
    ? result.file.contentsBase64 || null
    : `${result.contents}${result.file.truncated ? FILE_TRUNCATED_MARKER : ""}`;
  return {
    path: result.file.path,
    status: "",
    additions: 0,
    deletions: 0,
    patch: "",
    content,
  };
}

export function isStaleSandboxReadError(message: string): boolean {
  return (
    (message.includes("sandbox_not_ready") && message.includes("placement_stale")) ||
    message.includes("sandbox_not_running")
  );
}

export function staleSandboxReadbackMessage(
  path: string,
  sandbox: SandboxRecord | null,
  fallbackMessage = "sandbox_not_ready:placement_stale",
  options: { hasReadbackArtifact?: boolean } = {},
): string {
  const checkpoint = sandbox ? sandboxPreservedSourceCheckpoint(sandbox) : null;
  const target = path || "this file";
  if (options.hasReadbackArtifact) {
    return `Sandbox file content is unavailable because the stopped runtime placement is stale. The latest source checkpoint has a saved readback artifact, but ${target} was not captured as text. Resume the sandbox to inspect it. ${fallbackMessage}`;
  }
  if (!checkpoint) {
    return `Sandbox file content is unavailable because the stopped runtime placement is stale. Resume the sandbox to inspect ${target}. ${fallbackMessage}`;
  }
  const sha = checkpoint.preservedSha ? checkpoint.preservedSha.slice(0, 12) : null;
  const ref = checkpoint.sourceRef ? ` (${checkpoint.sourceRef})` : "";
  return `Sandbox file content is unavailable because the stopped runtime placement is stale. The latest source checkpoint is saved${sha ? ` at ${sha}` : ""}${ref}, but this Desktop app cannot read file bodies from preserved source refs yet. Resume the sandbox to inspect ${target}.`;
}

export function sandboxSourceReadbackDiffFromEvents(
  runtimeEvents: RuntimeEvent[],
  sandboxId: string | null,
): WorkspaceDiffSummary | null {
  if (!sandboxId) return null;
  const latest = latestSandboxSourceReadbackArtifact(runtimeEvents, sandboxId);
  if (!latest) return null;
  const patchText = sourceReadbackPatchText(latest.artifact);
  const byPath = new Map<string, WorkspaceDiffFile>();
  for (const file of workspaceFilesFromUnifiedDiff(patchText)) byPath.set(file.path, file);
  for (const entry of sourceReadbackFileEntries(latest.artifact)) {
    const file = sourceReadbackWorkspaceFile(latest.artifact, entry.path);
    if (file) byPath.set(entry.path, file);
  }
  const files = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  const repoFiles = [...new Set(files.map((file) => file.path))].sort((left, right) => left.localeCompare(right));
  return {
    appId: sandboxId,
    repoPath: "",
    initialized: true,
    dirty: false,
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    repoFiles,
    files,
    error: null,
    updatedAt: stringValue(asRecord(latest.artifact)?.createdAt) ?? latest.event.timestamp,
  };
}

export function sandboxSourceReadbackFileFromEvents(
  runtimeEvents: RuntimeEvent[],
  sandboxId: string | null,
  path: string,
): WorkspaceDiffFile | null {
  if (!sandboxId) return null;
  const latest = latestSandboxSourceReadbackArtifact(runtimeEvents, sandboxId);
  if (!latest) return null;
  return sourceReadbackWorkspaceFile(latest.artifact, path);
}

function latestSandboxSourceReadbackArtifact(
  runtimeEvents: RuntimeEvent[],
  sandboxId: string,
): { artifact: Record<string, unknown>; event: RuntimeEvent } | null {
  for (let index = runtimeEvents.length - 1; index >= 0; index -= 1) {
    const item = runtimeEvents[index];
    if (item?.name !== "workspace_action_result") continue;
    const data = asRecord(item.data);
    const preservation = asRecord(data?.sourcePreservation);
    const artifact = asRecord(preservation?.sourceReadbackArtifact);
    if (!artifact) continue;
    if (artifact.schemaVersion !== SANDBOX_SOURCE_READBACK_SCHEMA_VERSION) continue;
    if (artifact.sandboxId !== sandboxId) continue;
    return { artifact, event: item };
  }
  return null;
}

function sourceReadbackWorkspaceFile(artifact: Record<string, unknown>, path: string): WorkspaceDiffFile | null {
  const patchFile = workspaceFilesFromUnifiedDiff(sourceReadbackPatchText(artifact))
    .find((file) => file.path === path);
  const entry = sourceReadbackFileEntries(artifact).find((file) => file.path === path);
  if (!patchFile && !entry) return null;
  const content = typeof entry?.content === "string"
    ? `${entry.content}${entry.truncated ? FILE_TRUNCATED_MARKER : ""}`
    : null;
  return {
    path: entry?.path ?? patchFile?.path ?? path,
    status: patchFile?.status ?? "M",
    additions: patchFile?.additions ?? 0,
    deletions: patchFile?.deletions ?? 0,
    patch: patchFile?.patch ?? "",
    content,
  };
}

function sourceReadbackPatchText(artifact: Record<string, unknown>): string {
  const patch = asRecord(artifact.patch);
  return typeof patch?.text === "string" ? patch.text : "";
}

function sourceReadbackFileEntries(artifact: Record<string, unknown>): Array<{
  path: string;
  content?: string;
  truncated?: boolean;
}> {
  const files = Array.isArray(artifact.files) ? artifact.files : [];
  return files
    .map((value) => {
      const record = asRecord(value);
      const path = stringValue(record?.path);
      if (!path) return null;
      return {
        path,
        ...(typeof record?.content === "string" ? { content: record.content } : {}),
        ...(record?.truncated === true ? { truncated: true } : {}),
      };
    })
    .filter((value): value is { path: string; content?: string; truncated?: boolean } => Boolean(value));
}

function sandboxPreservedSourceCheckpoint(sandbox: SandboxRecord): {
  preservedSha: string | null;
  sourceRef: string | null;
} | null {
  const metadata = asRecord(sandbox.metadata) ?? {};
  const preservation = asRecord(metadata.sourcePreservation) ?? asRecord(metadata.sourcePreserve);
  const detection = asRecord(metadata.sourceChangeDetection);
  const preservedSha =
    stringValue(preservation?.preservedSha) ??
    stringValue(detection?.preservedSha) ??
    null;
  const sourceRef =
    stringValue(preservation?.sourceRef) ??
    stringValue(detection?.sourceRef) ??
    (typeof sandbox.repoRef === "string" ? sandbox.repoRef : null);
  if (!preservedSha && !sourceRef) return null;
  return { preservedSha, sourceRef };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function saveSandboxFile(
  connection: ClientConnection,
  sandboxId: string,
  path: string,
  content: string,
): Promise<WorkspaceDiffFile> {
  const result = await api.sandboxUploadFile(connection, sandboxId, { path, contents: content });
  await api.preserveSandboxSource(connection, sandboxId, {
    message: "Auto-preserve source after right sidebar save",
  });
  return {
    path: result.file.path,
    status: "M",
    additions: 0,
    deletions: 0,
    patch: "",
    content,
  };
}

export function sandboxRepoFiles(files: SandboxFileEntry[]): string[] {
  return files
    .filter((file) => file.type === "file")
    .map((file) => file.path)
    .sort((left, right) => left.localeCompare(right));
}

export function sandboxChangedFiles(
  gitDiff: SandboxGitDiff | null,
  gitStatus: SandboxGitStatus | null,
): WorkspaceDiffFile[] {
  const byPath = new Map<string, WorkspaceDiffFile>();
  for (const file of workspaceFilesFromUnifiedDiff(gitDiff?.diff ?? "")) {
    byPath.set(file.path, file);
  }
  for (const file of workspaceFilesFromPorcelain(gitStatus?.porcelain ?? "")) {
    if (!byPath.has(file.path)) byPath.set(file.path, file);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function workspaceFilesFromUnifiedDiff(diff: string): WorkspaceDiffFile[] {
  const files: WorkspaceDiffFile[] = [];
  let current:
    | {
      path: string;
      status: string;
      additions: number;
      deletions: number;
      patchLines: string[];
    }
    | null = null;

  const flush = () => {
    if (!current) return;
    files.push({
      path: current.path,
      status: current.status,
      additions: current.additions,
      deletions: current.deletions,
      patch: current.patchLines.join("\n"),
      content: null,
    });
    current = null;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = {
        path: pathFromDiffGitLine(line) ?? "changed-file",
        status: "M",
        additions: 0,
        deletions: 0,
        patchLines: [line],
      };
      continue;
    }
    if (!current) continue;
    current.patchLines.push(line);
    if (line.startsWith("+++ ")) {
      const path = normalizeDiffPath(line.slice(4));
      if (path) current.path = path;
      continue;
    }
    if (line.startsWith("--- ")) {
      const path = normalizeDiffPath(line.slice(4));
      if (path && current.path === "changed-file") current.path = path;
      continue;
    }
    if (line.startsWith("new file mode ")) current.status = "A";
    if (line.startsWith("deleted file mode ")) current.status = "D";
    if (line.startsWith("rename to ")) {
      current.status = "R";
      current.path = line.slice("rename to ".length).trim() || current.path;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
  }
  flush();

  return files;
}

function workspaceFilesFromPorcelain(porcelain: string): WorkspaceDiffFile[] {
  const files: WorkspaceDiffFile[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const path = pathFromPorcelainLine(line);
    if (!path) continue;
    files.push({
      path,
      status: line.slice(0, 2).trim() || "M",
      additions: 0,
      deletions: 0,
      patch: "",
      content: null,
    });
  }
  return files;
}

function pathFromPorcelainLine(line: string): string | null {
  const raw = line.slice(3).trim();
  if (!raw) return null;
  const renameTarget = raw.split(" -> ").pop()?.trim();
  return renameTarget || raw;
}

function pathFromDiffGitLine(line: string): string | null {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line.trim());
  return match?.[2] ?? match?.[1] ?? null;
}

function normalizeDiffPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === "/dev/null") return null;
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) return trimmed.slice(2);
  return trimmed;
}
