import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { buildTaskset } from "@openpond/taskset-sdk";
import type { prepareModelStarterTaskset } from "./model-starter-taskset.js";

/** Build in an unpublished directory, then atomically expose a complete package.
 * Different creation attempts use different derived Taskset identities. */
export async function materializeModelStarterPackage(home: string, prepared: ReturnType<typeof prepareModelStarterTaskset>) {
  const root = path.join(home, "training", "tasksets");
  if (!/^starter-[a-f0-9]{40}$/.test(prepared.taskset.id)) throw new Error("Starter Taskset identity is not a safe package identity.");
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(path.join(root, ".starter-"));
  const target = path.join(root, prepared.taskset.id);
  try {
    const built = await buildTaskset(prepared.taskset, temporary, { generatedFiles: prepared.generatedFiles });
    try { await rename(temporary, target); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const directory = await lstat(target);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Starter package destination is not a regular directory.");
      const existingFiles = await regularFiles(target);
      const expectedFiles = built.files.map(file => path.relative(temporary, file)).sort();
      if (JSON.stringify(existingFiles.sort()) !== JSON.stringify(expectedFiles)) throw new Error("Existing starter package has a different file inventory.");
      for (const file of built.files) {
        const destination = path.join(target, path.relative(temporary, file));
        const status = await lstat(destination);
        if (!status.isFile() || status.isSymbolicLink() || !(await readFile(destination)).equals(await readFile(file))) throw new Error("Existing starter package differs from the pinned creation attempt.");
      }
    }
    return target;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function regularFiles(root: string, relative = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Starter packages cannot contain symbolic links.");
    if (entry.isDirectory()) files.push(...await regularFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error("Starter packages must contain regular files and directories.");
  }
  return files;
}
