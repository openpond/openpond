import type {
  ManagedAdapterServingProjection,
  ModelArtifactLineage,
  ModelBinding,
  TrainingArtifact,
} from "@openpond/contracts";
import { managedAdapterProjectionReady } from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import {
  type ManagedAdapterRegistryClient,
  type ManagedRegistryBaseProfile,
  type ManagedRegistryArtifact,
  type ManagedRegistryDeployment,
} from "./managed-adapter-registry-client.js";
import { resolveManagedRlBaseProfile } from "./managed-rl-base-profile.js";

const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const ARTIFACT_STATES = new Set([
  "imported_unvalidated",
  "evaluating",
  "promotable",
  "rejected",
  "deleted",
]);
const DEPLOYMENT_STATES = new Set([
  "requested",
  "deploying",
  "ready",
  "degraded",
  "deleting",
  "deleted",
  "failed",
]);

export function createManagedAdapterSyncService(dependencies: {
  store: SqliteStore;
  client: ManagedAdapterRegistryClient;
  resolveSelectedTeamId: () => Promise<string | null>;
  intervalMs?: number;
  now?: () => Date;
}) {
  const now = dependencies.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | null = null;
  let active: Promise<void> | null = null;
  let closed = false;

  async function reconcile(): Promise<void> {
    if (active) return active;
    active = reconcileOnce(
      dependencies.store,
      dependencies.client,
      dependencies.resolveSelectedTeamId,
      now,
    )
      .catch(() => undefined)
      .finally(() => {
        active = null;
      });
    return active;
  }

  function start(): void {
    if (timer || closed) return;
    void reconcile();
    timer = setInterval(
      () => void reconcile(),
      dependencies.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
    );
    timer.unref?.();
  }

  async function close(): Promise<void> {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    await active;
  }

  async function deactivateBinding(
    binding: ModelBinding,
    sourceUpdatedAt: string,
  ): Promise<number | null> {
    const target = await managedBindingTarget(dependencies.store, binding);
    if (!target) return null;
    const bindingVersion = managedBindingProjectionVersion(binding) + 1;
    await dependencies.client.syncBinding({
      teamId: target.teamId,
      binding,
      logicalModelName: managedBindingLogicalModelName(binding),
      artifactId: target.artifactId,
      deploymentId: target.deploymentId,
      bindingVersion,
      sourceUpdatedAt,
      state: "inactive",
    });
    return bindingVersion;
  }

  async function reactivateBinding(
    binding: ModelBinding,
    sourceUpdatedAt: string,
  ): Promise<number | null> {
    const target = await managedBindingTarget(dependencies.store, binding);
    if (!target) return null;
    const bindingVersion = managedBindingProjectionVersion(binding) + 1;
    await dependencies.client.syncBinding({
      teamId: target.teamId,
      binding,
      logicalModelName: managedBindingLogicalModelName(binding),
      artifactId: target.artifactId,
      deploymentId: target.deploymentId,
      bindingVersion,
      sourceUpdatedAt,
      state: "active",
    });
    return bindingVersion;
  }

  async function activateBinding(binding: ModelBinding): Promise<void> {
    const target = await managedBindingTarget(dependencies.store, binding);
    if (!target) return;
    await dependencies.client.syncBinding({
      teamId: target.teamId,
      binding,
      logicalModelName: managedBindingLogicalModelName(binding),
      artifactId: target.artifactId,
      deploymentId: target.deploymentId,
      bindingVersion: managedBindingProjectionVersion(binding),
      sourceUpdatedAt: binding.promotedAt,
      state: "active",
    });
  }

  return {
    start,
    close,
    reconcile,
    deactivateBinding,
    reactivateBinding,
    activateBinding,
  };
}

export type ManagedAdapterSyncService = ReturnType<typeof createManagedAdapterSyncService>;

