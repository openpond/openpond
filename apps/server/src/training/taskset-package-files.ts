import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentHash } from "@openpond/harness";
import { decodeTasksetPackageFile, MAX_TASKSET_PACKAGE_BYTES, validateTasksetPackage, type TasksetPackage } from "openpond-sdk/taskset-packages";
import type { GeneratedTaskFile, Taskset } from "@openpond/contracts";
import { taskBatchPackageMetadata } from "@openpond/evals/learning";

/** Imported review snapshots remain package-owned, separate from live intake. */
export async function readImportedLearningTasksetPackage(home: string | undefined, taskset: Taskset) {
  const hash = taskset.metadata.importedPackageHash;
  if (hash === undefined) return undefined;
  if (typeof hash !== "string" || !home) throw new Error("Imported batch requires its package storage directory.");
  const value = await readCachedTasksetPackage(home, hash);
  if (!value.learningResources || value.taskset.id !== taskset.id || value.taskset.revision !== taskset.revision
    || contentHash(taskBatchPackageMetadata(value.taskset)) !== contentHash(taskset.metadata.learning)) throw new Error("Imported batch differs from its pinned package.");
  return value;
}

export function importedTasksetPackageDirectory(profileId: string, packageHash: string): string {
  return `package-${contentHash({ profileId, packageHash })}`;
}

/** The cache retains the exact portable encoding independently of the local
 * Taskset projection, whose Profile/provenance give it a different hash. */
export async function cacheTasksetPackage(home: string, input: TasksetPackage): Promise<void> {
  const value = validateTasksetPackage(input);
  const directory = path.join(home, "training", "portable-packages");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${value.contentHash}.json`);
  const temporary = await mkdtemp(path.join(directory, ".package-"));
  try {
    const payload = path.join(temporary, "package.json");
    await writeFile(payload, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    try { await link(payload, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await readCachedTasksetPackage(home, value.contentHash);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function readCachedTasksetPackage(home: string, hash: string): Promise<TasksetPackage> {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid Taskset package cache identity.");
  const file = path.join(home, "training", "portable-packages", `${hash}.json`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const status = await handle.stat();
    if (!status.isFile() || status.size > MAX_TASKSET_PACKAGE_BYTES) throw new Error("Taskset package cache must be a bounded regular file.");
    const bytes = Buffer.alloc(status.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("Taskset package cache changed during read.");
      offset += result.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new Error("Taskset package cache changed during read.");
    const value = validateTasksetPackage(JSON.parse(bytes.toString("utf8")));
    if (value.contentHash !== hash) throw new Error("Cached Taskset package differs from its saved receipt.");
    return value;
  } finally { await handle.close(); }
}

/** Import is not training admission. Preserve the verified portable files and
 * an inspectable local manifest without inventing reviews or qualifications. */
export async function materializeImportedTasksetPackage(input: {
  home: string; package: TasksetPackage; taskset: Taskset; generatedFiles: GeneratedTaskFile[];
}): Promise<void> {
  const value = validateTasksetPackage(input.package);
  const directoryId = importedTasksetPackageDirectory(input.taskset.profileId, value.contentHash);
  if (input.taskset.environment.metadata.runtimeSourceTasksetId !== directoryId) throw new Error("Imported Taskset directory differs from its package identity.");
  const files = new Map<string, Uint8Array>();
  const add = (name: string, bytes: Uint8Array) => {
    if (path.isAbsolute(name) || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Taskset package file requires a safe relative path.");
    const previous = files.get(name);
    if (previous && !Buffer.from(previous).equals(Buffer.from(bytes))) throw new Error(`Taskset package files collide at ${name}.`);
    files.set(name, bytes);
  };
  for (const file of value.files) add(file.asset.path, decodeTasksetPackageFile(file));
  for (const file of input.generatedFiles) add(file.path, Buffer.from(file.content, "utf8"));
  add("taskset.json", Buffer.from(JSON.stringify(input.taskset), "utf8"));
  const root = path.join(input.home, "training", "tasksets");
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(path.join(root, ".package-import-"));
  const target = path.join(root, directoryId);
  try {
    for (const [name, bytes] of files) {
      await mkdir(path.dirname(path.join(temporary, name)), { recursive: true });
      await writeFile(path.join(temporary, name), bytes, { flag: "wx", mode: 0o600 });
    }
    try { await rename(temporary, target); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const status = await lstat(target);
      if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("Imported Taskset destination must be a regular directory.");
      const inventory = await regularFiles(target);
      if (JSON.stringify(inventory.sort()) !== JSON.stringify([...files.keys()].sort())) throw new Error("Imported Taskset file inventory changed.");
      for (const [name, bytes] of files) if (!(await readFile(path.join(target, name))).equals(Buffer.from(bytes))) throw new Error("Imported Taskset files differ from the pinned package.");
    }
    await cacheTasksetPackage(input.home, value);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function regularFiles(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, item.name);
    if (item.isSymbolicLink()) throw new Error("Imported Taskset directories cannot contain symbolic links.");
    if (item.isDirectory()) result.push(...await regularFiles(root, name));
    else if (item.isFile()) result.push(name);
    else throw new Error("Imported Taskset packages require regular files.");
  }
  return result;
}
