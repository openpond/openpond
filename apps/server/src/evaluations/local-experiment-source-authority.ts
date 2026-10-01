import { harnessExperimentSourceRequiresProfile, type StandaloneHarnessExperimentSource } from "@openpond/evals/experiments";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import { DESKTOP_PERSONAL_HARNESS_OWNER_ID } from "../harness/local-harness-selection.js";
import { LocalExperimentError } from "./local-experiment-contract.js";
import type { HarnessWorkspace } from "@openpond/contracts";

/** Immutable hashes identify bytes, not permission. This reads persisted origin
 * ownership before the native resolver reads those bytes. A request cannot
 * assert device ownership, and a remote cache with missing provenance is denied. */
export async function authorizeLocalExperimentSource(input: {
  store: HarnessStateStore; source: StandaloneHarnessExperimentSource;
  authorizeRemote?: (source: StandaloneHarnessExperimentSource, workspace: HarnessWorkspace) => Promise<void>;
}) {
  const release = await input.store.getHarnessReleaseRecord(input.source.harnessRelease.contentHash);
  if (!release || release.harnessRelease.id !== input.source.harnessRelease.id)
    throw new LocalExperimentError("local_harness_source_unavailable", "The exact released Harness is unavailable on this computer.", 404);
  if (harnessExperimentSourceRequiresProfile(release))
    throw new LocalExperimentError("local_harness_profile_required", "This release requires its exact Profile composition. Select Model + Harness + Profile.", 422);
  const workspace = await input.store.getHarnessWorkspace(release.workspaceId);
  if (!workspace) throw new LocalExperimentError("local_harness_origin_authority_missing", "The cached Harness has no persisted owning workspace.", 403);
  const deviceOwned=workspace.location === "local" && workspace.ownerScope.kind === "personal"
    && workspace.ownerScope.id === DESKTOP_PERSONAL_HARNESS_OWNER_ID
    && workspace.metadata.sourceLayout === "openpond.harnessSourceManifest.v1"
    && workspace.metadata.selectionEligible !== false
    && typeof release.agentSnapshot.metadata.profileRepositoryId !== "string"
    && typeof release.harnessRelease.metadata.profileRepositoryId !== "string";
  if(!deviceOwned) {
    if(input.authorizeRemote) {await input.authorizeRemote(input.source,workspace);return workspace;}
    throw new LocalExperimentError("local_harness_origin_authority_missing",
      "This cached Harness needs an authenticated origin-access check. Import a device-owned local Harness or refresh its authorized source.", 403);
  }
  return workspace;
}
