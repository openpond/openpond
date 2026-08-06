import {
  createHarnessRunOverlay,
  type HarnessRunOverlay,
  type HarnessWorkspace,
} from "@openpond/contracts";
import { contentHash, type ImmutableReleaseRef } from "@openpond/evals";

import type { SqliteStore } from "../store/store.js";
import {
  loadLocalHarnessRuntimeFromRelease,
  loadSelectedLocalHarnessRuntime,
  type SelectedLocalHarnessRuntime,
} from "./local-harness-skill-runtime.js";

export async function loadLocalHarnessRuntimeForAgentRun(
  store: SqliteStore,
  runId: string,
): Promise<SelectedLocalHarnessRuntime | null> {
  const overlay = await store.getHarnessRunOverlay(runId);
  if (!overlay) return loadSelectedLocalHarnessRuntime(store);
  const workspace = await store.getHarnessWorkspace(overlay.workspace.workspaceId);
  const release = await store.getHarnessReleaseRecord(
    overlay.baseHarnessRelease.contentHash,
  );
  if (
    !workspace ||
    !release ||
    release.harnessRelease.id !== overlay.baseHarnessRelease.id
  ) {
    throw new Error("Durable Agent run overlay references an unavailable Harness release.");
  }
  return loadLocalHarnessRuntimeFromRelease({ workspace, release });
}

export async function ensureLocalHarnessRunOverlay(input: {
  store: SqliteStore;
  runId: string;
  workspace: HarnessWorkspace;
  harnessRelease: ImmutableReleaseRef;
  admittedAt: string;
}): Promise<HarnessRunOverlay> {
  const existing = await input.store.getHarnessRunOverlay(input.runId);
  if (existing) {
    if (
      existing.workspace.workspaceId !== input.workspace.id ||
      existing.baseHarnessRelease.id !== input.harnessRelease.id ||
      existing.baseHarnessRelease.contentHash !== input.harnessRelease.contentHash
    ) {
      throw new Error(
        "The durable Agent run is already bound to a different Harness release; start a fresh run or explicitly rebase its overlay.",
      );
    }
    return existing;
  }
  const overlay = createHarnessRunOverlay({
    schemaVersion: "openpond.harnessRunOverlay.v1",
    id: `overlay-${contentHash({
      runId: input.runId,
      harnessRelease: input.harnessRelease,
    }).slice(0, 24)}`,
    runId: input.runId,
    baseHarnessRelease: input.harnessRelease,
    workspace: {
      workspaceId: input.workspace.id,
      revision: input.workspace.revision,
      sourceRevision: input.workspace.sourceRevision,
      channelRevision: input.workspace.currentChannel.revision,
    },
    revision: 0,
    status: "active",
    edits: [],
    createdAt: input.admittedAt,
    updatedAt: input.admittedAt,
    metadata: {},
  });
  return input.store.createHarnessRunOverlay(overlay);
}
