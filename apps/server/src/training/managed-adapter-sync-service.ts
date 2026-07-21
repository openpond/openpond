import type {
  ManagedAdapterServingProjection,
  ModelArtifactLineage,
  ModelBinding,
  TrainingArtifact,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import type { SqliteStore } from "../store/store.js";
import {
  MANAGED_QWEN3_8B_BASE_REVISION,
  type ManagedAdapterRegistryClient,
  type ManagedRegistryArtifact,
  type ManagedRegistryDeployment,
} from "./managed-adapter-registry-client.js";
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
  "provisioning",
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
  const registryForTeam = (teamId: string) => {
    let registry = registries.get(teamId);
    if (!registry) {
      registry = client.listRegistry(teamId).then((value) => ({
        artifacts: [...value.artifacts],
        deployments: [...value.deployments],
      }));
      registries.set(teamId, registry);
    }
    return registry;
  };
  const lineages = await store.listModelArtifactLineage();
  for (const lineage of lineages) {
    await reconcileLineage({
      store,
      client,
      lineage,
      selectedTeamId,
      registryForTeam,
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
  registryForTeam: (teamId: string) => Promise<{
    artifacts: ManagedRegistryArtifact[];
    deployments: ManagedRegistryDeployment[];
  }>;
  now: () => Date;
}): Promise<void> {
  const jobArtifacts = await input.store.listTrainingArtifacts(
    input.lineage.jobId,
  );
  if (!isFireworksLineage(jobArtifacts)) return;
  const timestamp = input.now().toISOString();
  const teamId =
    input.lineage.managedServing?.teamId ?? input.selectedTeamId;
  try {
    if (!teamId) {
      throw new Error(
        "Select an OpenPond team before publishing managed adapters.",
      );
    }
    assertQualifiedBase(jobArtifacts);
    const registry = await input.registryForTeam(teamId);
    let artifact =
      registry.artifacts.find(
        (candidate) =>
          candidate.id ===
          input.lineage.managedServing?.canonicalArtifactId,
      ) ??
      registry.artifacts.find(
        (candidate) =>
          candidate.source === "openpond_fireworks" &&
          candidate.sourceRef === input.lineage.id,
      );
    if (!artifact) {
      const job = await input.store.getTrainingJob(input.lineage.jobId);
      if (!job) throw new Error("Fireworks lineage lost its training job.");
      const plan = await input.store.getTrainingPlan(job.planId);
      if (!plan) throw new Error("Fireworks lineage lost its training plan.");
      const sourceArtifact = await input.store.getTrainingArtifact(
        input.lineage.artifactId,
      );
      if (!sourceArtifact) {
        throw new Error("Fireworks lineage lost its source adapter artifact.");
      }
      const evaluation = input.lineage.frozenEvaluationArtifactId
        ? await input.store.getTrainingArtifact(
            input.lineage.frozenEvaluationArtifactId,
          )
        : null;
      const files = portableUploadFiles(jobArtifacts);
      artifact = await input.client.publishFireworksSource({
        teamId,
        lineageId: input.lineage.id,
        label: `OpenPond Fireworks ${input.lineage.id.slice(-12)}`,
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
          !["deleted", "failed"].includes(candidate.state),
      ) ??
      registry.deployments.find(
        (candidate) => candidate.artifactId === artifact!.id,
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
      source: "openpond_fireworks",
      sourceRef: input.lineage.id,
      canonicalArtifactId: artifact.id,
      canonicalArtifactState: artifactState(artifact.state),
      canonicalDeploymentId: deployment?.id ?? null,
      canonicalDeploymentState: deploymentState(deployment?.state),
      state: ready ? "ready" : "imported",
      publishedAt: input.lineage.managedServing?.publishedAt ?? timestamp,
      lastSyncedAt: timestamp,
      lastError: null,
    });
  } catch (error) {
    await saveProjection(input.store, input.lineage, {
      schemaVersion: "openpond.managedAdapterServingProjection.v1",
      teamId,
      source: "openpond_fireworks",
      sourceRef: input.lineage.id,
      canonicalArtifactId:
        input.lineage.managedServing?.canonicalArtifactId ?? null,
      canonicalArtifactState:
        input.lineage.managedServing?.canonicalArtifactState ?? null,
      canonicalDeploymentId:
        input.lineage.managedServing?.canonicalDeploymentId ?? null,
      canonicalDeploymentState:
        input.lineage.managedServing?.canonicalDeploymentState ?? null,
      state: "failed",
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
  const lineage = await store.getModelArtifactLineage(
    binding.modelArtifactLineageId,
  );
  const projection = lineage?.managedServing;
  if (
    !projection ||
    projection.state !== "ready" ||
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
        PORTABLE_ADAPTER_PATTERN.test(name),
    )
    .map(({ artifact, name }) => ({
      artifact,
      path: name,
      mediaType: name.endsWith(".json")
        ? ("application/json" as const)
        : ("application/vnd.safetensors" as const),
    }));
}

function isFireworksLineage(artifacts: TrainingArtifact[]): boolean {
  return artifacts.some(
    (artifact) => artifact.metadata.provider === "fireworks",
  );
}

function assertQualifiedBase(artifacts: TrainingArtifact[]): void {
  const portable = portableUploadFiles(artifacts);
  if (portable.length < 2) {
    throw new Error("Fireworks lineage has no complete portable adapter.");
  }
  for (const { artifact } of portable) {
    if (
      artifact.baseModelId !== "Qwen/Qwen3-8B" ||
      artifact.baseModelRevision !== MANAGED_QWEN3_8B_BASE_REVISION
    ) {
      throw new Error(
        "Fireworks adapter does not match the pinned Qwen/Qwen3-8B serving revision.",
      );
    }
  }
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
