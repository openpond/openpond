import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isGeneratedWorkspacePath,
  listPlainWorkspaceFiles,
  runWorkspaceCommand,
  uniqueSortedPaths,
} from "../workspace/workspaces.js";
import { MAX_READ_CHARS, type FileReadResult } from "./workspace-tool-common.js";

export function normalizeWorkspacePath(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized.trim()) throw new Error("Path is required");
  if (normalized.startsWith("/")) throw new Error("Absolute paths are not allowed");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("Path is required");
  if (parts.some((part) => part === ".." || part === ".git")) {
    throw new Error("Path escapes are not allowed");
  }
  return parts.join("/");
}

export function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Path escapes the workspace root");
  }
}

export async function resolveForRead(repoPath: string, input: string): Promise<{ relativePath: string; targetPath: string }> {
  const relativePath = normalizeWorkspacePath(input);
  const targetPath = path.resolve(repoPath, relativePath);
  assertInside(repoPath, targetPath);
  const realRoot = await fs.realpath(repoPath);
  const realTarget = await fs.realpath(targetPath);
  assertInside(realRoot, realTarget);
  return { relativePath, targetPath: realTarget };
}

export async function resolveForWrite(repoPath: string, input: string): Promise<{ relativePath: string; targetPath: string }> {
  const relativePath = normalizeWorkspacePath(input);
  const targetPath = path.resolve(repoPath, relativePath);
  assertInside(repoPath, targetPath);

  try {
    const realRoot = await fs.realpath(repoPath);
    const realTarget = await fs.realpath(targetPath);
    assertInside(realRoot, realTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(targetPath);
    await fs.mkdir(parent, { recursive: true });
    const realRoot = await fs.realpath(repoPath);
    const realParent = await fs.realpath(parent);
    assertInside(realRoot, realParent);
  }

  return { relativePath, targetPath };
}

async function nearestExistingParent(targetPath: string, root: string): Promise<string> {
  let current = path.dirname(targetPath);
  const resolvedRoot = path.resolve(root);
  while (current !== path.dirname(current)) {
    if (current === resolvedRoot || current.startsWith(`${resolvedRoot}${path.sep}`)) {
      try {
        const stat = await fs.lstat(current);
        if (stat.isDirectory()) return current;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (current === resolvedRoot) break;
    current = path.dirname(current);
  }
  return resolvedRoot;
}

export async function resolveForPreview(repoPath: string, input: string): Promise<{ relativePath: string; targetPath: string }> {
  const relativePath = normalizeWorkspacePath(input);
  const targetPath = path.resolve(repoPath, relativePath);
  assertInside(repoPath, targetPath);

  const realRoot = await fs.realpath(repoPath);
  try {
    const realTarget = await fs.realpath(targetPath);
    assertInside(realRoot, realTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await nearestExistingParent(targetPath, repoPath);
    const realParent = await fs.realpath(parent);
    assertInside(realRoot, realParent);
  }

  return { relativePath, targetPath };
}

async function visibleFiles(repoPath: string): Promise<string[]> {
  const result = await runWorkspaceCommand(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    repoPath
  );
  if (result.code === 0) {
    return uniqueSortedPaths(
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((file) => !isGeneratedWorkspacePath(file))
    );
  }
  return listPlainWorkspaceFiles(repoPath);
}

export async function listWorkspaceFiles(repoPath: string): Promise<string[]> {
  return visibleFiles(repoPath);
}

export async function readWorkspaceFiles(repoPath: string, paths: string[]): Promise<FileReadResult[]> {
  const files: FileReadResult[] = [];
  for (const filePath of paths) {
    const { relativePath, targetPath } = await resolveForRead(repoPath, filePath);
    const stat = await fs.lstat(targetPath);
    if (!stat.isFile()) throw new Error(`Not a file: ${relativePath}`);
    const content = await fs.readFile(targetPath, "utf8");
    files.push({
      path: relativePath,
      content: content.length > MAX_READ_CHARS ? `${content.slice(0, MAX_READ_CHARS)}\n\n[file truncated]` : content,
    });
  }
  return files;
}

export async function searchWorkspaceFiles(
  repoPath: string,
  query: string
): Promise<Array<{ path: string; line: number; text: string }>> {
  const needle = query.trim();
  if (!needle) throw new Error("Search query is required");
  const results: Array<{ path: string; line: number; text: string }> = [];
  for (const filePath of await visibleFiles(repoPath)) {
    let content: string;
    try {
      content = (await readWorkspaceFiles(repoPath, [filePath]))[0]?.content ?? "";
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (line.includes(needle)) {
        results.push({ path: filePath, line: index + 1, text: line.slice(0, 500) });
        if (results.length >= 100) return results;
      }
    }
  }
  return results;
}

export async function writeWorkspaceFile(repoPath: string, filePath: string, content: string): Promise<{ path: string }> {
  const { relativePath, targetPath } = await resolveForWrite(repoPath, filePath);
  await fs.writeFile(targetPath, content, "utf8");
  return { path: relativePath };
}

export async function editWorkspaceFile(
  repoPath: string,
  filePath: string,
  oldText: string,
  newText: string,
  options: { replaceAll?: boolean } = {}
): Promise<{ path: string; replacements: number }> {
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
  await fs.writeFile(targetPath, content.split(oldText).join(newText), "utf8");
  return { path: relativePath, replacements };
}

export async function deleteWorkspaceFile(repoPath: string, filePath: string): Promise<{ path: string }> {
  const { relativePath, targetPath } = await resolveForRead(repoPath, filePath);
  const stat = await fs.lstat(targetPath);
  if (!stat.isFile()) throw new Error(`Not a file: ${relativePath}`);
  await fs.unlink(targetPath);
  return { path: relativePath };
}
