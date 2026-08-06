import type { OpenPondProfileState } from "@openpond/contracts";
import { assertContentHash } from "@openpond/evals";

import type { SqliteStore } from "../store/store.js";
import type { LocalHarnessReleaseRecord } from "../store/store-harness-workspaces.js";
import {
  createLocalHarnessWorkspace,
  importProfileIntoLocalHarnessWorkspace,
} from "./local-harness-workspace-service.js";
import { recoverLocalHarnessSourceSwap } from "./local-harness-refiner.js";

export const DESKTOP_PERSONAL_HARNESS_OWNER_ID = "desktop-personal";
export const DEFAULT_LOCAL_HARNESS_WORKSPACE_ID = "personal-default";

export async function ensureSelectedLocalHarnessWorkspace(input: {
  store: SqliteStore;
  storeDir: string;
  loadProfileState: () => Promise<OpenPondProfileState>;
  now?: () => string;
}): Promise<LocalHarnessReleaseRecord> {
  const selectedWorkspace = await input.store.getSelectedHarnessWorkspace({
    ownerKind: "personal",
    ownerId: DESKTOP_PERSONAL_HARNESS_OWNER_ID,
  });
  if (selectedWorkspace) {
    await recoverLocalHarnessSourceSwap({
      store: input.store,
      storeDir: input.storeDir,
      workspaceId: selectedWorkspace.id,
    });
    return requireCurrentRelease(
      input.store,
      selectedWorkspace.id,
      selectedWorkspace.currentChannel.release?.contentHash ?? null,
    );
  }

  const existing = (
    await input.store.listHarnessWorkspaces({
      ownerKind: "personal",
      ownerId: DESKTOP_PERSONAL_HARNESS_OWNER_ID,
    })
  )[0];
  if (existing) {
    await input.store.selectHarnessWorkspace({
      ownerKind: "personal",
      ownerId: DESKTOP_PERSONAL_HARNESS_OWNER_ID,
      workspaceId: existing.id,
      updatedAt: (input.now ?? (() => new Date().toISOString()))(),
    });
    return requireCurrentRelease(input.store, existing.id, existing.currentChannel.release?.contentHash ?? null);
  }

  const profile = await input.loadProfileState();
  const created = profile.mode === "local" && profile.sourcePath && !profile.error
    ? await importProfileIntoLocalHarnessWorkspace({
        store: input.store,
        storeDir: input.storeDir,
        id: DEFAULT_LOCAL_HARNESS_WORKSPACE_ID,
        ownerId: DESKTOP_PERSONAL_HARNESS_OWNER_ID,
        name: profile.activeProfile?.trim() || "Personal Harness",
        profile,
        now: input.now,
      })
    : await createLocalHarnessWorkspace({
        store: input.store,
        storeDir: input.storeDir,
        id: DEFAULT_LOCAL_HARNESS_WORKSPACE_ID,
        ownerId: DESKTOP_PERSONAL_HARNESS_OWNER_ID,
        name: "Personal Harness",
        now: input.now,
      });
  await input.store.selectHarnessWorkspace({
    ownerKind: "personal",
    ownerId: DESKTOP_PERSONAL_HARNESS_OWNER_ID,
    workspaceId: created.workspace.id,
    updatedAt: (input.now ?? (() => new Date().toISOString()))(),
  });
  return created.release;
}

export async function resolveSelectedLocalHarnessRelease(
  store: SqliteStore,
): Promise<LocalHarnessReleaseRecord | null> {
  const selected = await store.getSelectedHarnessWorkspace({
    ownerKind: "personal",
    ownerId: DESKTOP_PERSONAL_HARNESS_OWNER_ID,
  });
  if (!selected) return null;
  return requireCurrentRelease(store, selected.id, selected.currentChannel.release?.contentHash ?? null);
}

async function requireCurrentRelease(
  store: SqliteStore,
  workspaceId: string,
  contentHash: string | null,
): Promise<LocalHarnessReleaseRecord> {
  if (!contentHash) throw new Error(`Selected Harness workspace ${workspaceId} has no current release.`);
  const release = await store.getHarnessReleaseRecord(contentHash);
  if (!release || release.workspaceId !== workspaceId) {
    throw new Error(`Selected Harness workspace ${workspaceId} points to a missing release ${contentHash}.`);
  }
  assertContentHash(release.agentSnapshot, "Selected Agent snapshot");
  assertContentHash(release.harnessRelease, "Selected Harness release");
  return release;
}
