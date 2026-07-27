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
  type ManagedRegistryServingPool,
  type ManagedRegistryServingReceipt,
} from "./managed-adapter-registry-client.js";
import {
  PRIME_GRPO_QWEN3_8B_PROFILE,
  resolvePrimeGrpoBaseProfile,
} from "./prime-grpo-base-profiles.js";
import type {
  OpenPondTrainingProvenancePayload,
} from "./managed-adapter-training-provenance.js";
import {
  isManagedAdapterControlRuntimeEnabled,
} from "../openpond/hosted-api-access.js";
import { PRIME_RL_UPSTREAM_REVISION } from "./prime-grpo-plan.js";
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
  trustedControlAvailable?: () => boolean;
  intervalMs?: number;
  now?: () => Date;
}) {
  const now = dependencies.now ?? (() => new Date());
  const trustedControlAvailable =
    dependencies.trustedControlAvailable ??
    isManagedAdapterControlRuntimeEnabled;
  let timer: ReturnType<typeof setInterval> | null = null;
  let active: Promise<void> | null = null;
  let closed = false;

  async function reconcile(): Promise<void> {
    if (active) return active;
    active = reconcileOnce(
      dependencies.store,
      dependencies.client,
      dependencies.resolveSelectedTeamId,
      trustedControlAvailable,
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
  trustedControlAvailable: () => boolean,
  now: () => Date,
): Promise<void> {
  const selectedTeamId = (await resolveSelectedTeamId())?.trim() || null;
  const registries = new Map<
    string,
    Promise<{
      artifacts: ManagedRegistryArtifact[];
      deployments: ManagedRegistryDeployment[];
      servingPools: ManagedRegistryServingPool[];
      servingReceipts: ManagedRegistryServingReceipt[];
    }>
  >();
  const registryForTeam = (
    teamId: string,
    source: ManagedLineageSource,
  ) => {
    const trustedRead = source === "openpond_training";
    const registryKey = `${trustedRead ? "trusted" : "user"}:${teamId}`;
    let registry = registries.get(registryKey);
    if (!registry) {
      registry = (
        trustedRead
          ? client.listTrustedRegistry(teamId)
          : client.listRegistry(teamId)
      ).then((value) => ({
        artifacts: [...value.artifacts],
        deployments: [...value.deployments],
        servingPools: [...value.servingPools],
        servingReceipts: [...value.servingReceipts],
      }));
      registries.set(registryKey, registry);
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
      trustedControlAvailable,
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
    teamId: string,
    source: ManagedLineageSource,
  ) => Promise<{
    artifacts: ManagedRegistryArtifact[];
    deployments: ManagedRegistryDeployment[];
    servingPools: ManagedRegistryServingPool[];
    servingReceipts: ManagedRegistryServingReceipt[];
  }>;
  trustedControlAvailable: () => boolean;
  now: () => Date;
}): Promise<void> {
  const jobArtifacts = await input.store.listTrainingArtifacts(
    input.lineage.jobId,
  );
  const source = lineageSource(input.lineage, jobArtifacts);
  if (!source) return;
  if (
    source === "openpond_training" &&
    !input.trustedControlAvailable()
  ) {
    return;
  }
  const timestamp = input.now().toISOString();
  const teamId =
    input.lineage.managedServing?.canonicalArtifactId
      ? input.lineage.managedServing.teamId
      : input.selectedTeamId;
  try {
    if (!teamId) {
      throw new Error(
        "Select an OpenPond team before publishing managed adapters.",
      );
    }
    const baseProfileId = assertQualifiedBase(source, jobArtifacts);
    const registry = await input.registryForTeam(teamId, source);
    let artifact =
      registry.artifacts.find(
        (candidate) =>
          candidate.id ===
          input.lineage.managedServing?.canonicalArtifactId,
      ) ??
      registry.artifacts.find(
        (candidate) =>
          candidate.source === source &&
          candidate.sourceRef === input.lineage.id,
      );
    if (!artifact) {
      const job = await input.store.getTrainingJob(input.lineage.jobId);
      if (!job) throw new Error(`${source} lineage lost its training job.`);
      const plan = await input.store.getTrainingPlan(job.planId);
      if (!plan) throw new Error(`${source} lineage lost its training plan.`);
      const sourceArtifact = await input.store.getTrainingArtifact(
        input.lineage.artifactId,
      );
      if (!sourceArtifact) {
        throw new Error(
          `${source} lineage lost its source adapter artifact.`,
        );
      }
      const evaluation = input.lineage.frozenEvaluationArtifactId
        ? await input.store.getTrainingArtifact(
            input.lineage.frozenEvaluationArtifactId,
          )
        : null;
      const files = portableUploadFiles(jobArtifacts);
      artifact = source === "openpond_training"
        ? await input.client
          .publishTrustedOpenPondTrainingSource({
            teamId,
            lineageId: input.lineage.id,
            label:
              `OpenPond Prime GRPO ${input.lineage.id.slice(-12)}`,
            baseProfileId,
            files,
            provenance:
              await openPondTrainingProvenance({
                store: input.store,
                lineage: input.lineage,
                job,
                plan,
                sourceArtifact,
                evaluation,
                files,
              }),
          })
        : await input.client.publishFireworksSource({
            teamId,
            lineageId: input.lineage.id,
            label:
              `OpenPond Fireworks ${input.lineage.id.slice(-12)}`,
            trainingJobId: job.id,
            trainingPlanId: plan.id,
            sourceArtifactId: sourceArtifact.id,
            sourceArtifactSha256: sourceArtifact.sha256,
            tasksetId: input.lineage.tasksetId,
            tasksetHash: input.lineage.tasksetHash,
            evaluationArtifactId: evaluation?.id ?? null,
            evaluationArtifactSha256:
              evaluation?.sha256 ?? null,
            providerRunId:
              typeof job.metadata.providerJobId === "string"
                ? job.metadata.providerJobId
                : null,
            files,
          });
      registry.artifacts.push(artifact);
    }
    if (
      source === "openpond_training"
      && artifact.state === "imported_unvalidated"
    ) {
      await input.client.requestEvaluation({
        teamId,
        artifactId: artifact.id,
        role: "chat_manual",
      });
      artifact = {
        ...artifact,
        state: "evaluating",
      };
    }
    if (
      source === "openpond_training"
      && artifact.state === "promotable"
      && artifact.promotable
      && artifact.customerBindingAllowed
      && !registry.deployments.some(
        (candidate) => candidate.artifactId === artifact!.id,
      )
    ) {
      // Provision the first canonical deployment automatically. A terminal
      // deployment remains durable retry evidence and must not turn the
      // periodic reconciler into an unbounded GPU reprovisioning loop.
      registry.deployments.push(
        await input.client.deployArtifact({
          teamId,
          artifactId: artifact.id,
          idleTimeoutSeconds: 300,
        }),
      );
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
    const servingReceipts = mergeServingReceipts(
      input.lineage.managedServing?.servingReceipts ?? [],
      registry.servingReceipts.filter(
        (record) => record.artifactId === artifact!.id,
      ),
    );
    const evidencePoolId =
      servingReceipts[0]?.poolId
      ?? deployment?.evidence?.poolId
      ?? null;
    const servingPool =
      registry.servingPools.find(
        (candidate) => candidate.id === evidencePoolId,
      )
      ?? (
        input.lineage.managedServing?.servingPool?.id === evidencePoolId
          ? input.lineage.managedServing.servingPool
          : null
      );
    await saveProjection(input.store, input.lineage, {
      schemaVersion: "openpond.managedAdapterServingProjection.v1",
      teamId,
      source,
      sourceRef: input.lineage.id,
      canonicalArtifactId: artifact.id,
      canonicalArtifactState: artifactState(artifact.state),
      canonicalDeploymentId: deployment?.id ?? null,
      canonicalDeploymentState: deploymentState(deployment?.state),
      state: ready ? "ready" : "imported",
      artifactContentHash:
        artifact.contentHash
        ?? input.lineage.managedServing?.artifactContentHash
        ?? null,
      baseProfileId:
        artifact.baseProfileId
        ?? input.lineage.managedServing?.baseProfileId
        ?? null,
      evaluation:
        artifact.evaluation
        ?? input.lineage.managedServing?.evaluation
        ?? null,
      deployment:
        deployment?.evidence
        ?? (
          input.lineage.managedServing?.deployment?.id === deployment?.id
            ? input.lineage.managedServing?.deployment ?? null
            : null
        ),
      servingPool,
      servingReceipts,
      publishedAt: input.lineage.managedServing?.publishedAt ?? timestamp,
      lastSyncedAt: timestamp,
      lastError: null,
    });
  } catch (error) {
    await saveProjection(input.store, input.lineage, {
      schemaVersion: "openpond.managedAdapterServingProjection.v1",
      teamId,
      source,
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
      artifactContentHash:
        input.lineage.managedServing?.artifactContentHash ?? null,
      baseProfileId:
        input.lineage.managedServing?.baseProfileId ?? null,
      evaluation: input.lineage.managedServing?.evaluation ?? null,
      deployment: input.lineage.managedServing?.deployment ?? null,
      servingPool: input.lineage.managedServing?.servingPool ?? null,
      servingReceipts:
        input.lineage.managedServing?.servingReceipts ?? [],
      publishedAt: input.lineage.managedServing?.publishedAt ?? null,
      lastSyncedAt: timestamp,
      lastError: safeError(error),
    });
  }
}

function mergeServingReceipts(
  existing: ManagedAdapterServingProjection["servingReceipts"],
  incoming: ManagedRegistryServingReceipt[],
): ManagedAdapterServingProjection["servingReceipts"] {
  const byHash = new Map(
    existing.map((record) => [record.receipt.contentHash, record] as const),
  );
  for (const record of incoming) {
    byHash.set(record.receipt.contentHash, record);
  }
  return [...byHash.values()]
    .sort((left, right) =>
      right.receipt.timestamps.completedAt.localeCompare(
        left.receipt.timestamps.completedAt,
      ),
    )
    .slice(0, 20);
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

type ManagedLineageSource =
  | "openpond_fireworks"
  | "openpond_training";

function lineageSource(
  lineage: ModelArtifactLineage,
  artifacts: TrainingArtifact[],
): ManagedLineageSource | null {
  if (
    lineage.status === "imported"
    && artifacts.some(
      (artifact) => artifact.metadata.provider === "prime",
    )
  ) {
    return "openpond_training";
  }
  return artifacts.some(
      (artifact) => artifact.metadata.provider === "fireworks",
    )
    ? "openpond_fireworks"
    : null;
}

function assertQualifiedBase(
  source: ManagedLineageSource,
  artifacts: TrainingArtifact[],
): string {
  const portable = portableUploadFiles(artifacts);
  if (portable.length < 2) {
    throw new Error(
      `${source} lineage has no complete portable adapter.`,
    );
  }
  const firstArtifact = portable[0]!.artifact;
  const openPondProfile = source === "openpond_training"
    ? resolvePrimeGrpoBaseProfile({
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: firstArtifact.baseModelId ?? "",
        revision: firstArtifact.baseModelRevision,
        tokenizerRevision: firstArtifact.tokenizerRevision,
        chatTemplateHash: firstArtifact.chatTemplateHash,
        modelAssetId: null,
        source: "managed",
      })
    : null;
  if (source === "openpond_training" && !openPondProfile) {
    throw new Error(
      "openpond_training adapter does not match a qualified Qwen3 serving identity.",
    );
  }
  const expected = openPondProfile
    ? {
        model: openPondProfile.modelId,
        revision: openPondProfile.revision,
        chatTemplateHash: openPondProfile.chatTemplateHash,
      }
    : {
        model: PRIME_GRPO_QWEN3_8B_PROFILE.modelId,
        revision: MANAGED_QWEN3_8B_BASE_REVISION,
        chatTemplateHash: null,
      };
  for (const { artifact } of portable) {
    if (
      artifact.baseModelId !== expected.model
      || artifact.baseModelRevision !== expected.revision
      || artifact.tokenizerRevision !== expected.revision
      || (
        expected.chatTemplateHash
        && artifact.chatTemplateHash !== expected.chatTemplateHash
      )
    ) {
      throw new Error(
        `${source} adapter does not match the pinned ${expected.model} serving identity.`,
      );
    }
  }
  return (
    openPondProfile?.baseProfileId ??
    PRIME_GRPO_QWEN3_8B_PROFILE.baseProfileId
  );
}

async function openPondTrainingProvenance(input: {
  store: SqliteStore;
  lineage: ModelArtifactLineage;
  job: NonNullable<
    Awaited<ReturnType<SqliteStore["getTrainingJob"]>>
  >;
  plan: NonNullable<
    Awaited<ReturnType<SqliteStore["getTrainingPlan"]>>
  >;
  sourceArtifact: TrainingArtifact;
  evaluation: TrainingArtifact | null;
  files: ReturnType<typeof portableUploadFiles>;
}): Promise<OpenPondTrainingProvenancePayload> {
  const modelRun = (
    await input.store.listModelRuns({
      modelId: input.lineage.modelId,
    })
  ).find(
    (candidate) =>
      candidate.adapterArtifactLineageId === input.lineage.id,
  );
  if (
    !modelRun
    || modelRun.status !== "succeeded"
    || !modelRun.receipt
  ) {
    throw new Error(
      "OpenPond training publication requires a successful canonical Model Run receipt.",
    );
  }
  const modelVersion = await input.store.getModelVersion(
    modelRun.modelVersionId,
  );
  if (
    !modelVersion
    || modelVersion.artifactLineageId !== input.lineage.id
    || modelVersion.kind !== "lora_adapter"
  ) {
    throw new Error(
      "OpenPond training publication requires its immutable LoRA Model Version.",
    );
  }
  const baseProfile = resolvePrimeGrpoBaseProfile(
    modelVersion.baseModel,
  );
  if (!baseProfile) {
    throw new Error(
      "OpenPond training publication requires a qualified exact base profile.",
    );
  }
  if (!modelVersion.releaseGraph.agentRelease) {
    throw new Error(
      "OpenPond training publication requires Agent release evidence.",
    );
  }
  const groupedReceiptHash = metadataHash(
    input.sourceArtifact,
    "groupedGrpoReceiptHash",
  );
  if (!groupedReceiptHash) {
    throw new Error(
      "OpenPond training publication requires the grouped GRPO optimizer receipt hash.",
    );
  }
  const manifestHash =
    metadataHash(input.sourceArtifact, "manifestHash")
    ?? input.plan.contentHash;
  const evaluationEvidence = input.evaluation
    ? {
        evaluationArtifactId: input.evaluation.id,
        evaluationArtifactSha256: input.evaluation.sha256,
        frozenEvaluatorHash:
          metadataHash(
            input.evaluation,
            "benchmarkSpecificationHash",
          )
          ?? input.lineage.graderHash,
      }
    : {};
  const inventory = input.files.map(({ artifact, path }) => ({
    path,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  }));
  return {
    schemaVersion:
      "openpond.modelAdapterSourceProvenance.v1",
    sourceSystem: "openpond_training",
    trainingJobId: input.job.id,
    trainingPlanId: input.plan.id,
    sourceArtifactId: input.sourceArtifact.id,
    sourceArtifactSha256: input.sourceArtifact.sha256,
    sourceManifestSha256: manifestHash,
    sourceInventorySha256: contentHash(inventory),
    sourceBaseModelSha256: contentHash({
      repository: baseProfile.modelId,
      revision: baseProfile.revision,
      tokenizerRevision: baseProfile.tokenizerRevision,
      chatTemplateHash: baseProfile.chatTemplateHash,
    }),
    candidateBundleSha256: input.lineage.bundleHash,
    tasksetId: input.lineage.tasksetId,
    tasksetHash: input.lineage.tasksetHash,
    ...evaluationEvidence,
    spendAttestationSha256: contentHash({
      modelRunId: modelRun.id,
      quote: modelRun.quote,
      provider: modelRun.receipt.provider,
      providerRunId: modelRun.receipt.providerRunId,
    }),
    cleanupAttestationSha256: contentHash({
      modelRunId: modelRun.id,
      cleanup: modelRun.receipt.cleanup,
    }),
    providerRunId: modelRun.receipt.providerRunId,
    trainingMethod: "grpo",
    sourcePolicyOrCheckpoint:
      `${modelVersion.id}:policy-${String(
        input.job.metadata.finalPolicyVersion ?? "final",
      )}`,
    optimizerProofSha256: groupedReceiptHash,
    modelProjectId: modelVersion.modelId,
    modelRunId: modelRun.id,
    modelVersionId: modelVersion.id,
    primeRlRevision: PRIME_RL_UPSTREAM_REVISION,
    rawPrimeComputeReceiptSha256:
      modelRun.receipt.traceHash
      ?? modelRun.receipt.resultHash,
    harnessReleaseSha256:
      modelVersion.releaseGraph.harnessRelease.contentHash,
    profileReleaseSha256:
      modelVersion.releaseGraph.profileRelease.contentHash,
    agentReleaseSha256:
      modelVersion.releaseGraph.agentRelease.contentHash,
    graderSha256:
      modelVersion.releaseGraph.grader.contentHash,
    trainingTelemetrySha256:
      modelRun.receipt.telemetry?.contentHash
      ?? groupedReceiptHash,
  };
}

function metadataHash(
  artifact: TrainingArtifact,
  key: string,
): string | null {
  const value = artifact.metadata[key];
  return typeof value === "string"
    && /^[a-f0-9]{64}$/.test(value)
    ? value
    : null;
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
