import type { ChatResourceSummary, LocalDatasetRecord } from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "./api-client";
export function chatResourceRequest<T>(connection:ClientConnection,kind:"dataset"|"experiment",request:unknown,signal?:AbortSignal):Promise<T> {
  return apiFetch<T>(connection,kind === "dataset" ? "/v1/local-datasets" : "/v1/chat-experiments",{method:"POST",body:JSON.stringify(request),signal});
}
export type DatasetResponse = {record:LocalDatasetRecord;summary:ChatResourceSummary};
