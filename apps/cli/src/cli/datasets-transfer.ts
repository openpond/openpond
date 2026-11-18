import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { OpenPondDatasetImportClient, type DatasetImportSource } from "openpond-sdk/dataset-workspaces";
import { optionString } from "./common";

export const DATASET_TRANSFER_ACTIONS = ["stage-file", "upload-status", "upload-preview", "cancel-upload", "storage"] as const;
type Action = (typeof DATASET_TRANSFER_ACTIONS)[number];

export function isDatasetTransferAction(value: string | undefined): value is Action {
  return DATASET_TRANSFER_ACTIONS.some(action => action === value);
}

async function fileSource(path: string): Promise<DatasetImportSource> {
  const file = await openAsBlob(path);
  if (!file.size) throw new Error("Dataset source files must contain at least one byte.");
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
  if (!pathOrImportId) throw new Error("Provide a source file or import ID.");
  if (action === "upload-status") return client.get(pathOrImportId);
  if (action === "upload-preview") {
    const fileId = optionString(options, "fileId");
    if (!fileId) throw new Error("Provide --file-id from the upload receipt.");
    const revision = optionString(options, "revision");
    const limit = optionString(options, "limit");
    return client.preview(pathOrImportId, {
      fileId,
      revision: revision ? Number(revision) : undefined,
      after: optionString(options, "cursor") || undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }
  const operationId = optionString(options, "operationId");
  if (!operationId || !/^[a-zA-Z0-9._:-]{1,220}$/u.test(operationId))
    throw new Error("Provide a stable --operation-id of at most 220 letters, digits, or ._:- characters.");
  if (action === "cancel-upload") return client.cancel(pathOrImportId, operationId);

  const source = await fileSource(pathOrImportId);
  const relativePath = basename(pathOrImportId).normalize("NFC");
  const imported = await client.begin({ operationId, files: [{ relativePath, sizeBytes: source.sizeBytes }] });
  const [file] = imported.files;
  if (imported.files.length !== 1 || !file || file.relativePath !== relativePath || file.sizeBytes !== source.sizeBytes)
    throw new Error("Dataset import receipt does not match the selected file.");
  const result = await client.uploadFile(imported.importId, file.fileId, source, { operationId: `${operationId}:complete` });
  return { importId: imported.importId, fileId: file.fileId, state: result.state, object: result.object };
}
