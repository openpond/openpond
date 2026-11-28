import type { ChatResourceSummary, LocalDatasetRecord } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "./api-client";
export function chatResourceRequest<T>(connection:ClientConnection,kind:"dataset"|"experiment",request:unknown,signal?:AbortSignal):Promise<T> {
  return apiFetch<T>(connection,kind === "dataset" ? "/v1/local-datasets" : "/v1/chat-experiments",{method:"POST",body:JSON.stringify(request),signal});
}
export type DatasetResponse = {record:LocalDatasetRecord;summary:ChatResourceSummary};

export async function publishLocalDatasetRevision(
  connection: ClientConnection,
  reference: { id: string; revision: number; contentHash?: string },
) {
  const { record } = await chatResourceRequest<DatasetResponse>(connection, "dataset", {
    action: "publish", id: reference.id, expectedRevision: reference.revision,
  });
  const link = record.sync;
  if (!link || link.status !== "synced" || link.publicationIntent ||
    link.acknowledgedHash !== record.workspace.contentHash ||
    reference.contentHash && reference.contentHash !== record.workspace.contentHash)
    throw new Error(link?.error ?? "The exact Dataset revision could not be published.");
}
