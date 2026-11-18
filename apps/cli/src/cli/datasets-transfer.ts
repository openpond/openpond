import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { opendir } from "node:fs/promises";
import { basename, join } from "node:path";
import { OpenPondDatasetImportClient, type DatasetImportSource } from "openpond-sdk/dataset-workspaces";
import { optionString } from "./common";

export const DATASET_TRANSFER_ACTIONS = [
  "stage-file", "stage-folder", "upload-begin", "upload-status", "upload-preview", "upload-mapping",
  "upload-materialize", "upload-materialization", "upload-finish", "cancel-upload", "storage",
] as const;
type Action = (typeof DATASET_TRANSFER_ACTIONS)[number];

export function isDatasetTransferAction(value: string | undefined): value is Action {
  return DATASET_TRANSFER_ACTIONS.some(action => action === value);
}

async function fileSource(file: Blob): Promise<DatasetImportSource> {
  const digest = createHash("sha256");
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      digest.update(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { sizeBytes: file.size, sha256: digest.digest("hex"), read: (start, end) => file.slice(start, end) };
}

async function* folderFiles(directory: string, prefix = ""): AsyncGenerator<{ path: string; relativePath: string }> {
  for await (const entry of await opendir(directory)) {
    const path = join(directory, entry.name);
    const relativePath = `${prefix}${entry.name}`.normalize("NFC");
    if (entry.isDirectory()) yield* folderFiles(path, `${relativePath}/`);
    else if (entry.isFile() && /\.(?:csv|json|jsonl|ndjson)$/iu.test(entry.name)) yield { path, relativePath };
    else throw new Error(`Remove unsupported folder entry ${relativePath}. Choose regular CSV, JSON or JSONL files.`);
  }
}

async function stageFolder(client: OpenPondDatasetImportClient, operationId: string, directory: string) {
  const files: Array<{ path: string; relativePath: string }> = [];
  for await (const file of folderFiles(directory)) {
    if (files.length === 100) throw new Error("Choose a folder with up to 100 source files.");
    files.push(file);
  }
  if (!files.length) throw new Error("Choose a folder containing CSV, JSON or JSONL files.");
  files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  const sources = new Map<string, Blob>();
  for (const { path, relativePath } of files) {
    if (sources.has(relativePath)) throw new Error(`Duplicate normalized dataset path ${relativePath}.`);
    const source = await openAsBlob(path);
    if (!source.size) throw new Error(`Dataset source file ${relativePath} is empty.`);
    sources.set(relativePath, source);
  }
  const imported = await client.begin({ operationId, files: [...sources].map(([relativePath, source]) => ({
    relativePath, sizeBytes: source.size,
  })) });
  const completed = [];
  for (const file of imported.files) {
    const source = sources.get(file.relativePath);
    if (!source) throw new Error("Dataset import receipt does not match the selected folder.");
    const uploaded = await client.uploadFile(imported.importId, file.fileId, await fileSource(source), { operationId: `${operationId}:complete` });
    if (uploaded.relativePath !== file.relativePath) throw new Error("Dataset upload changed the declared file path.");
    completed.push(uploaded);
  }
  return { importId: imported.importId, files: completed };
}

async function readRequest(path: string, maximumBytes: number) {
  const file = await openAsBlob(path);
  if (file.size > maximumBytes) throw new Error("The dataset request exceeds its permitted size.");
  return JSON.parse(await file.text());
}

export async function runDatasetTransferCommand(
  client: OpenPondDatasetImportClient,
  action: Action,
  pathOrImportId: string | undefined,
  options: Record<string, string | boolean>,
) {
  if (action === "storage") {
    if (pathOrImportId) throw new Error("Storage does not accept an import ID.");
    return client.storage();
  }
  if (action === "upload-begin") {
    const path = optionString(options, "inputFile");
    if (pathOrImportId || !path) throw new Error("Provide --input-file containing the operationId and declared files.");
    return client.begin(await readRequest(path, 256 * 1024));
  }
  if (!pathOrImportId) throw new Error("Provide a source file or import ID.");
  if (action === "upload-status") return client.get(pathOrImportId);
  if (action === "upload-mapping") {
    const path = optionString(options, "inputFile");
    if (!path) return client.mapping(pathOrImportId);
    return client.saveMapping(pathOrImportId, await readRequest(path, 128 * 1024));
  }
  if (action === "upload-materialize") {
    const path = optionString(options, "inputFile");
    if (!path) throw new Error("Provide --input-file containing the pinned materialization request.");
    return client.materialize(pathOrImportId, await readRequest(path, 4_096));
  }
  if (action === "upload-finish") {
    const path = optionString(options, "inputFile");
    if (!path) throw new Error("Provide --input-file containing the pinned finish request.");
    return client.finish(pathOrImportId, await readRequest(path, 4_096));
  }
  if (action === "upload-materialization") {
    const materializationId = optionString(options, "materializationId");
    if (!materializationId) throw new Error("Provide --materialization-id from the preparation receipt.");
    const limit = optionString(options, "limit");
    return client.materialization(pathOrImportId, materializationId, {
      limit: limit ? Number(limit) : undefined,
      after: optionString(options, "cursor") || undefined,
    });
  }
  if (action === "upload-preview") {
    const fileId = optionString(options, "fileId");
    if (!fileId) throw new Error("Provide --file-id from the upload receipt.");
    const revision = optionString(options, "revision");
    const mappingRevision = optionString(options, "mappingRevision");
    const limit = optionString(options, "limit");
    return client.preview(pathOrImportId, {
      fileId,
      revision: revision ? Number(revision) : undefined,
      mappingRevision: mappingRevision ? Number(mappingRevision) : undefined,
      after: optionString(options, "cursor") || undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }
  const operationId = optionString(options, "operationId");
  if (!operationId || !/^[a-zA-Z0-9._:-]{1,220}$/u.test(operationId))
    throw new Error("Provide a stable --operation-id of at most 220 letters, digits, or ._:- characters.");
  if (action === "cancel-upload") return client.cancel(pathOrImportId, operationId);
  if (action === "stage-folder") return stageFolder(client, operationId, pathOrImportId);

  const source = await openAsBlob(pathOrImportId);
  if (!source.size) throw new Error("Dataset source files must contain at least one byte.");
  const relativePath = basename(pathOrImportId).normalize("NFC");
  const imported = await client.begin({ operationId, files: [{ relativePath, sizeBytes: source.size }] });
  const [file] = imported.files;
  if (imported.files.length !== 1 || !file || file.relativePath !== relativePath || file.sizeBytes !== source.size)
    throw new Error("Dataset import receipt does not match the selected file.");
  const result = await client.uploadFile(imported.importId, file.fileId, await fileSource(source), { operationId: `${operationId}:complete` });
  return { importId: imported.importId, fileId: file.fileId, state: result.state, object: result.object };
}