export function managedBindingLogicalModelName(binding: {
  profileId: string;
  role: string;
  roleTargetId: string;
}): string {
  return `trained-${contentHash([binding.profileId, binding.role, binding.roleTargetId]).slice(
    0,
    32,
  )}`;
}

async function reconcileOnce(
  store: SqliteStore,
  client: ManagedAdapterRegistryClient,
  resolveSelectedTeamId: () => Promise<string | null>,
  now: () => Date,
): Promise<void> {
  const selectedTeamId = (await resolveSelectedTeamId())?.trim() || null;
  const registries = new Map<
    string,
    Promise<{
      artifacts: ManagedRegistryArtifact[];
      deployments: ManagedRegistryDeployment[];
    }>
  >();
  const capabilitySets = new Map<string, Promise<ManagedRegistryBaseProfile[]>>();
  const registryForTeam = (teamId: string) => {
    const registryKey = `user:${teamId}`;
    let registry = registries.get(registryKey);
    if (!registry) {
      registry = client.listRegistry(teamId).then((value) => ({
        artifacts: [...value.artifacts],
        deployments: [...value.deployments],
      }));
      registries.set(registryKey, registry);
    }
    return registry;
  };
  const baseProfilesForTeam = (teamId: string) => {
    const key = `user:${teamId}`;
    let capabilities = capabilitySets.get(key);
    if (!capabilities) {
      capabilities = client.capabilities(teamId).then((value) => value.baseProfiles);
      capabilitySets.set(key, capabilities);
    }
    return capabilities;
  };
  const lineages = await store.listModelArtifactLineage();
  for (const lineage of lineages) {
    await reconcileLineage({
      store,
      client,
      lineage,
      selectedTeamId,
      registryForTeam,
      baseProfilesForTeam,
      now,
    });
  }
  const bindings = await store.listModelBindings();
  for (const binding of bindings) {
    try {
      const target = await managedBindingTarget(store, binding);
      if (!target) continue;
      await client.syncBinding({
        teamId: target.teamId,
        binding,
        logicalModelName: managedBindingLogicalModelName(binding),
        artifactId: target.artifactId,
        deploymentId: target.deploymentId,
        bindingVersion: managedBindingProjectionVersion(binding),
        sourceUpdatedAt:
          binding.status === "active"
            ? binding.promotedAt
            : (binding.rolledBackAt ?? binding.promotedAt),
        state: binding.status === "active" ? "active" : "inactive",
      });
    } catch {
      // The periodic pass is best-effort. Explicit binding transitions fail
      // closed through deactivateBinding before local authority changes.
    }
  }
}

export function managedBindingProjectionVersion(binding: ModelBinding): number {
  const value = binding.metadata.managedProjectionVersion;
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647
    ? value
    : 1;
}

