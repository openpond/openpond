import path from "node:path";
import { promises as fs } from "node:fs";
import {
  acquireFileLock, storagePaths, atomicWriteFile, readJsonFile, PersistenceError,
} from "@openpond/persistence";

export async function ownHomeRuntime<T extends { close(): Promise<void> }>(home: string, start: () => Promise<T>): Promise<T> {
  let release: () => Promise<void>;
  try { release = await acquireFileLock(path.join(storagePaths(home).runtime, "server-owner"), 100); }
  catch (error) {
    if (error instanceof PersistenceError && error.issue.code === "STORAGE_BUSY") {
      const endpoint = await readJsonFile<{ url?: string } | null>(path.join(storagePaths(home).runtime, "endpoint.json"), () => null);
      throw new PersistenceError({ code: "RUNTIME_ALREADY_RUNNING", path: home,
        message: "An OpenPond runtime already owns this home.",
        action: endpoint?.url ? `Connect to the existing runtime at ${endpoint.url}, or stop it before starting another.` : "Stop the existing runtime before starting another with this home." });
    }
    throw error;
  }
  try {
    const runtime = await start(), close = runtime.close.bind(runtime);
    let closing: Promise<void> | undefined;
    return { ...runtime, close: () => closing ??= (async () => {
      try { await close(); } finally {
        await fs.rm(path.join(storagePaths(home).runtime, "endpoint.json"), { force: true });
        await release();
      }
    })() };
  } catch (error) { await release(); throw error; }
}

export async function publishRuntimeEndpoint(home: string, url: string, serverId: string): Promise<void> {
  await atomicWriteFile(path.join(storagePaths(home).runtime, "endpoint.json"), JSON.stringify({ schemaVersion: "openpond.runtimeEndpoint.v1", pid: process.pid, url, serverId }));
}
