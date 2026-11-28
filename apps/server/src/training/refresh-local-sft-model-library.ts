import { access } from "node:fs/promises";
import path from "node:path";
import type { SqliteStore } from "../store/store.js";

export async function refreshLocalSftModelLibrary(store: SqliteStore, storeDir: string) {
  const exists = await access(path.join(storeDir, "training", "local-sft", "runs")).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
  if (!exists) return;
  return (await import("./local-sft-runs.js")).refreshLocalSftModelRuns(store, storeDir);
}