async function reconcileLineage(input: {
  store: SqliteStore;
  client: ManagedAdapterRegistryClient;
  lineage: ModelArtifactLineage;
  selectedTeamId: string | null;
  registryForTeam: (teamId: string) => Promise<{
    artifacts: ManagedRegistryArtifact[];
    deployments: ManagedRegistryDeployment[];
  }>;
  baseProfilesForTeam: (teamId: string) => Promise<ManagedRegistryBaseProfile[]>;
  now: () => Date;
}): Promise<void> {
  const jobArtifacts = await input.store.listTrainingArtifacts(input.lineage.jobId);
  const source = lineageSource(input.lineage, jobArtifacts);
  if (!source) return;
  const managedRlJobId = sandboxManagedJobId(jobArtifacts);
  const timestamp = input.now().toISOString();
  const teamId = input.lineage.managedServing?.canonicalArtifactId
    ? input.lineage.managedServing.teamId
    : (sandboxManagedTeamId(jobArtifacts) ?? input.selectedTeamId);
  try {
    if (!teamId) {
      throw new Error("Select an OpenPond team before reconciling managed adapters.");
    }
    const baseProfiles = await input.baseProfilesForTeam(teamId);
    assertQualifiedManagedBase(jobArtifacts, baseProfiles);
    const registry = await input.registryForTeam(teamId);
    let artifact =
      registry.artifacts.find(
        (candidate) => candidate.id === input.lineage.managedServing?.canonicalArtifactId,
      ) ??
      registry.artifacts.find(
        (candidate) =>
          candidate.source === source &&
          Boolean(
            managedRlJobId &&
            candidate.sourceRef.endsWith(`/jobs/${managedRlJobId}/candidate.json`),
          ),
      );
    if (!artifact) {
      throw new Error(
        "Sandbox has not finished canonical publication for this managed training job.",
      );
    }
    const deployment =
      registry.deployments.find(
        (candidate) =>
          candidate.artifactId === artifact.id && !["deleted", "failed"].includes(candidate.state),
      ) ??
      registry.deployments.find((candidate) => candidate.artifactId === artifact.id) ??
      null;
    const ready =
      artifact.state === "promotable" &&
      artifact.promotable &&
      artifact.customerBindingAllowed &&
      deployment?.state === "ready";
    await saveProjection(input.store, input.lineage, {
      schemaVersion: "openpond.managedAdapterServingProjection.v1",
      teamId,
      source,
      sourceRef: managedRlJobId ?? input.lineage.id,
      canonicalArtifactId: artifact.id,
      canonicalArtifactState: artifactState(artifact.state),
      canonicalDeploymentId: deployment?.id ?? null,
      canonicalDeploymentState: deploymentState(deployment?.state),
      state: ready ? "ready" : "imported",
      customerBindingAllowed: artifact.customerBindingAllowed,
      artifactContentHash:
        artifact.contentHash ?? input.lineage.managedServing?.artifactContentHash ?? null,
      baseProfileId: artifact.baseProfileId ?? input.lineage.managedServing?.baseProfileId ?? null,
      publishedAt: input.lineage.managedServing?.publishedAt ?? timestamp,
      lastSyncedAt: timestamp,
      lastError: null,
    });
  } catch (error) {
    await saveProjection(input.store, input.lineage, {
      schemaVersion: "openpond.managedAdapterServingProjection.v1",
      teamId,
      source,
      sourceRef: managedRlJobId ?? input.lineage.id,
      canonicalArtifactId: input.lineage.managedServing?.canonicalArtifactId ?? null,
      canonicalArtifactState: input.lineage.managedServing?.canonicalArtifactState ?? null,
      canonicalDeploymentId: input.lineage.managedServing?.canonicalDeploymentId ?? null,
      canonicalDeploymentState: input.lineage.managedServing?.canonicalDeploymentState ?? null,
      state: "failed",
      customerBindingAllowed: input.lineage.managedServing?.customerBindingAllowed ?? false,
      artifactContentHash: input.lineage.managedServing?.artifactContentHash ?? null,
      baseProfileId: input.lineage.managedServing?.baseProfileId ?? null,
      publishedAt: input.lineage.managedServing?.publishedAt ?? null,
      lastSyncedAt: timestamp,
      lastError: safeError(error),
    });
  }
}

async function managedBindingTarget(
  store: SqliteStore,
  binding: ModelBinding,
): Promise<{
  teamId: string;
  artifactId: string;
  deploymentId: string;
} | null> {
  const lineage = await store.getModelArtifactLineage(binding.modelArtifactLineageId);
  const projection = lineage?.managedServing;
  if (
    !projection ||
    !managedAdapterProjectionReady(projection) ||
    !projection.teamId ||
    !projection.canonicalArtifactId ||
    !projection.canonicalDeploymentId
  ) {
    return null;
  }
  return {
    teamId: projection.teamId,
    artifactId: projection.canonicalArtifactId,
    deploymentId: projection.canonicalDeploymentId,
  };
}

type ManagedLineageSource = "sandbox_managed_rl";

