import { contentHash } from "@openpond/harness";
import type { OpenPondDatasetWorkspaceClient, DatasetWorkspaceOperationResult, DatasetWorkspaceWriteSchema } from "openpond-sdk/dataset-workspaces";
import type { z } from "zod";

/** Reconstruct from the original retained base, then verify the exact request
 * hash. A later edit cannot turn a lost-response retry into another CAS write. */
export async function saveRecoveredDatasetWrite(client: OpenPondDatasetWorkspaceClient, request: z.input<typeof DatasetWorkspaceWriteSchema>, recovered: DatasetWorkspaceOperationResult | null) {
  if (!recovered) return client.save(request);
  if (recovered.requestHash !== contentHash(request)) throw new Error("This operation ID was used for another Dataset change.");
  if (recovered.receipt.workspace.contentHash !== request.workspace.contentHash) throw new Error("Recovered Dataset differs from the original saved bytes.");
  return recovered.receipt;
}
