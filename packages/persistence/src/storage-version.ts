import { readJsonFile } from "./private-file.js";
import { storagePaths } from "./home.js";
import { PersistenceError } from "./errors.js";

/** Read-only preflight: do not acquire locks or initialize tables in a future home. */
export async function assertHomeCompatible(home: string): Promise<void> {
  const file = storagePaths(home).marker;
  const marker = await readJsonFile<Record<string, unknown> | null>(file, () => null);
  if (marker && (marker.schemaVersion !== "openpond.storage.v1" || marker.version !== 1)) throw new PersistenceError({ code: "UNSUPPORTED_STORAGE_VERSION", path: file, message: "This OpenPond home requires a different application version.", action: "Update OpenPond, or restore a compatible backup into a separate home." });
}
