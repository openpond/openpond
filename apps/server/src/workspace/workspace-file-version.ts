import { promises as fs } from "node:fs";
import path from "node:path";
import { expandLocalHomePath } from "./local-output-files.js";

/** Metadata polling detects in-place edits and atomic replacements without
 * repeatedly transferring or rebuilding an open document. */
export async function workspaceFileVersion(rootPath: string, requestedPath: string, allowExternalPaths = false) {
  const requested = expandLocalHomePath(requestedPath.trim());
  if (!requested || requested.includes("\0")) throw new Error("Invalid file path");
  const root = path.resolve(rootPath);
  const target = path.resolve(root, requested);
  const within = (value: string) => value === root || value.startsWith(`${root}${path.sep}`);
  if ((!allowExternalPaths || !path.isAbsolute(requested)) && !within(target)) throw new Error("File not found: outside the workspace");
  try {
    if (!allowExternalPaths || !path.isAbsolute(requested)) {
      const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
      const relative = path.relative(realRoot, realTarget);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("File not found: outside the workspace");
    }
    // The preview readers do not follow symlinks; metadata keeps that boundary.
    const stat = await fs.lstat(target, { bigint: true });
    if (!stat.isFile()) throw new Error("File not found: not a regular file");
    return { exists: true, revision: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return { exists: false, revision: null };
    throw error;
  }
}
