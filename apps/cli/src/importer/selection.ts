import { readFile } from "node:fs/promises";
import { NativeUploadSelectionSchema, validateNativeUploadSelection, type CollectorConnection } from "@openpond/evals/native-conversations";

export async function readUploadSelection(file: string) {
  const bytes = await readFile(file);
  if (bytes.byteLength > 1024 * 1024) throw new Error("Conversation selection exceeds 1 MiB.");
  return NativeUploadSelectionSchema.parse(JSON.parse(bytes.toString("utf8")));
}

export async function applyUploadSelection(connection: CollectorConnection, file: string) {
  const selection = await validateNativeUploadSelection(connection.source, await readUploadSelection(file));
  return { ...connection, since: null, selectedSessionKeys: [...selection.sessionKeys].sort() };
}
