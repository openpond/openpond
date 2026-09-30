import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { contentHash, sha256 } from "@openpond/harness";
import { createTasksetDraftWorkspace, isManagedTasksetDraftFilePath, MAX_TASKSET_DRAFT_WORKSPACE_BYTES, TasksetDraftSchema } from "openpond-sdk/taskset-drafts";
import { readTasksetDraftPackage } from "./drafts.js";

/** Capture before parsing: the admitted document and uploaded assets come from
 * one bounded byte snapshot, rather than subsequent reads of a mutable folder. */
export async function captureTasksetDraftWorkspace(input: { directory: string; teamId: string; expectedRevision: number; datasetId?: string }) {
  const directory = path.resolve(input.directory);
  if (!(await lstat(directory)).isDirectory()) throw new Error("Dataset upload requires a regular authored folder.");
  const files = new Map<string, Uint8Array>(); let byteCount = 0;
  async function visit(current: string, depth: number): Promise<void> {
    if (depth > 30) throw new Error("Dataset folder nesting exceeds 30 levels.");
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name.startsWith(".")) throw new Error("Dataset folders cannot include hidden files or directories.");
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error("Dataset folders can contain only regular files and directories.");
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { await visit(full, depth + 1); continue; }
      if (files.size >= 10_000) throw new Error("Dataset folder exceeds 10,000 files.");
      const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_TASKSET_DRAFT_WORKSPACE_BYTES - byteCount) throw new Error("Dataset folder exceeds the 64 MiB capture limit.");
        const bytes = new Uint8Array(stat.size); let offset = 0;
        while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new Error("Dataset file changed during capture."); offset += read.bytesRead; }
        const after = await file.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("Dataset file changed during capture.");
        byteCount += bytes.length; files.set(path.relative(directory, full).replaceAll(path.sep, "/"), bytes);
      } finally { await file.close(); }
    }
  }
  await visit(directory, 0);
  const authored = await readTasksetDraftPackage(directory, files);
  const inventory = [...files].map(([path, bytes]) => ({ path, contentHash: sha256(bytes), sizeBytes: bytes.byteLength }));
  const sourceHash = contentHash(inventory);
  const draft = TasksetDraftSchema.parse({ ...authored, id: input.datasetId ?? authored.id, profileId: input.teamId,
    revision: input.expectedRevision + 1, modelScope: null, status: "draft", publishedTasksetRef: null,
    metadata: { ...authored.metadata, importedTasksetPackage: { packageHash: sourceHash } } });
  const workspace = createTasksetDraftWorkspace({ schemaVersion: "openpond.tasksetDraftWorkspace.v1", draft,
    files: [...files].filter(([file]) => !isManagedTasksetDraftFilePath(file)).map(([path, bytes]) => ({ path, base64: Buffer.from(bytes).toString("base64"), contentHash: sha256(bytes), sizeBytes: bytes.byteLength })) });
  return { workspace, sourceHash, sourceFiles: inventory, capturedBytes: byteCount };
}
