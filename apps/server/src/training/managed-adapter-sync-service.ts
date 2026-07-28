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
import { resolveManagedRftBaseProfile } from "./managed-rft-base-profile.js";
import { selectPortableModelArtifacts } from "./training-artifact-package.js";

const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const PORTABLE_ADAPTER_PATTERN =
  /^adapter_model(?:-\d{5}-of-\d{5})?\.safetensors$/;
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
      now
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
      dependencies.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
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
    sourceUpdatedAt: string
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
    sourceUpdatedAt: string
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

export type ManagedAdapterSyncService = ReturnType<
  typeof createManagedAdapterSyncService
>;

export function managedBindingLogicalModelName(binding: {
  profileId: string;
  role: string;
  roleTargetId: string;
}): string {
  return `trained-${contentHash([
    binding.profileId,
    binding.role,
    binding.roleTargetId,
  ]).slice(0, 32)}`;
}

async function reconcileOnce(
  store: SqliteStore,
  client: ManagedAdapterRegistryClient,
  resolveSelectedTeamId: () => Promise<string | null>,
  now: () => Date
): Promise<void> {
  const selectedTeamId = (await resolveSelectedTeamId())?.trim() || null;
  const registries = new Map<
    string,
    Promise<{
      artifacts: ManagedRegistryArtifact[];
      deployments: ManagedRegistryDeployment[];
    }>
  >();
  const capabilitySets = new Map<
    string,
    Promise<ManagedRegistryBaseProfile[]>
  >();
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
  const baseProfilesForTeam = (
    teamId: string
  ) => {
    const key = `user:${teamId}`;
    let capabilities = capabilitySets.get(key);
    if (!capabilities) {
      capabilities = client.capabilities(teamId).then(
        (value) => value.baseProfiles
      );
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
            : binding.rolledBackAt ?? binding.promotedAt,
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
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 2_147_483_647
    ? value
    : 1;
}

async function reconcileLineage(input: {
  store: SqliteStore;
  client: ManagedAdapterRegistryClient;
  lineage: ModelArtifactLineage;
  selectedTeamId: string | null;
  registryForTeam: (
    teamId: string
  ) => Promise<{
    artifacts: ManagedRegistryArtifact[];
    deployments: ManagedRegistryDeployment[];
  }>;
  baseProfilesForTeam: (
    teamId: string
  ) => Promise<ManagedRegistryBaseProfile[]>;
  now: () => Date;
}): Promise<void> {
  const jobArtifacts = await input.store.listTrainingArtifacts(
    input.lineage.jobId
  );
  const source = lineageSource(input.lineage, jobArtifacts);
  if (!source) return;
  const managedRftJobId =
    source === "sandbox_managed_rft"
      ? sandboxManagedJobId(jobArtifacts)
      : null;
  const timestamp = input.now().toISOString();
  const teamId = input.lineage.managedServing?.canonicalArtifactId
    ? input.lineage.managedServing.teamId
    : sandboxManagedTeamId(jobArtifacts) ?? input.selectedTeamId;
  try {
    if (!teamId) {
      throw new Error(
        "Select an OpenPond team before reconciling managed adapters."
      );
    }
    const baseProfileId = assertQualifiedBase(
      source,
      jobArtifacts,
      await input.baseProfilesForTeam(teamId)
    );
    const registry = await input.registryForTeam(teamId);
    let artifact =
      registry.artifacts.find(
        (candidate) =>
          candidate.id === input.lineage.managedServing?.canonicalArtifactId
      ) ??
      registry.artifacts.find(
        (candidate) =>
          candidate.source === source &&
          (source === "sandbox_managed_rft"
            ? Boolean(
                managedRftJobId &&
                  candidate.sourceRef.endsWith(
                    `/jobs/${managedRftJobId}/candidate.json`
                  )
              )
            : candidate.sourceRef === input.lineage.id)
      );
    if (!artifact) {
      if (source === "sandbox_managed_rft") {
        throw new Error(
          "Sandbox has not finished canonical publication for this managed training job."
        );
      }
      const job = await input.store.getTrainingJob(input.lineage.jobId);
      if (!job) throw new Error(`${source} lineage lost its training job.`);
      const plan = await input.store.getTrainingPlan(job.planId);
      if (!plan) throw new Error(`${source} lineage lost its training plan.`);
      const sourceArtifact = await input.store.getTrainingArtifact(
        input.lineage.artifactId
      );
      if (!sourceArtifact) {
        throw new Error(`${source} lineage lost its source adapter artifact.`);
      }
      const evaluation = input.lineage.frozenEvaluationArtifactId
        ? await input.store.getTrainingArtifact(
            input.lineage.frozenEvaluationArtifactId
          )
        : null;
      const files = portableUploadFiles(jobArtifacts);
      artifact = await input.client.publishFireworksSource({
        teamId,
        lineageId: input.lineage.id,
        label: `OpenPond Fireworks ${input.lineage.id.slice(-12)}`,
        baseProfileId,
        trainingJobId: job.id,
        trainingPlanId: plan.id,
        sourceArtifactId: sourceArtifact.id,
        sourceArtifactSha256: sourceArtifact.sha256,
        tasksetId: input.lineage.tasksetId,
        tasksetHash: input.lineage.tasksetHash,
        evaluationArtifactId: evaluation?.id ?? null,
        evaluationArtifactSha256: evaluation?.sha256 ?? null,
        providerRunId:
          typeof job.metadata.providerJobId === "string"
            ? job.metadata.providerJobId
            : null,
        files,
      });
      registry.artifacts.push(artifact);
    }
    const deployment =
      registry.deployments.find(
        (candidate) =>
          candidate.artifactId === artifact!.id &&
          !["deleted", "failed"].includes(candidate.state)
      ) ??
      registry.deployments.find(
        (candidate) => candidate.artifactId === artifact!.id
      ) ??
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
      sourceRef: managedRftJobId ?? input.lineage.id,
      canonicalArtifactId: artifact.id,
      canonicalArtifactState: artifactState(artifact.state),
      canonicalDeploymentId: deployment?.id ?? null,
      canonicalDeploymentState: deploymentState(deployment?.state),
      state: ready ? "ready" : "imported",
      customerBindingAllowed: artifact.customerBindingAllowed,
      artifactContentHash:
        artifact.contentHash ??
        input.lineage.managedServing?.artifactContentHash ??
        null,
      baseProfileId:
        artifact.baseProfileId ??
        input.lineage.managedServing?.baseProfileId ??
        null,
      publishedAt: input.lineage.managedServing?.publishedAt ?? timestamp,
      lastSyncedAt: timestamp,
      lastError: null,
    });
  } catch (error) {
    await saveProjection(input.store, input.lineage, {
      schemaVersion: "openpond.managedAdapterServingProjection.v1",
      teamId,
      source,
      sourceRef: managedRftJobId ?? input.lineage.id,
      canonicalArtifactId:
        input.lineage.managedServing?.canonicalArtifactId ?? null,
      canonicalArtifactState:
        input.lineage.managedServing?.canonicalArtifactState ?? null,
      canonicalDeploymentId:
        input.lineage.managedServing?.canonicalDeploymentId ?? null,
      canonicalDeploymentState:
        input.lineage.managedServing?.canonicalDeploymentState ?? null,
      state: "failed",
      customerBindingAllowed:
        input.lineage.managedServing?.customerBindingAllowed ?? false,
      artifactContentHash:
        input.lineage.managedServing?.artifactContentHash ?? null,
      baseProfileId: input.lineage.managedServing?.baseProfileId ?? null,
      publishedAt: input.lineage.managedServing?.publishedAt ?? null,
      lastSyncedAt: timestamp,
      lastError: safeError(error),
    });
  }
}

