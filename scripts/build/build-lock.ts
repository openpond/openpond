import { promises as fs } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

// Heartbeats keep long builds alive; abandoned locks recover after a crash.
export async function withBuildLock<T>(file: string, build: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const release = await lockfile.lock(file, {
    realpath: false,
    stale: 60_000,
    retries: { retries: 3_600, minTimeout: 250, maxTimeout: 1_000 },
  });
  try {
    return await build();
  } finally {
    await release();
  }
}
