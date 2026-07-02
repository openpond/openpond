import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { assertGoalFileReadSize } from "../limits";

function resolveWorkspacePath(workspace: string, filePath: string): string {
  const resolved = resolve(workspace, filePath);
  const rel = relative(workspace, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path is outside workspace: ${filePath}`);
  }
  return resolved;
}

export async function readGoalFile(params: {
  workspace: string;
  path: string;
}): Promise<string> {
  const absolute = resolveWorkspacePath(params.workspace, params.path);
  const info = await stat(absolute);
  assertGoalFileReadSize(params.path, info.size);
  return readFile(absolute, "utf-8");
}

export async function readGoalPath(params: {
  workspace: string;
  path: string;
}): Promise<
  | { path: string; type: "file"; content: string }
  | { path: string; type: "directory"; entries: string[] }
> {
  const absolute = resolveWorkspacePath(params.workspace, params.path);
  const info = await stat(absolute);
  if (info.isDirectory()) {
    const entries = await readdir(absolute, { withFileTypes: true });
    return {
      path: params.path,
      type: "directory",
      entries: entries.map((entry) => entry.name).sort(),
    };
  }
  assertGoalFileReadSize(params.path, info.size);
  return {
    path: params.path,
    type: "file",
    content: await readFile(absolute, "utf-8"),
  };
}

export async function writeGoalFile(params: {
  workspace: string;
  path: string;
  content: string;
}): Promise<{ path: string; created: boolean }> {
  const absolute = resolveWorkspacePath(params.workspace, params.path);
  const created = !(await fileExists(absolute));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, params.content, "utf-8");
  return { path: params.path, created };
}

export async function listGoalFiles(params: {
  workspace: string;
  path?: string;
}): Promise<string[]> {
  const root = resolveWorkspacePath(params.workspace, params.path || ".");
  const entries = await readdir(root, { withFileTypes: true });
  return entries.map((entry) => entry.name).sort();
}

async function fileExists(path: string): Promise<boolean> {
  return access(path, fsConstants.F_OK)
    .then(() => true)
    .catch(() => false);
}
