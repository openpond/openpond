import { randomUUID } from "node:crypto";
import { HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient } from "@openpond/agent-runtime";
import { assertContentHash } from "@openpond/harness";
import { RefinerReleaseSchema, type RefinerRelease } from "@openpond/harness/refiner";

/** The active Review Profile comes from its owner generation's immutable binding. */
export async function loadHostedRefinerRelease(client: AgentHostStorageClient,
  workspaceId: string): Promise<RefinerRelease> {
  const release = RefinerReleaseSchema.parse(await client.request({
    contractVersion: HOST_STORAGE_CONTRACT_VERSION, requestId: randomUUID(),
    operation: "refiner/execute", params: { action: { action: "active_release", workspaceId } },
  }));
  assertContentHash(release, "Hosted Refiner active release");
  return release;
}
