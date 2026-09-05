import { assertStorageAncestors } from "./path-safety.js";
import { randomUUID, createHash } from "node:crypto";
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { isMissing, PersistenceError } from "./errors.js";

export const MISSING_REVISION = "missing";
export function fileRevision(bytes: string | null): string {
  return bytes === null ? MISSING_REVISION : createHash("sha256").update(bytes).digest("hex");
}

export async function readOptionalFile(filePath: string): Promise<string | null> {
  assertStorageAncestors(path.dirname(filePath));
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PersistenceError({ code: "UNSAFE_STORAGE_PATH", path: filePath, message: "Storage must be a regular file, not a symbolic link.", action: "Use a regular file in the OpenPond home." });
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function privateDirectory(directory: string): Promise<void> {
  assertStorageAncestors(directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new PersistenceError({ code: "UNSAFE_STORAGE_PATH", path: directory, message: "Managed storage directories cannot be symbolic links.", action: "Select a regular local storage folder." });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
}

export async function atomicWriteFile(filePath: string, content: string | Uint8Array, options: { privateParent?: boolean } = {}): Promise<void> {
  const directory = path.dirname(filePath);
  if (options.privateParent === false) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  else await privateDirectory(directory);
  const existing = await fs.lstat(filePath).catch((error) => { if (isMissing(error)) return null; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new PersistenceError({ code: "UNSAFE_STORAGE_PATH", path: filePath, message: "Cannot replace a non-regular storage file.", action: "Use a regular file in the OpenPond home." });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, filePath);
    if (process.platform !== "win32") {
      const parent = await fs.open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

type LockOwner = { pid: number; nonce: string };
export async function withFileLock<T>(filePath: string, operation: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const release = await acquireFileLock(filePath, timeoutMs);
  try { return await operation(); } finally { await release(); }
}

/** Publish a complete immutable owner file atomically, avoiding empty crash-left locks. */
async function publishLock(lockPath: string, bytes: string): Promise<void> {
  const prepared = `${lockPath}.${process.pid}.${randomUUID()}.candidate`;
  try {
    const file = await fs.open(prepared, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await fs.link(prepared, lockPath);
  } finally { await fs.rm(prepared, { force: true }); }
}

export async function acquireFileLock(filePath: string, timeoutMs = 10_000): Promise<() => Promise<void>> {
  await privateDirectory(path.dirname(filePath));
  const lockPath = `${filePath}.lock`;
  const owner: LockOwner = { pid: process.pid, nonce: randomUUID() };
  const bytes = JSON.stringify(owner);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await publishLock(lockPath, bytes);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = await readOptionalFile(lockPath);
      if (previous) {
        let pid: unknown;
        try { pid = (JSON.parse(previous) as LockOwner).pid; } catch { /* A creator may still be writing. Never break by age. */ }
        if (typeof pid === "number" && Number.isInteger(pid) && pid > 0 && processIsDead(pid)) {
          // Serialize stale-owner recovery; a new owner's lock must never be removed.
          const releaseReclaim = await acquireFileLock(`${lockPath}.reclaim`, Math.max(0, deadline - Date.now()));
          try { if (await readOptionalFile(lockPath) === previous) await fs.unlink(lockPath).catch((error) => { if (!isMissing(error)) throw error; }); }
          finally { await releaseReclaim(); }
        }
      }
      if (Date.now() >= deadline) throw new PersistenceError({ code: "STORAGE_BUSY", path: filePath, message: "Another OpenPond process is updating this storage.", action: "Wait for that process to finish, then retry. Do not delete a live process lock." });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return async () => { if (await readOptionalFile(lockPath) === bytes) await fs.unlink(lockPath); };
}

export function processIsDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export async function readJsonFile<T>(filePath: string, fallback: () => T): Promise<T> {
  const content = await readOptionalFile(filePath);
  if (content === null) return fallback();
  try { return JSON.parse(content) as T; }
  catch (cause) { throw new PersistenceError({ code: "INVALID_STORAGE_JSON", path: filePath, message: "A storage file contains invalid JSON.", action: "Restore a verified backup or correct the file, then retry." }, { cause }); }
}

export async function updateJsonFile<T>(filePath: string, fallback: () => T, update: (value: T) => T | Promise<T>): Promise<T> {
  return withFileLock(filePath, async () => {
    const next = await update(await readJsonFile(filePath, fallback));
    await atomicWriteFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}
