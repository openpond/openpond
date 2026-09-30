import type { OpenPondProfileState } from "@openpond/contracts";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import type { LocalHarnessReleaseRecord } from "../store/store-harness-workspaces.js";
import {
  compileProfileHarnessSource,
  importProfileIntoLocalHarnessWorkspace,
} from "./local-harness-workspace-service.js";

/** Admit one exact Profile source into a personal Harness workspace. */
export async function ensureExplicitProfileHarnessSource(input: {
  store: HarnessStateStore;
  storeDir: string;
  workspaceId: string;
  ownerId: string;
  name: string;
  profile: OpenPondProfileState;
  sourceRevision: string;
  repositoryId: string;
}): Promise<LocalHarnessReleaseRecord> {
  if (!input.repositoryId.trim()) throw new Error("Explicit Profile source requires a repository ID.");
  const compiled = await compileProfileHarnessSource(input);
  const existing = await input.store.getHarnessWorkspace(input.workspaceId);
  if (existing) {
    const releaseRef = existing.currentChannel.release;
    if (existing.ownerScope.kind !== "personal" || existing.ownerScope.id !== input.ownerId ||
        existing.sourceRevision !== compiled.sourceRevision ||
        releaseRef?.id !== compiled.harnessRelease.id ||
        releaseRef.contentHash !== compiled.harnessRelease.contentHash) {
      throw new Error("Explicit Profile source changed under its accepted revision.");
    }
    const release = await input.store.getHarnessReleaseRecord(releaseRef.contentHash);
    if (!release) throw new Error("Explicit Profile source release is missing after restore.");
    return release;
  }
  const imported = await importProfileIntoLocalHarnessWorkspace({
    ...input, id: input.workspaceId, selectionEligible: false,
  });
  if (imported.release.harnessRelease.contentHash !== compiled.harnessRelease.contentHash ||
      imported.workspace.sourceRevision !== compiled.sourceRevision) {
    throw new Error("Explicit Profile source changed during import.");
  }
  return imported.release;
}
