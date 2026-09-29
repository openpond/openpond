import path from "node:path";
import { readFile } from "node:fs/promises";

import type { AgentHostStorageClient } from "@openpond/agent-runtime";
import { emptyOpenPondProfileLibrary, emptyOpenPondProfileState } from "@openpond/contracts";
import { loadReleasedProfileWorkflowCatalogAssets } from "@openpond/harness";
import { z } from "zod";

import { loadHostedHarnessRuntime } from "./hosted-harness-runtime.js";

export const AdmittedHostedProfileReleaseSchema = z.object({
  profileId: z.string().min(1), sourceRevision: z.string().min(1), repositoryId: z.string().min(1),
  harnessRelease: z.object({ id: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  workspaceId: z.string().min(1), assetsPath: z.string().min(1).refine(path.isAbsolute),
}).strict();
export type AdmittedHostedProfileRelease = z.infer<typeof AdmittedHostedProfileReleaseSchema>;

/** Verify the host-admitted immutable Profile release. Bound Work selects its
 * instructions and skills from that release, without a local Profile repo. */
export async function loadHostedProfileStateAndLibrary(
  client: AgentHostStorageClient,
  inputRelease: AdmittedHostedProfileRelease,
) {
  const admittedRelease = AdmittedHostedProfileReleaseSchema.parse(inputRelease);
  const runtime = await loadHostedHarnessRuntime(client, admittedRelease.harnessRelease);
  if (!runtime || runtime.workspace.id !== admittedRelease.workspaceId ||
      path.resolve(runtime.release.bundlePath) !== path.resolve(admittedRelease.assetsPath)) {
    throw new Error("Hosted Profile release changed after admission.");
  }
  const provenance = runtime.release.harnessRelease.metadata.profile;
  if (!provenance || typeof provenance !== "object" ||
      (provenance as Record<string, unknown>).id !== admittedRelease.profileId ||
      (provenance as Record<string, unknown>).sourceRevision !== admittedRelease.sourceRevision ||
      (provenance as Record<string, unknown>).repositoryId !== admittedRelease.repositoryId) {
    throw new Error("Hosted Profile provenance differs from admitted release.");
  }
  return { profile: emptyOpenPondProfileState(), profileLibrary: emptyOpenPondProfileLibrary() };
}

/** Project the admitted immutable workflow catalog without a local store. */
export async function listHostedProfileWorkflows(
  client: AgentHostStorageClient,
  inputRelease: AdmittedHostedProfileRelease,
) {
  const admittedRelease = AdmittedHostedProfileReleaseSchema.parse(inputRelease);
  const runtime = await loadHostedHarnessRuntime(client, admittedRelease.harnessRelease);
  if (!runtime || runtime.workspace.id !== admittedRelease.workspaceId) {
    throw new Error("Hosted Profile workflow release is unavailable.");
  }
  const provenance = runtime.release.harnessRelease.metadata.profile as Record<string, unknown> | undefined;
  if (provenance?.id !== admittedRelease.profileId ||
      provenance.sourceRevision !== admittedRelease.sourceRevision ||
      provenance.repositoryId !== admittedRelease.repositoryId) {
    throw new Error("Hosted Profile workflow provenance changed.");
  }
  const releaseRef = admittedRelease.harnessRelease;
  const ref = { source: "openpond_git" as const,
    repositoryId: admittedRelease.repositoryId, profileId: admittedRelease.profileId };
  if (!runtime.release.harnessRelease.files.some((file) => file.path === "workflows/catalog.json")) {
    return { profileRef: ref, sourceRevision: admittedRelease.sourceRevision,
      harnessRelease: releaseRef, workflows: [] };
  }
  const root = path.join(runtime.release.bundlePath, "source", "workflows");
  const catalog = loadReleasedProfileWorkflowCatalogAssets({
    agentSnapshot: runtime.release.agentSnapshot,
    harnessRelease: runtime.release.harnessRelease,
    catalogBytes: await readFile(path.join(root, "catalog.json")),
    actionBytes: await readFile(path.join(root, "actions.json")),
  });
  return {
    profileRef: ref, sourceRevision: admittedRelease.sourceRevision,
    harnessRelease: releaseRef,
    workflows: catalog.catalog.workflows.map((workflow) => ({
      workflow,
      binding: {
        schemaVersion: "openpond.profileWorkflowBinding.v1" as const,
        profileId: admittedRelease.profileId,
        sourceRevision: admittedRelease.sourceRevision,
        harnessRelease: releaseRef,
        catalogHash: catalog.catalogHash,
        workflowId: workflow.id,
      },
    })),
  };
}
