import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { HOST_STORAGE_CONTRACT_VERSION, type AgentHostStorageClient } from "@openpond/agent-runtime";
import { HarnessWorkspaceSchema, type Session } from "@openpond/contracts";
import {
  AgentSnapshotSchema, HarnessReleaseSchema,
  loadReleasedProfileWorkflowCatalogAssets,
  resolveReleasedProfileWorkflowCatalogBinding,
} from "@openpond/harness";
import { z } from "zod";

import { loadLocalHarnessRuntimeFromRelease } from "../harness/local-harness-skill-runtime.js";
import { LocalHarnessReleaseRecordSchema } from "./store-harness-release-record.js";
import { HostedHarnessOverlayStorage } from "./hosted-harness-overlay-storage.js";

const boundReleaseSchema = z.object({
  workspace: HarnessWorkspaceSchema,
  release: z.object({
    id: z.string().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRevision: z.string().min(1),
    assetsPath: z.string().min(1),
  }).strict(),
}).strict();

/** Load the host-admitted immutable Harness release from verified materialized assets. */
export async function loadHostedHarnessRuntime(
  client: AgentHostStorageClient,
  reference: { id: string; contentHash: string } | null = null,
) {
  const raw = await client.request({
    contractVersion: HOST_STORAGE_CONTRACT_VERSION,
    requestId: randomUUID(),
    operation: "harness/get",
    params: { reference },
  });
  if (raw === null) return null;
  const bound = boundReleaseSchema.parse(raw);
  if (!path.isAbsolute(bound.release.assetsPath)) {
    throw new Error("Hosted Harness assets path must be absolute.");
  }
  const [snapshotRaw, releaseRaw] = await Promise.all([
    readFile(path.join(bound.release.assetsPath, "agent-snapshot.json"), "utf8"),
    readFile(path.join(bound.release.assetsPath, "harness-release.json"), "utf8"),
  ]);
  const release = LocalHarnessReleaseRecordSchema.parse({
    schemaVersion: "openpond.localHarnessReleaseRecord.v1",
    workspaceId: bound.workspace.id,
    sourceRevision: bound.release.sourceRevision,
    agentSnapshot: AgentSnapshotSchema.parse(JSON.parse(snapshotRaw)),
    harnessRelease: HarnessReleaseSchema.parse(JSON.parse(releaseRaw)),
    bundlePath: bound.release.assetsPath,
    createdAt: new Date().toISOString(),
  });
  if (release.harnessRelease.id !== bound.release.id ||
      release.harnessRelease.contentHash !== bound.release.contentHash ||
      (reference !== null
        ? reference.id !== bound.release.id || reference.contentHash !== bound.release.contentHash
        : bound.workspace.currentChannel.release?.contentHash !== bound.release.contentHash)) {
    throw new Error("Hosted Harness release differs from its bound workspace.");
  }
  return loadLocalHarnessRuntimeFromRelease({ workspace: bound.workspace, release });
}

/** Session binding chooses an immutable release; an overlay pins ordinary Agent runs. */
export async function loadHostedHarnessRuntimeForSession(client: AgentHostStorageClient, session: Session) {
  const component = session.profileComponentBinding;
  const workflow = session.profileWorkflowBinding;
  if (component) {
    if (workflow || session.currentProfile?.profileId !== component.profileId) {
      throw new Error("Profile component binding differs from the session Profile reference.");
    }
    const runtime = await requireRelease(client, component.harnessRelease);
    assertProfileProvenance(runtime, component.profileId, component.sourceRevision,
      session.currentProfile?.repositoryId);
    if (component.target.kind === "profile") return runtime;
    if (component.target.kind === "skill") {
      const skillPath = component.target.skillPath;
      if (!runtime.release.agentSnapshot.skills.some((skill) => skill.path === skillPath)) {
        throw new Error("Bound Profile Skill is unavailable in its released source.");
      }
      const markdown = await readFile(path.join(runtime.release.bundlePath, "source", skillPath), "utf8");
      return { ...runtime, instructionContext: [
        runtime.instructionContext,
        `Released Profile Skill (${skillPath}):\n${markdown}`,
      ].join("\n\n") };
    }
    const catalog = await loadHostedProfileCatalog(runtime);
    const actionId = component.target.actionId;
    const action = catalog.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw new Error("Bound Profile Agent action is unavailable in its released source.");
    return { ...runtime, workflowAction: action };
  }
  if (workflow) {
    if (session.currentProfile?.profileId !== workflow.profileId) {
      throw new Error("Profile workflow binding differs from the session Profile reference.");
    }
    const runtime = await requireRelease(client, workflow.harnessRelease);
    assertProfileProvenance(runtime, workflow.profileId, workflow.sourceRevision,
      session.currentProfile?.repositoryId);
    const catalog = await loadHostedProfileCatalog(runtime);
    const selected = resolveReleasedProfileWorkflowCatalogBinding({
      binding: workflow,
      harnessRelease: runtime.release.harnessRelease,
      catalog: catalog.catalog,
      catalogHash: catalog.catalogHash,
    });
    const actionId = selected.invocation.kind === "agent_action" ? selected.invocation.actionId : null;
    const action = actionId ? catalog.actions.find((candidate) => candidate.id === actionId) : undefined;
    if (actionId && !action) throw new Error(`Bound Profile action ${actionId} is missing from its release.`);
    return { ...runtime, workflow: selected, ...(action ? { workflowAction: action } : {}) };
  }
  const overlay = await new HostedHarnessOverlayStorage(client).getHarnessRunOverlay(session.id);
  return loadHostedHarnessRuntime(client, overlay?.baseHarnessRelease ?? null);
}

async function requireRelease(client: AgentHostStorageClient, reference: { id: string; contentHash: string }) {
  const runtime = await loadHostedHarnessRuntime(client, reference);
  if (!runtime) throw new Error("The bound Profile Harness release is unavailable.");
  return runtime;
}

function assertProfileProvenance(
  runtime: NonNullable<Awaited<ReturnType<typeof loadHostedHarnessRuntime>>>,
  profileId: string,
  sourceRevision: string,
  repositoryId: string | undefined,
): void {
  const provenance = runtime.release.harnessRelease.metadata.profile;
  if (!provenance || typeof provenance !== "object" ||
      (provenance as Record<string, unknown>).id !== profileId ||
      (provenance as Record<string, unknown>).sourceRevision !== sourceRevision ||
      ((provenance as Record<string, unknown>).repositoryId !== undefined &&
        (provenance as Record<string, unknown>).repositoryId !== repositoryId)) {
    throw new Error("Bound Profile source differs from its released Harness source.");
  }
}

async function loadHostedProfileCatalog(runtime: NonNullable<Awaited<ReturnType<typeof loadHostedHarnessRuntime>>>) {
  const root = path.join(runtime.release.bundlePath, "source");
  const [catalogBytes, actionBytes] = await Promise.all([
    readFile(path.join(root, "workflows", "catalog.json")),
    readFile(path.join(root, "workflows", "actions.json")),
  ]);
  return loadReleasedProfileWorkflowCatalogAssets({
    agentSnapshot: runtime.release.agentSnapshot,
    harnessRelease: runtime.release.harnessRelease,
    catalogBytes, actionBytes,
  });
}
