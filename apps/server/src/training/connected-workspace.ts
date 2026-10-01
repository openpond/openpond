import { z } from "zod";
import type { ConnectedEvidenceClient } from "openpond-sdk/connected-evidence";

export const connectedWorkspaceOperations = ["connectedList", "connectedCapture", "connectedCase", "connectedUnmapped", "connectedCollection", "connectedUploadPart", "connectedPreview", "connectedCommit", "connectedImportReceipt", "connectedSelection", "connectedPrepareRecorded", "connectedRecordedList", "connectedPublishDataset"] as const;
const Id = z.string().min(1).max(500);
/** The SDK verifies every response against its exact source/request identity;
 * the hosted service remains the source owner and mutation authority. */
export async function connectedWorkspaceRequest(client: ConnectedEvidenceClient, operation: string, value: unknown, projectId: string | null, authorizeDataset?: (id: string) => Promise<unknown>): Promise<{value:unknown} | null> {
  if (!(connectedWorkspaceOperations as readonly string[]).includes(operation)) return null;
  const scoped = z.object({projectId:Id.optional(),destination:z.object({projectId:Id.optional()}).passthrough().optional()}).passthrough().parse(value ?? {});
  if (projectId && (scoped.projectId && scoped.projectId !== projectId || scoped.destination?.projectId && scoped.destination.projectId !== projectId)) throw new Error("This connected evidence request belongs to another Project.");
  switch (operation) {
    case "connectedRecordedList": return {value:await client.listRecordedExecutions({...value as Parameters<typeof client.listRecordedExecutions>[0], ...(projectId ? {projectId} : {})})};
    case "connectedList": return {value:await client.list(value as Parameters<typeof client.list>[0])};
    case "connectedCapture": return {value:await client.capture(value as Parameters<typeof client.capture>[0])};
    case "connectedCase": return {value:await client.read(value as Parameters<typeof client.read>[0])};
    case "connectedUnmapped": return {value:await client.unmappedEvents(value as Parameters<typeof client.unmappedEvents>[0])};
    case "connectedCollection": {
      const request = z.object({paused:z.boolean().optional()}).strict().parse(value ?? {});
      return {value:request.paused === undefined ? await client.collection() : await client.setCollection(request.paused)};
    }
    case "connectedUploadPart": return {value:await client.uploadPart(value as Parameters<typeof client.uploadPart>[0])};
    case "connectedPreview": return {value:await client.preview(value as Parameters<typeof client.preview>[0])};
    case "connectedCommit": return {value:await client.commit(value as Parameters<typeof client.commit>[0])};
    case "connectedImportReceipt": return {value:await client.readImport(z.object({operationId:Id}).strict().parse(value).operationId)};
    case "connectedPublishDataset": {
      const request = value as Parameters<typeof client.publishDataset>[0];
      if (!authorizeDataset) throw new Error("Dataset publication requires the current Project resource owner.");
      await authorizeDataset(Id.parse(request.datasetId));
      const result = await client.publishDataset(request);
      await authorizeDataset(request.datasetId);
      return { value: result };
    }
    case "connectedSelection": return {value:await client.createSelection(value as Parameters<typeof client.createSelection>[0])};
    case "connectedPrepareRecorded": return {value:await client.prepareRecorded(value as Parameters<typeof client.prepareRecorded>[0])};
    default: throw new Error("Unsupported connected evidence operation.");
  }
}
