import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { GeneratedTaskFile, Taskset } from "@openpond/contracts";
import { MAX_TASKSET_PACKAGE_BYTES, prepareAuthoredTasksetSource, isGeneratedTasksetPublicationFilePath } from "openpond-sdk/taskset-packages";
export { AuthoredTasksetFileInventorySchema } from "openpond-sdk/taskset-packages";
import { desktopTasksetRuntimeAdapterId } from "./portable-evals-adapter.js";

/** Pin executable source and every additional private file before publishing
 * an ordinary authored revision. References never stand in for source bytes. */
export async function prepareAuthoredTasksetFiles(taskset: Taskset, directory: string) {
  if (taskset.metadata.taskDefinition !== undefined || taskset.metadata.rewardBinding !== undefined) return { taskset, generatedFiles: [] as GeneratedTaskFile[] };
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Taskset source must be a regular directory.");
  const bytes = new Map<string, Buffer>();
  let total = 0;
  async function visit(relative = "") {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Taskset files cannot contain symbolic links.");
      if (entry.name.startsWith(".env")) throw new Error("Environment files cannot be included in a Taskset package.");
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!entry.isFile()) throw new Error("Taskset packages require regular files.");
      if (isGeneratedTasksetPublicationFilePath(name)) continue;
      if (bytes.size >= 10_000) throw new Error("Taskset source exceeds the file inventory limit.");
      const handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const status = await handle.stat();
        total += status.size;
        if (!status.isFile() || total > MAX_TASKSET_PACKAGE_BYTES * 3 / 4) throw new Error("Taskset source exceeds the package byte limit.");
        const buffer = Buffer.alloc(status.size);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!read.bytesRead) throw new Error("Taskset source changed during capture.");
          offset += read.bytesRead;
        }
        if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new Error("Taskset source changed during capture.");
        bytes.set(name, buffer);
      } finally { await handle.close(); }
    }
  }
  await visit();
  return prepareAuthoredTasksetSource(taskset, bytes, desktopTasksetRuntimeAdapterId(taskset));
}
