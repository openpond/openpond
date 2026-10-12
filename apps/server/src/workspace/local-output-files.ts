import os from "node:os";
import path from "node:path";
import { loadWorkspaceFileAtPath, loadWorkspaceImageFileAtPath } from "./workspace-diff.js";
import { readLocalImageFile, readWorkspaceFile, readWorkspaceDocumentPreview } from "./workspace-common.js";

export function expandLocalHomePath(value: string): string {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

/** Local chats may explicitly link outputs outside their repository. Relative
 * requests remain contained, including generated outputs excluded from diffs. */
export async function loadLocalOutputFile(repoPath: string, filePath: string) {
  const target = expandLocalHomePath(filePath.trim());
  if (!isOutsideWorkspace(repoPath, target)) {
    try { return await loadWorkspaceFileAtPath(repoPath, target); }
    catch (error) {
      // Generated outputs may be gitignored, but an explicit local link still
      // names a readable file. Keep the normal containment and size limits.
      const preview = await readOutputPreview(repoPath, target);
      if (preview === null) throw error;
      return { path: filePath.trim(), status: "unchanged" as const, additions: 0, deletions: 0, patch: "", ...preview };
    }
  }
  const absolute = path.resolve(target);
  const preview = await readOutputPreview(path.dirname(absolute), path.basename(absolute));
  if (preview === null) throw new Error("File not found or unsupported preview format");
  return { path: filePath.trim(), status: "unchanged" as const, additions: 0, deletions: 0, patch: "", ...preview };
}

async function readOutputPreview(repoPath: string, filePath: string) {
  const content = await readWorkspaceFile(repoPath, filePath);
  return content === null ? readWorkspaceDocumentPreview(repoPath, filePath) : { content };
}

export async function loadLocalOutputImage(repoPath: string, filePath: string) {
  const target = expandLocalHomePath(filePath.trim());
  if (!path.isAbsolute(target)) return loadWorkspaceImageFileAtPath(repoPath, target);
  const image = await readLocalImageFile(target);
  if (!image) throw new Error("Image not found");
  return image;
}

function isOutsideWorkspace(repoPath: string, target: string): boolean {
  if (!path.isAbsolute(target)) return false;
  const relative = path.relative(path.resolve(repoPath), target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
