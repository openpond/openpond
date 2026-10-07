import os from "node:os";
import path from "node:path";
import { loadWorkspaceFileAtPath, loadWorkspaceImageFileAtPath } from "./workspace-diff.js";
import { readLocalImageFile } from "./workspace-common.js";

export function expandLocalHomePath(value: string): string {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

/** Local chats may explicitly link outputs outside their repository. Relative
 * requests retain the normal workspace containment and visibility rules. */
export async function loadLocalOutputFile(repoPath: string, filePath: string) {
  const target = expandLocalHomePath(filePath.trim());
  if (!isOutsideWorkspace(repoPath, target)) {
    return loadWorkspaceFileAtPath(repoPath, target);
  }
  const absolute = path.resolve(target);
  const file = await loadWorkspaceFileAtPath(path.dirname(absolute), path.basename(absolute));
  return { ...file, path: filePath.trim() };
}

export async function loadLocalOutputImage(repoPath: string, filePath: string) {
  const target = expandLocalHomePath(filePath.trim());
  if (!isOutsideWorkspace(repoPath, target)) return loadWorkspaceImageFileAtPath(repoPath, target);
  const image = await readLocalImageFile(target);
  if (!image) throw new Error("Image not found");
  return image;
}

function isOutsideWorkspace(repoPath: string, target: string): boolean {
  if (!path.isAbsolute(target)) return false;
  const relative = path.relative(path.resolve(repoPath), target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