function lineageSource(
  lineage: ModelArtifactLineage,
  artifacts: TrainingArtifact[],
): ManagedLineageSource | null {
  if (
    lineage.status === "imported" &&
    artifacts.some((artifact) => artifact.metadata.provider === "sandbox")
  )
    return "sandbox_managed_rl";
  return null;
}

function assertQualifiedManagedBase(
  artifacts: TrainingArtifact[],
  baseProfiles: ManagedRegistryBaseProfile[],
): string {
  const qualifiedArtifacts = artifacts.filter(
    (artifact) =>
      artifact.metadata.provider === "sandbox" && artifact.metadata.managedRlCandidate === true,
  );
  if (qualifiedArtifacts.length < 1) {
    throw new Error("sandbox_managed_rl lineage has no managed adapter candidate.");
  }
  const firstArtifact = qualifiedArtifacts[0]!;
  const openPondProfile = resolveManagedRlBaseProfile({
    schemaVersion: "openpond.baseModelPreference.v1",
    modelId: firstArtifact.baseModelId ?? "",
    revision: firstArtifact.baseModelRevision,
    tokenizerRevision: firstArtifact.tokenizerRevision,
    chatTemplateHash: firstArtifact.chatTemplateHash,
    modelAssetId: null,
    source: "managed",
  });
  if (!openPondProfile) {
    throw new Error(
      "sandbox_managed_rl adapter does not match the qualified Qwen3 managed-training identity.",
    );
  }
  const expected = {
    model: openPondProfile.modelId,
    revision: openPondProfile.revision,
    tokenizerRevision: openPondProfile.tokenizerRevision,
    chatTemplateHash: openPondProfile.chatTemplateHash,
  };
  const matchedProfile = baseProfiles.find(
    (profile) =>
      profile.status === "qualified" &&
      profile.repository === expected.model &&
      profile.revision === expected.revision &&
      profile.tokenizerRevision === expected.tokenizerRevision &&
      profile.chatTemplateHash === expected.chatTemplateHash,
  );
  if (!matchedProfile) {
    throw new Error("sandbox_managed_rl adapter does not match a Sandbox-qualified base profile.");
  }
  for (const artifact of qualifiedArtifacts) {
    if (
      artifact.baseModelId !== expected.model ||
      artifact.baseModelRevision !== expected.revision ||
      artifact.tokenizerRevision !== expected.tokenizerRevision ||
      artifact.chatTemplateHash !== expected.chatTemplateHash
    ) {
      throw new Error(
        `sandbox_managed_rl adapter does not match the pinned ${expected.model} serving identity.`,
      );
    }
  }
  return matchedProfile.id;
}

function sandboxManagedJobId(artifacts: TrainingArtifact[]): string | null {
  const value = artifacts.find((artifact) => artifact.metadata.managedRlCandidate === true)
    ?.metadata.managedRlJobId;
  return typeof value === "string" && value.trim() ? value : null;
}

function sandboxManagedTeamId(artifacts: TrainingArtifact[]): string | null {
  const value = artifacts.find((artifact) => artifact.metadata.managedRlCandidate === true)
    ?.metadata.managedRlTeamId;
  return typeof value === "string" && value.trim() ? value : null;
}

async function saveProjection(
  store: SqliteStore,
  lineage: ModelArtifactLineage,
  projection: ManagedAdapterServingProjection,
): Promise<void> {
  await store.saveModelArtifactLineage({
    ...lineage,
    managedServing: projection,
  });
}

function artifactState(
  value: string | undefined,
): ManagedAdapterServingProjection["canonicalArtifactState"] {
  return value && ARTIFACT_STATES.has(value)
    ? (value as ManagedAdapterServingProjection["canonicalArtifactState"])
    : null;
}

function deploymentState(
  value: string | undefined,
): ManagedAdapterServingProjection["canonicalDeploymentState"] {
  return value && DEPLOYMENT_STATES.has(value)
    ? (value as ManagedAdapterServingProjection["canonicalDeploymentState"])
    : null;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 5_000) || "Managed adapter reconciliation failed.";
}
