import { promises as fs } from "node:fs";
import path from "node:path";

import {
  contentHash,
  loadReleasedProfileWorkflowCatalogAssets,
  resolveReleasedProfileWorkflowCatalogBinding,
  type ProfileWorkflow,
  type ProfileWorkflowAction,
  type ProfileWorkflowBinding,
  type ProfileWorkflowCatalog,
} from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";
import type { OpenPondProfileRef, OpenPondProfileState, Session } from "@openpond/contracts";
import {
  loadSelectedLocalHarnessRuntime,
  type SelectedLocalHarnessRuntime,
} from "./local-harness-skill-runtime.js";
import { loadLocalHarnessRuntimeForAgentRun } from "./local-harness-run-overlay.js";
import { DESKTOP_PERSONAL_HARNESS_OWNER_ID } from "./local-harness-selection.js";
import { ensureExplicitProfileHarnessSource } from "./local-harness-workspace-service.js";

type ProfileWorkflowsResult = Awaited<ReturnType<typeof loadProfileWorkflows>>;
const profileLoads = new WeakMap<SqliteStore, Map<string, Promise<ProfileWorkflowsResult>>>();

export async function ensureLocalProfileWorkflows(input: {
  store: SqliteStore;
  storeDir: string;
  ref: OpenPondProfileRef;
  profile: OpenPondProfileState;
  reloadProfile?: () => Promise<OpenPondProfileState>;
}) {
  const { profile, ref } = input;
  if (profile.mode !== "local" || !profile.sourcePath || profile.error ||
      profile.activeProfile !== ref.profileId || !profile.git?.head || profile.git.dirty) {
    throw new Error("Select a clean, committed Profile before loading its workflows.");
  }
  const workspaceId = `profile-${contentHash({ ref, sourceRevision: profile.git.head }).slice(0, 24)}`;
  let pending = profileLoads.get(input.store);
  if (!pending) {
    pending = new Map();
    profileLoads.set(input.store, pending);
  }
  const existing = pending.get(workspaceId);
  if (existing) return existing;
  const load = loadProfileWorkflows({ ...input, workspaceId });
  pending.set(workspaceId, load);
  try { return await load; }
  finally { pending.delete(workspaceId); }
}

async function loadProfileWorkflows(input: {
  store: SqliteStore;
  storeDir: string;
  ref: OpenPondProfileRef;
  profile: OpenPondProfileState;
  reloadProfile?: () => Promise<OpenPondProfileState>;
  workspaceId: string;
}) {
  const sourceRevision = input.profile.git!.head!;
  const release = await ensureExplicitProfileHarnessSource({
    store: input.store,
    storeDir: input.storeDir,
    workspaceId: input.workspaceId,
    ownerId: DESKTOP_PERSONAL_HARNESS_OWNER_ID,
    name: input.profile.activeProfile!,
    profile: input.profile,
    sourceRevision,
  });
  const releaseRef = { id: release.harnessRelease.id, contentHash: release.harnessRelease.contentHash };
  const { runtime, catalog, catalogHash } = await loadLocalProfileWorkflowCatalog(input.store, releaseRef);
  const provenance = runtime.release.harnessRelease.metadata.profile;
  if (!provenance || typeof provenance !== "object" ||
      (provenance as Record<string, unknown>).id !== input.ref.profileId ||
      (provenance as Record<string, unknown>).sourceRevision !== sourceRevision) {
    throw new Error("Selected Profile workflow release differs from its Git source.");
  }
  if (input.reloadProfile) {
    const refreshed = await input.reloadProfile();
    if (refreshed.git?.head !== sourceRevision || refreshed.git.dirty) {
      throw new Error("Profile source changed during workflow loading; retry from its committed revision.");
    }
  }
  return {
    profileRef: input.ref,
    sourceRevision,
    harnessRelease: releaseRef,
    workflows: catalog.workflows.map((workflow) => ({
      workflow,
      binding: {
        schemaVersion: "openpond.profileWorkflowBinding.v1" as const,
        profileId: input.ref.profileId,
        sourceRevision,
        harnessRelease: releaseRef,
        catalogHash,
        workflowId: workflow.id,
      },
    })),
  };
}

export async function loadLocalHarnessRuntimeForSession(store: SqliteStore, session: Session): Promise<
  (SelectedLocalHarnessRuntime & { workflow?: ProfileWorkflow; workflowAction?: ProfileWorkflowAction }) | null
> {
  if (!session.profileWorkflowBinding) return loadLocalHarnessRuntimeForAgentRun(store, session.id);
  if (session.currentProfile?.profileId !== session.profileWorkflowBinding.profileId) {
    throw new Error("Profile workflow binding differs from the session Profile reference.");
  }
  const { runtime, workflow, action } = await loadLocalProfileWorkflowRuntime({ store, binding: session.profileWorkflowBinding });
  return { ...runtime, workflow, ...(action ? { workflowAction: action } : {}) };
}

/** A workflow session admits the release named by its binding, never the
 * process's movable personal Harness selection. */
export async function loadLocalProfileWorkflowRuntime(input: {
  store: SqliteStore;
  binding: ProfileWorkflowBinding;
}): Promise<{ runtime: SelectedLocalHarnessRuntime; workflow: ProfileWorkflow; action?: ProfileWorkflowAction }> {
  const { runtime, catalog, catalogHash, actions } = await loadLocalProfileWorkflowCatalog(input.store, input.binding.harnessRelease);
  const workflow = resolveReleasedProfileWorkflowCatalogBinding({
    binding: input.binding,
    harnessRelease: runtime.release.harnessRelease,
    catalog,
    catalogHash,
  });
  const actionId = workflow.invocation.kind === "agent_action" ? workflow.invocation.actionId : null;
  const action = actionId
    ? actions.find((candidate) => candidate.id === actionId)
    : undefined;
  if (actionId && !action) {
    throw new Error(`Bound Profile action ${actionId} is missing from its release.`);
  }
  return { runtime, workflow, ...(action ? { action } : {}) };
}

export async function loadLocalProfileWorkflowCatalog(
  store: SqliteStore,
  reference: { id: string; contentHash: string },
): Promise<{
  runtime: SelectedLocalHarnessRuntime;
  catalog: ProfileWorkflowCatalog;
  catalogHash: string;
  actions: ProfileWorkflowAction[];
}> {
  const runtime = await loadSelectedLocalHarnessRuntime(store, reference);
  if (!runtime) throw new Error("The bound Profile workflow Harness release is unavailable.");
  const sourceRoot = path.join(runtime.release.bundlePath, "source");
  const [catalogBytes, actionBytes] = await Promise.all([
    fs.readFile(path.join(sourceRoot, "workflows", "catalog.json")),
    fs.readFile(path.join(sourceRoot, "workflows", "actions.json")),
  ]);
  const { catalog, catalogHash, actions } = loadReleasedProfileWorkflowCatalogAssets({
    agentSnapshot: runtime.release.agentSnapshot,
    harnessRelease: runtime.release.harnessRelease,
    catalogBytes,
    actionBytes,
  });
  return { runtime, catalog, catalogHash, actions };
}
