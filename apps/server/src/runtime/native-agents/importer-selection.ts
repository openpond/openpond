import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CollectorStore, nativeUploadInventory, nativeUploadConversationPage, validateNativeUploadSelection, type CollectorConnection, type NativeSession } from "@openpond/evals/native-conversations";

const inventories = new Map<string, { expires: number; promise: Promise<NativeSession[]> }>();
function cachedInventory(connection: CollectorConnection, refresh: boolean) {
  const key = JSON.stringify(connection.source);
  const prior = inventories.get(key);
  if (!refresh && prior && prior.expires > Date.now()) return prior.promise;
  const promise = nativeUploadInventory(connection.source);
  inventories.delete(key);
  inventories.set(key, { expires: Date.now() + 15_000, promise });
  if (inventories.size > 8) inventories.delete(inventories.keys().next().value!);
  void promise.catch(() => { if (inventories.get(key)?.promise === promise) inventories.delete(key); });
  return promise;
}

export async function retainedUploadConnection(directory: string, id?: string) {
  const store = await CollectorStore.open(directory);
  try {
    const connection = store.connections().find(item => item.id === id);
    if (!connection) throw new Error("Select a retained conversation connection.");
    return connection;
  } finally { store.close(); }
}

export async function uploadConversationPage(connection: CollectorConnection, query: string, range: string, offset: number, refresh = false) {
  const inventory = await cachedInventory(connection, refresh);
  return nativeUploadConversationPage(connection, inventory, { query, range, offset });
}

/** Frozen CLI input, scoped to the actual retained source; no transcript bytes. */
export async function saveUploadSelection(directory: string, connection: CollectorConnection, sessionKeys: string[]) {
  const selection = await validateNativeUploadSelection(connection.source, { sourceInstanceId: connection.source.instanceId, sessionKeys });
  const text = JSON.stringify(selection);
  const folder = join(directory, "upload-selections");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, `${createHash("sha256").update(text).digest("hex")}.json`);
  try { await writeFile(file, text, { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return file;
}
