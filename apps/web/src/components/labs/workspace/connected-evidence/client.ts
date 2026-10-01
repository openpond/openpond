import type { z } from "zod";
import type { WorkspaceApi } from "../workspace-api";
const operations = { list: "connectedList", capture: "connectedCapture", read: "connectedCase", read_unmapped: "connectedUnmapped", collection: "connectedCollection", read_collection: "connectedCollection", upload: "connectedUploadPart", preview: "connectedPreview", commit: "connectedCommit", read_import: "connectedImportReceipt", create_selection: "connectedSelection", publish_dataset: "connectedPublishDataset", prepare_recorded: "connectedPrepareRecorded" } as const;
export async function connectedCommand<T extends z.ZodType>(api: WorkspaceApi, operation: keyof typeof operations, value: unknown, schema: T): Promise<z.infer<T>> {
  const parsed = schema.parse(await api.request(operations[operation], value));
  if (parsed && typeof parsed === "object" && "teamId" in parsed && parsed.teamId !== api.teamId) throw new Error("Connected evidence workspace changed.");
  return parsed;
}
