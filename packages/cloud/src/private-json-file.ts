import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_WAIT_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;

export function openPondConfigDirectory(): string {
  const override = process.env.OPENPOND_CONFIG_DIR?.trim();
  return override || path.join(os.homedir(), ".openpond");
}

export async function writePrivateJsonFile(filePath: string, value: unknown): Promise<void> {
  await withPrivateJsonFileLock(filePath, () => writePrivateJsonFileUnlocked(filePath, value));
}

export async function updatePrivateJsonFile<T>(
  filePath: string,
  fallback: () => T,
  update: (current: T) => T | Promise<T>,
): Promise<T> {
  return withPrivateJsonFileLock(filePath, async () => {
    const current = await readJsonFile(filePath, fallback);
    const next = await update(current);
    await writePrivateJsonFileUnlocked(filePath, next);
    return next;
  });
}

async function writePrivateJsonFileUnlocked(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function withPrivateJsonFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleLock(lockPath);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for private file lock: ${filePath}`);
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readJsonFile<T>(filePath: string, fallback: () => T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback();
    throw error;
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  const stats = await fs.stat(lockPath).catch(() => null);
  if (stats && Date.now() - stats.mtimeMs > STALE_LOCK_MS) {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}
