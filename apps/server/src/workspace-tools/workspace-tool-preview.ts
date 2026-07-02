import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWorkspaceCommand } from "../workspace/workspaces.js";
import { resolveForPreview, resolveForRead } from "./workspace-tool-file-system.js";
import { truncatePatch, type WorkspacePreview, type WorkspacePreviewFile } from "./workspace-tool-common.js";

async function readExistingFile(repoPath: string, filePath: string): Promise<string | null> {
  const { targetPath } = await resolveForPreview(repoPath, filePath);
  try {
    const stat = await fs.lstat(targetPath);
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
    return await fs.readFile(targetPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeTempPreviewFile(root: string, relativePath: string, content: string): Promise<string> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return target;
}

function normalizePreviewPatch(patch: string, tempRoot: string, oldRoot: string, newRoot: string): string {
  return patch
    .replaceAll(oldRoot, "a")
    .replaceAll(newRoot, "b")
    .replaceAll(tempRoot, "")
    .replaceAll("\\", "/");
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

async function previewFileChange(
  repoPath: string,
  filePath: string,
  nextContent: string | null
): Promise<WorkspacePreviewFile> {
  const { relativePath } = await resolveForPreview(repoPath, filePath);
  const previousContent = await readExistingFile(repoPath, relativePath);
  const status: WorkspacePreviewFile["status"] =
    previousContent === null && nextContent !== null
      ? "added"
      : previousContent !== null && nextContent === null
        ? "deleted"
        : previousContent === nextContent
          ? "unchanged"
          : "modified";
  if (status === "unchanged") {
    return { path: relativePath, status, additions: 0, deletions: 0, patch: "" };
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openpond-preview-"));
  try {
    const oldRoot = path.join(tempRoot, "old");
    const newRoot = path.join(tempRoot, "new");
    const oldArg = previousContent === null ? "/dev/null" : await writeTempPreviewFile(oldRoot, relativePath, previousContent);
    const newArg = nextContent === null ? "/dev/null" : await writeTempPreviewFile(newRoot, relativePath, nextContent);
    const diff = await runWorkspaceCommand("git", ["diff", "--no-index", "--unified=80", "--", oldArg, newArg], repoPath);
    if (diff.code !== 0 && diff.code !== 1) {
      throw new Error(diff.stderr.trim() || diff.stdout.trim() || "Unable to preview file diff");
    }
    const patch = normalizePreviewPatch(diff.stdout || diff.stderr, tempRoot, oldRoot, newRoot);
    const counts = countPatchLines(patch);
    return {
      path: relativePath,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      patch: truncatePatch(patch),
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function previewWorkspaceWriteFiles(repoPath: string, files: Record<string, string>): Promise<WorkspacePreview> {
  const previewFiles: WorkspacePreviewFile[] = [];
  for (const [filePath, content] of Object.entries(files)) {
    previewFiles.push(await previewFileChange(repoPath, filePath, content));
  }
  const changed = previewFiles.filter((file) => file.status !== "unchanged");
  return {
    filesChanged: changed.length,
    additions: changed.reduce((sum, file) => sum + file.additions, 0),
    deletions: changed.reduce((sum, file) => sum + file.deletions, 0),
    files: previewFiles,
  };
}

export async function previewWorkspaceWriteFile(repoPath: string, filePath: string, content: string): Promise<WorkspacePreview> {
  return previewWorkspaceWriteFiles(repoPath, { [filePath]: content });
}

export async function previewWorkspaceEditFile(
  repoPath: string,
  filePath: string,
  oldText: string,
  newText: string,
  options: { replaceAll?: boolean } = {}
): Promise<WorkspacePreview & { replacements: number }> {
  const { relativePath, targetPath } = await resolveForRead(repoPath, filePath);
  const content = await fs.readFile(targetPath, "utf8");
  if (!oldText) throw new Error("oldText is required");
  const replacements = content.split(oldText).length - 1;
  if (replacements === 0) throw new Error(`Text not found in ${relativePath}`);
  if (replacements > 1 && !options.replaceAll) {
    throw new Error(
      `Text matched ${replacements} times in ${relativePath}; provide a longer oldText that matches only the intended location, or set replaceAll true.`
    );
  }
  const preview = await previewWorkspaceWriteFile(repoPath, relativePath, content.split(oldText).join(newText));
  return { ...preview, replacements };
}

export async function previewWorkspaceDeleteFile(repoPath: string, filePath: string): Promise<WorkspacePreview> {
  const { relativePath, targetPath } = await resolveForRead(repoPath, filePath);
  const stat = await fs.lstat(targetPath);
  if (!stat.isFile()) throw new Error(`Not a file: ${relativePath}`);
  const file = await previewFileChange(repoPath, relativePath, null);
  return {
    filesChanged: 1,
    additions: file.additions,
    deletions: file.deletions,
    files: [file],
  };
}
