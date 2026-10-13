import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { expandLocalHomePath } from "./local-output-files.js";

const contentVersions = new Map<string, { stamp: string; revision: Promise<string> }>();
export function fileContentVersion(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

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
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    // A timestamp change alone does not mean the displayed document changed.
    // Hash once per filesystem version; unchanged polling still only stats.
    if (stat.size > 20n * 1024n * 1024n) return { exists: true, revision: `stat:${stamp}`, stamp };
    let cached = contentVersions.get(target);
    if (!cached || cached.stamp !== stamp) {
      const revision = fs.readFile(target).then(fileContentVersion);
      cached = { stamp, revision };
      contentVersions.set(target, cached);
      if (contentVersions.size > 128) contentVersions.delete(contentVersions.keys().next().value!);
      void revision.catch(() => { if (contentVersions.get(target)?.revision === revision) contentVersions.delete(target); });
    }
    return { exists: true, revision: await cached.revision, stamp };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return { exists: false, revision: null, stamp: null };
    throw error;
  }
}