async function managedBindingTarget(
  store: SqliteStore,
  binding: ModelBinding
): Promise<{
  teamId: string;
  artifactId: string;
  deploymentId: string;
} | null> {
  const lineage = await store.getModelArtifactLineage(
    binding.modelArtifactLineageId
  );
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

function portableUploadFiles(artifacts: TrainingArtifact[]) {
  return selectPortableModelArtifacts(artifacts)
    .filter(
      ({ name }) =>
        name === "adapter_config.json" ||
        name === "adapter_model.safetensors.index.json" ||
        PORTABLE_ADAPTER_PATTERN.test(name)
    )
    .map(({ artifact, name }) => ({
      artifact,
      path: name,
      mediaType: name.endsWith(".json")
        ? ("application/json" as const)
        : ("application/vnd.safetensors" as const),
    }));
}

type ManagedLineageSource =
  | "openpond_fireworks"
  | "sandbox_managed_rft";

function lineageSource(
  lineage: ModelArtifactLineage,
  artifacts: TrainingArtifact[]
): ManagedLineageSource | null {
  if (
    lineage.status === "imported" &&
    artifacts.some((artifact) => artifact.metadata.provider === "sandbox")
  ) return "sandbox_managed_rft";
  return artifacts.some(
    (artifact) => artifact.metadata.provider === "fireworks"
  )
    ? "openpond_fireworks"
    : null;
}

function assertQualifiedBase(
  source: ManagedLineageSource,
  artifacts: TrainingArtifact[],
  baseProfiles: ManagedRegistryBaseProfile[]
): string {
  const qualifiedArtifacts =
    source === "sandbox_managed_rft"
      ? artifacts.filter(
          (artifact) =>
            artifact.metadata.provider === "sandbox" &&
            artifact.metadata.managedRftCandidate === true
        )
      : portableUploadFiles(artifacts).map(({ artifact }) => artifact);
  if (
    qualifiedArtifacts.length <
      (source === "sandbox_managed_rft" ? 1 : 2)
  ) {
    throw new Error(`${source} lineage has no complete portable adapter.`);
  }
  const firstArtifact = qualifiedArtifacts[0]!;
  const openPondProfile =
    source === "sandbox_managed_rft"
      ? resolveManagedRftBaseProfile({
          schemaVersion: "openpond.baseModelPreference.v1",
          modelId: firstArtifact.baseModelId ?? "",
          revision: firstArtifact.baseModelRevision,
          tokenizerRevision: firstArtifact.tokenizerRevision,
          chatTemplateHash: firstArtifact.chatTemplateHash,
          modelAssetId: null,
          source: "managed",
        })
      : null;
  if (source === "sandbox_managed_rft" && !openPondProfile) {
    throw new Error(
      "sandbox_managed_rft adapter does not match the qualified Qwen3 managed-training identity."
    );
  }
  const expected = openPondProfile
    ? {
        model: openPondProfile.modelId,
        revision: openPondProfile.revision,
        tokenizerRevision: openPondProfile.tokenizerRevision,
        chatTemplateHash: openPondProfile.chatTemplateHash,
      }
    : {
        model: firstArtifact.baseModelId ?? "",
        revision: firstArtifact.baseModelRevision,
        tokenizerRevision: firstArtifact.tokenizerRevision,
        chatTemplateHash: firstArtifact.chatTemplateHash,
      };
  const matchedProfile = baseProfiles.find(
    (profile) =>
      profile.status === "qualified" &&
      profile.repository === expected.model &&
      profile.revision === expected.revision &&
      profile.tokenizerRevision === expected.tokenizerRevision &&
      profile.chatTemplateHash === expected.chatTemplateHash
  );
  if (!matchedProfile) {
    throw new Error(
      `${source} adapter does not match a Sandbox-qualified base profile.`
    );
  }
  for (const artifact of qualifiedArtifacts) {
    if (
      artifact.baseModelId !== expected.model ||
      artifact.baseModelRevision !== expected.revision ||
      artifact.tokenizerRevision !== expected.tokenizerRevision ||
      artifact.chatTemplateHash !== expected.chatTemplateHash
    ) {
      throw new Error(
        `${source} adapter does not match the pinned ${expected.model} serving identity.`
      );
    }
  }
  return matchedProfile.id;
}

function sandboxManagedJobId(
  artifacts: TrainingArtifact[]
): string | null {
  const value = artifacts.find(
    (artifact) => artifact.metadata.managedRftCandidate === true
  )?.metadata.managedRftJobId;
  return typeof value === "string" && value.trim() ? value : null;
}

function sandboxManagedTeamId(
  artifacts: TrainingArtifact[]
): string | null {
  const value = artifacts.find(
    (artifact) => artifact.metadata.managedRftCandidate === true
  )?.metadata.managedRftTeamId;
  return typeof value === "string" && value.trim() ? value : null;
}

async function saveProjection(
  store: SqliteStore,
  lineage: ModelArtifactLineage,
  projection: ManagedAdapterServingProjection
): Promise<void> {
  await store.saveModelArtifactLineage({
    ...lineage,
    managedServing: projection,
  });
}

function artifactState(
  value: string | undefined
): ManagedAdapterServingProjection["canonicalArtifactState"] {
  return value && ARTIFACT_STATES.has(value)
    ? (value as ManagedAdapterServingProjection["canonicalArtifactState"])
    : null;
}

function deploymentState(
  value: string | undefined
): ManagedAdapterServingProjection["canonicalDeploymentState"] {
  return value && DEPLOYMENT_STATES.has(value)
    ? (value as ManagedAdapterServingProjection["canonicalDeploymentState"])
    : null;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 5_000) || "Managed adapter reconciliation failed.";
}
