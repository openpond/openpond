import type { WorkspaceDiffFile } from "@openpond/contracts";
import { api, type ClientConnection } from "../../api";
import type { SandboxFileEntry, SandboxGitDiff, SandboxGitStatus } from "../../lib/sandbox-types";

export const FILE_TRUNCATED_MARKER = "\n\n[file truncated]";

export async function readSandboxFile(
  connection: ClientConnection,
  sandboxId: string,
  path: string,
): Promise<WorkspaceDiffFile> {
  const result = await api.sandboxDownloadFile(connection, sandboxId, path, { maxBytes: 256 * 1024 });
  const content = result.file.isBinary
    ? null
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

export async function saveSandboxFile(
  connection: ClientConnection,
  sandboxId: string,
  path: string,
  content: string,
): Promise<WorkspaceDiffFile> {
  const result = await api.sandboxUploadFile(connection, sandboxId, { path, contents: content });
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
