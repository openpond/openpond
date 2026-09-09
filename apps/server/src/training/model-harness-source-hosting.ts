import { createHarnessSourcePackage, type AgentSnapshot, type HarnessRelease } from "@openpond/harness";
import type { ModelProject } from "@openpond/contracts";
import { createTrainingClient } from "openpond-sdk/training";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import { materializeHarnessSource } from "./materialize-harness-source.js";

export type ReleasedTrainingHarnessResolver = (reference: { id: string; contentHash: string }) => Promise<{
  agentSnapshot: AgentSnapshot; harnessRelease: HarnessRelease; sourcePath?: string;
} | null>;

/** Explicit Model sync publishes its selected source before saving hosted
 * settings. An already hosted Model may retain its published source without
 * requiring a Desktop authoring checkout. */
export async function publishModelHarnessSource(input: {
  project: ModelProject; storeDir: string; resolveReleasedHarness?: ReleasedTrainingHarnessResolver;
  access: { apiBaseUrl: string; token: string; teamId: string }; fetch?: typeof fetch;
}) {
  const reference = input.project.trainingSetup.harnessRelease;
  if (!reference) return;
  const headers = hostedApiAuthHeaders(input.access.token);
  headers.set("x-openpond-team-id", input.access.teamId);
  const client = createTrainingClient({ baseUrl: input.access.apiBaseUrl, headers, fetch: input.fetch });
  const released = await input.resolveReleasedHarness?.(reference);
  if (!released) {
    // API clients and prepared training bundles can publish source beforehand.
    // Verify that exact workspace release instead of requiring a local checkout.
    await client.getHarnessSource(reference);
    return;
  }
  if (!released.sourcePath || released.harnessRelease.id !== reference.id || released.harnessRelease.contentHash !== reference.contentHash) {
    throw new Error("The selected Harness release has no matching immutable source.");
  }
  const files = await materializeHarnessSource({ sourcePath: released.sourcePath, storeDir: input.storeDir, harnessHash: reference.contentHash, files: released.harnessRelease.files });
  await client.publishHarnessSource(createHarnessSourcePackage({ ...released, files }));
}
