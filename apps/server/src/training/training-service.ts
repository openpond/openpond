import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  LocalModelChatConfigurationSchema,
  ModelBindingRoleSchema,
  ModelBindingSchema,
  TrainingRecipeSchema,
  TrainingApprovalSchema,
  TrainingPreparedStartSchema,
  TrainingPlanSchema,
  nextCreateImproveRunRevision,
  type TrainingDestinationId,
  type ComputeInventory,
  type GradeResult,
  type ModelBindingRole,
  type Taskset,
  type TaskAttemptResult,
} from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";
import {
  TrainingDestinationRegistry,
  buildTrainingBundle,
  createTrainingBundleExport,
  createTrainingPlan,
  validateTrainingBundle,
} from "@openpond/training-sdk";
import type { SqliteStore } from "../store/store.js";
import { ExportTrainingDestination, UnavailableTrainingDestination } from "./destinations.js";
import { listTrainingDestinationSecretRefs, writeTrainingDestinationSecret } from "./destination-secrets.js";
import { LocalCpuTrainingDestination } from "./local-cpu-destination.js";
import { HardwareGatedTrainingDestination } from "./hardware-gated-destination.js";
import {
  FireworksTrainingDestination,
  type FireworksProviderCredential,
} from "./fireworks-destination.js";
import {
  createFireworksRftEnvironment,
  validateFireworksRftCallbackCredential,
} from "./fireworks-rft-environment.js";
import type { FireworksRftEvaluatorProvisioner } from "./fireworks-rft-evaluator.js";
import { createCrossSystemExpertBootstrapService } from "./cross-system-operations/expert-bootstrap-service.js";
import { createFireworksServingService } from "./fireworks-serving-service.js";
import { selectPortableModelArtifacts } from "./training-artifact-package.js";
import { projectBaseModelCandidates } from "./base-model-candidates.js";

export function createTrainingService(deps: {
  store: SqliteStore;
  storeDir: string;
  localWorkerProjectDir: string;
  registerDestinations?: (registry: TrainingDestinationRegistry) => void;
  revalidateCompute?: () => Promise<void>;
  resolveModelPath?: (modelId: string, revision: string) => Promise<string | null>;
  modelArtifactStore?: () => Promise<string | null>;
  computeInventory?: () => Promise<ComputeInventory | null>;
  resolveFireworksCredential?: () => Promise<FireworksProviderCredential | null>;
  resolveApprovalActor?: () => Promise<string | null>;
  recordFireworksCredentialValidation?: (error: string | null) => Promise<void>;
  gradeTaskAttempt?: (input: {
    tasksetId: string;
    taskId: string;
    attempt: TaskAttemptResult;
  }) => Promise<GradeResult>;
  fireworksRequest?: typeof fetch;
  provisionFireworksRftEvaluator?: FireworksRftEvaluatorProvisioner;
  fireworksRftPublicBaseUrl?: () => string | null;
}) {
  const registry = new TrainingDestinationRegistry();
  const resolveTaskset = (id: string) => deps.store.getTaskset(id);
  registry.register(new ExportTrainingDestination(resolveTaskset));
  const localCpu = new LocalCpuTrainingDestination({ store: deps.store, storeDir: deps.storeDir, projectDir: deps.localWorkerProjectDir, resolveModelPath: deps.resolveModelPath, modelArtifactStore: deps.modelArtifactStore });
  registry.register(localCpu);
  registry.register(new UnavailableTrainingDestination("openpond_managed", "OpenPond Managed is a client stub; the managed service is not implemented in this repository.", resolveTaskset));
  registry.register(new UnavailableTrainingDestination("custom", "Register a custom TrainingDestination implementation before launch.", resolveTaskset));
  registry.register(new UnavailableTrainingDestination("prime_hosted", "Prime hosted training is not connected in this open-source build.", resolveTaskset));
  const fireworks = new FireworksTrainingDestination({
    store: deps.store,
    storeDir: deps.storeDir,
    resolveCredential: deps.resolveFireworksCredential ?? (async () => null),
    recordCredentialValidation: deps.recordFireworksCredentialValidation,
    gradeAttempt: deps.gradeTaskAttempt,
    request: deps.fireworksRequest,
    provisionRftEvaluator: deps.provisionFireworksRftEvaluator,
    rftPublicBaseUrl: deps.fireworksRftPublicBaseUrl,
  });
  const fireworksRftEnvironment = createFireworksRftEnvironment({
    store: deps.store,
    resolveCredential: deps.resolveFireworksCredential ?? (async () => null),
    request: deps.fireworksRequest,
    validateCallbackCredential: (input) =>
      validateFireworksRftCallbackCredential({
        ...input,
        request: deps.fireworksRequest,
      }),
  });
  const expertBootstrap = createCrossSystemExpertBootstrapService({
    store: deps.store,
    storeDir: deps.storeDir,
    resolveApprovalActor: deps.resolveApprovalActor,
  });
  const fireworksServing = createFireworksServingService({
    store: deps.store,
    resolveCredential: deps.resolveFireworksCredential ?? (async () => null),
    request: deps.fireworksRequest,
  });
  registry.register(fireworks);
  registry.register(new HardwareGatedTrainingDestination("local_cuda", { inventory: deps.computeInventory ?? (async () => null), resolveTaskset }));
  registry.register(new HardwareGatedTrainingDestination("local_mlx", { inventory: deps.computeInventory ?? (async () => null), resolveTaskset }));
  registry.register(new UnavailableTrainingDestination("ssh_gpu", "User-owned SSH GPU execution is deferred until its worker conformance suite is complete.", resolveTaskset));
  deps.registerDestinations?.(registry);
  void localCpu.reconcile();
  void fireworks.reconcile();
  void fireworksServing.reconcile();

  async function destinations() { return Promise.all(registry.list().map((destination) => destination.capabilities())); }

  async function createPlan(input: { modelId?: string | null; tasksetId: string; destinationId: TrainingDestinationId; recipe: unknown; exportApproved?: boolean; retentionDays?: number | null; region?: string | null }) {
    const taskset = await deps.store.getTaskset(input.tasksetId);
    if (!taskset) throw new Error("Taskset not found.");
    if (!taskset.readiness?.ready) throw new Error("Taskset is not ready for training. Resolve readiness blockers first.");
    const recipe = TrainingRecipeSchema.parse(withAuthoritativeRecipeHashes(taskset, input.recipe));
    const destination = registry.get(input.destinationId);
    const capabilities = await destination.capabilities();
    const initial = createTrainingPlan({ taskset, destinationId: input.destinationId, recipe, exportApproved: input.exportApproved, retentionDays: input.retentionDays, region: input.region });
    const draft = TrainingPlanSchema.parse({
      ...initial,
      modelId: input.modelId ?? null,
      environmentPlacement: capabilities.environmentPlacements[0] ?? "none",
    });
    const compatibility = await destination.validate(draft);
    const quote = compatibility.compatible
      ? await destination.quote(draft)
      : { estimatedCostUsd: null };
    const planInput = {
      ...draft,
      compatibility,
      estimatedCostUsd: quote.estimatedCostUsd,
      contentHash: "",
    };
    const plan = TrainingPlanSchema.parse({
      ...planInput,
      contentHash: contentHash(planInput),
    });
    await deps.store.saveTrainingPlan(plan);
    return plan;
  }

  async function buildBundle(planId: string) {
    const plan = await deps.store.getTrainingPlan(planId);
    if (!plan) throw new Error("Training Plan not found.");
    const taskset = await deps.store.getTaskset(plan.tasksetId);
    if (!taskset) throw new Error("Taskset not found.");
    const directory = path.join(deps.storeDir, "training", "bundles", plan.id);
    const manifest = await buildTrainingBundle({ taskset, plan, directory });
    const validation = await validateTrainingBundle(directory);
    if (!validation.valid) throw new Error(`Training Bundle validation failed: ${validation.issues.join("; ")}`);
    await deps.store.saveTrainingBundle(manifest);
    return { manifest, directory, validation };
  }

  async function deleteTaskset(tasksetId: string) {
    const taskset = await deps.store.getTaskset(tasksetId);
    if (!taskset) throw new Error("Taskset not found.");
    const [plans, jobs, artifacts] = await Promise.all([
      deps.store.listTrainingPlans(),
      deps.store.listTrainingJobs(),
      deps.store.listTrainingArtifacts(),
    ]);
    const planIds = new Set(plans.filter((plan) => plan.tasksetId === tasksetId).map((plan) => plan.id));
    const relatedJobs = jobs.filter((job) => planIds.has(job.planId));
    const activeJob = relatedJobs.find((job) => ["queued", "starting", "running", "cancelling", "reconciling"].includes(job.status));
    if (activeJob) throw new Error("Cancel the active training job before deleting this model.");
    await stopActiveModelServingSessions({
      tasksetId,
      reason: "Delete this model",
    });
    const jobIds = new Set(relatedJobs.map((job) => job.id));
    const managedTrainingRoot = path.resolve(deps.storeDir, "training");
    for (const artifact of artifacts.filter((artifact) => jobIds.has(artifact.jobId))) {
      const artifactPath = path.resolve(artifact.path);
      if (isInside(managedTrainingRoot, artifactPath)) await rm(artifactPath, { force: true, recursive: true });
    }
    for (const planId of planIds) await rm(path.join(managedTrainingRoot, "bundles", planId), { force: true, recursive: true });
    await rm(path.join(managedTrainingRoot, "tasksets", taskset.id), { force: true, recursive: true });
    await deps.store.deleteTasksetData(tasksetId);
    return { deleted: true, tasksetId };
  }

  async function approve(input: { planId: string; bundleId: string; approvedBy?: string; maximumCostUsd?: number | null }) {
    const plan = await deps.store.getTrainingPlan(input.planId);
    const bundle = await deps.store.getTrainingBundle(input.bundleId);
    if (!plan || !bundle || bundle.planId !== plan.id) throw new Error("Training Plan and Bundle do not match.");
    if (!plan.compatibility.compatible) throw new Error("Incompatible Training Plans cannot be approved.");
    const recipe = TrainingRecipeSchema.parse(plan.recipe);
    if (recipe.method !== "sft" && recipe.method !== "grpo") {
      throw new Error(`Training method ${recipe.method} has no executable approval contract.`);
    }
    const approvedBy = plan.destinationId === "fireworks"
      ? await requireFireworksApprovalActor()
      : input.approvedBy ?? "local_user";
    const maximumCostUsd = input.maximumCostUsd ?? plan.estimatedCostUsd;
    const approvalId = `training_approval_${contentHash([
      plan.id,
      bundle.contentHash,
      plan.destinationId,
      recipe.baseModel.id,
      recipe.method,
      recipe.parameterization,
      maximumCostUsd,
      approvedBy,
    ]).slice(0, 24)}`;
    const existing = await deps.store.getTrainingApproval(approvalId);
    if (existing) return existing;
    const approval = TrainingApprovalSchema.parse({
      schemaVersion: "openpond.trainingApproval.v1",
      id: approvalId,
      planId: plan.id,
      bundleHash: bundle.contentHash,
      destinationId: plan.destinationId,
      modelId: recipe.baseModel.id,
      method: recipe.method,
      parameterization: recipe.parameterization,
      maximumCostUsd,
      approvedBy,
      approvedAt: new Date().toISOString(),
    });
    return deps.store.saveTrainingApproval(approval);
  }

  async function launch(input: { planId: string; approvalId: string }) {
    const plan = await deps.store.getTrainingPlan(input.planId);
    const approval = await deps.store.getTrainingApproval(input.approvalId);
    if (!plan || !approval || approval.planId !== plan.id || approval.destinationId !== plan.destinationId) throw new Error("Training approval does not match this plan.");
    if (plan.destinationId === "fireworks") {
      const currentActor = await requireFireworksApprovalActor();
      if (approval.approvedBy !== currentActor) {
        throw new Error(
          `Fireworks training was approved by ${approval.approvedBy}, but the signed-in OpenPond account is ${currentActor}. Re-approve before launch.`,
        );
      }
    }
    const bundle = await deps.store.findTrainingBundleByPlanAndHash(plan.id, approval.bundleHash);
    if (!bundle) throw new Error("Approved Training Bundle was not found.");
    const existing = (await deps.store.listTrainingJobs()).find(
      (job) => job.approvalId === approval.id,
    );
    if (existing) {
      if (
        existing.destinationId === "fireworks"
        && existing.status === "failed"
      ) {
        const retried = await registry.get(existing.destinationId).launch(plan, approval);
        await deps.store.saveTrainingJob(retried);
        return retried;
      }
      try {
        return await registry.get(existing.destinationId).status(existing.id);
      } catch {
        return existing;
      }
    }
    const job = await registry.get(plan.destinationId).launch(plan, approval);
    await deps.store.saveTrainingJob(job);
    return job;
  }

  async function start(input: { modelId?: string | null; tasksetId: string; destinationId: TrainingDestinationId; recipe: unknown; exportApproved?: boolean; maximumCostUsd?: number | null; retentionDays?: number | null; region?: string | null }) {
    await deps.revalidateCompute?.();
    const plan = await createPlan({
      modelId: input.modelId ?? null,
      tasksetId: input.tasksetId,
      destinationId: input.destinationId,
      recipe: input.recipe,
      exportApproved: input.exportApproved,
      retentionDays: input.retentionDays,
      region: input.region,
    });
    const bundle = await buildBundle(plan.id);
    const approval = await approve({ planId: plan.id, bundleId: bundle.manifest.id, maximumCostUsd: input.maximumCostUsd });
    await deps.revalidateCompute?.();
    const job = await launch({ planId: plan.id, approvalId: approval.id });
    return { plan, bundle: bundle.manifest, approval, job };
  }

  async function prepareStart(input: {
    modelId?: string | null;
    tasksetId: string;
    destinationId: TrainingDestinationId;
    recipe: unknown;
    exportApproved?: boolean;
    retentionDays?: number | null;
    region?: string | null;
  }) {
    await deps.revalidateCompute?.();
    const plan = await createPlan(input);
    if (!plan.compatibility.compatible || plan.estimatedCostUsd == null) {
      throw new Error("Training preparation did not produce a compatible exact quote.");
    }
    const bundle = await buildBundle(plan.id);
    const approvalActor = plan.destinationId === "fireworks"
      ? await requireFireworksApprovalActor()
      : null;
    return TrainingPreparedStartSchema.parse({
      schemaVersion: "openpond.trainingPreparedStart.v1",
      plan,
      bundle: bundle.manifest,
      approvalActor,
      preparedAt: new Date().toISOString(),
    });
  }

  async function startPrepared(input: {
    planId: string;
    bundleId: string;
    maximumCostUsd: number | null;
  }) {
    await deps.revalidateCompute?.();
    const plan = await deps.store.getTrainingPlan(input.planId);
    const bundle = await deps.store.getTrainingBundle(input.bundleId);
    if (!plan || !bundle || bundle.planId !== plan.id) {
      throw new Error("Prepared Training Plan and Bundle do not match.");
    }
    const taskset = await deps.store.getTaskset(plan.tasksetId);
    if (!taskset || taskset.contentHash !== plan.tasksetHash || !taskset.readiness?.ready) {
      throw new Error("The prepared Training Plan is stale. Prepare a new quote from the current Taskset.");
    }
    const approval = await approve({
      planId: plan.id,
      bundleId: bundle.id,
      maximumCostUsd: input.maximumCostUsd,
    });
    await deps.revalidateCompute?.();
    const job = await launch({ planId: plan.id, approvalId: approval.id });
    return { plan, bundle, approval, job };
  }

  async function requireFireworksApprovalActor(): Promise<string> {
    const actor = (await deps.resolveApprovalActor?.())?.trim() ?? "";
    if (!actor) {
      throw new Error(
        "Fireworks training requires a signed-in OpenPond account profile with a handle.",
      );
    }
    return actor;
  }

  async function state(profileId?: string) {
    await Promise.all([fireworks.reconcile(), fireworksServing.reconcile()]);
    const [
      plans,
      bundles,
      jobs,
      artifacts,
      models,
      rolloutReceipts,
      modelBindings,
      servingSessions,
      destinationCapabilities,
      computeInventory,
      secretRefs,
      fireworksCredential,
    ] = await Promise.all([
      deps.store.listTrainingPlans(),
      deps.store.listTrainingBundles(),
      deps.store.listTrainingJobs(),
      deps.store.listTrainingArtifacts(),
      deps.store.listModelArtifactLineage(),
      deps.store.listRolloutTrajectoryReceipts(),
      deps.store.listModelBindings(),
      fireworksServing.list(profileId),
      destinations(),
      deps.computeInventory?.() ?? Promise.resolve(null),
      listTrainingDestinationSecretRefs(path.join(deps.storeDir, "secrets")),
      deps.resolveFireworksCredential?.() ?? Promise.resolve(null),
    ]);
    return {
      plans,
      bundles,
      jobs,
      artifacts,
      models,
      rolloutReceipts,
      modelBindings,
      servingSessions,
      destinations: destinationCapabilities,
      baseModelCandidates: projectBaseModelCandidates({
        destinations: destinationCapabilities,
        inventory: computeInventory,
      }),
      credentialRefs: [
        ...secretRefs.filter((credential) => credential.destinationId !== "fireworks"),
        {
          destinationId: "fireworks",
          configured: Boolean(fireworksCredential),
          createdAt: fireworksCredential?.createdAt ?? null,
          updatedAt: fireworksCredential?.updatedAt ?? null,
        },
      ],
    };
  }

  async function importExternal(input: { planId: string; bundleId: string; artifactDirectory: string }) {
    return localCpu.importExternal(input);
  }

  async function exportBundle(bundleId: string) {
    const bundle = await deps.store.getTrainingBundle(bundleId);
    if (!bundle) throw new Error("Training Bundle not found.");
    const directory = path.join(deps.storeDir, "training", "bundles", bundle.planId);
    const exported = await createTrainingBundleExport(directory);
    return { filename: `${bundle.id}.openpond-training-bundle.json`, content: JSON.stringify(exported) };
  }

  async function artifactDownload(id: string) {
    const artifact = await deps.store.getTrainingArtifact(id);
    if (!artifact) throw new Error("Training artifact not found.");
    const bytes = await readFile(artifact.path);
    if (sha256(bytes) !== artifact.sha256 || bytes.byteLength !== artifact.sizeBytes) throw new Error("Training artifact failed integrity verification.");
    return { artifact, path: artifact.path };
  }

  async function modelPackageDownload(id: string) {
    const model = await deps.store.getModelArtifactLineage(id);
    if (!model || model.status !== "imported") {
      throw new Error("Imported Model was not found.");
    }
    const artifacts = selectPortableModelArtifacts(
      await deps.store.listTrainingArtifacts(model.jobId),
    );
    const singleFileWeights = artifacts.find(
      (entry) => entry.name === "adapter_model.safetensors",
    );
    const shardedWeights = artifacts.filter((entry) =>
      /^adapter_model-\d{5}-of-\d{5}\.safetensors$/.test(entry.name),
    );
    const weights = singleFileWeights?.artifact ?? shardedWeights[0]?.artifact;
    const weightsIndex = artifacts.find(
      (entry) => entry.name === "adapter_model.safetensors.index.json",
    );
    const configuration = artifacts.find(
      (entry) => entry.name === "adapter_config.json",
    )?.artifact;
    const completeWeights =
      Boolean(singleFileWeights)
      || (shardedWeights.length > 0 && Boolean(weightsIndex));
    if (!weights || !configuration || !completeWeights) {
      throw new Error(
        "The imported Model is missing its LoRA weights or adapter configuration.",
      );
    }
    for (const { artifact } of artifacts) {
      const bytes = await readFile(artifact.path);
      if (
        bytes.byteLength !== artifact.sizeBytes
        || sha256(bytes) !== artifact.sha256
      ) {
        throw new Error(
          `Training artifact ${artifact.id} failed integrity verification.`,
        );
      }
    }
    const job = await deps.store.getTrainingJob(model.jobId);
    const plan = job ? await deps.store.getTrainingPlan(job.planId) : null;
    const manifest = Buffer.from(`${JSON.stringify({
      schemaVersion: "openpond.modelPackage.v1",
      modelArtifactLineageId: model.id,
      jobId: model.jobId,
      tasksetId: model.tasksetId,
      tasksetHash: model.tasksetHash,
      graderHash: model.graderHash,
      planHash: model.planHash,
      bundleHash: model.bundleHash,
      recipeHash: model.recipeHash,
      baseModel: {
        id: weights.baseModelId,
        revision: weights.baseModelRevision,
        tokenizerRevision: weights.tokenizerRevision,
        chatTemplateHash: weights.chatTemplateHash,
      },
      provider: job?.metadata.provider ?? null,
      providerJobId: job?.metadata.providerJobId ?? null,
      outputModelName: job?.metadata.outputModelName ?? null,
      trainingMethod: plan?.recipe.method ?? null,
      files: artifacts.map((entry) => ({
        name: entry.name,
        providerFilename: entry.providerFilename,
        sha256: entry.artifact.sha256,
        sizeBytes: entry.artifact.sizeBytes,
      })),
      exportedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    return {
      filename: `${model.id}.openpond-lora.tar`,
      manifest,
      entries: artifacts.map((entry) => ({
        artifact: entry.artifact,
        name: `model/${entry.name}`,
      })),
    };
  }

  async function rejectModel(input: { modelId: string; reason: string }) {
    const model = await deps.store.getModelArtifactLineage(input.modelId);
    if (!model) throw new Error("Imported model not found.");
    const activeBindings = (await deps.store.listModelBindings()).filter(
      (binding) =>
        binding.status === "active" &&
        binding.modelArtifactLineageId === model.id,
    );
    if (activeBindings.length) {
      throw new Error("Roll back every active Model binding before rejecting this artifact.");
    }
    await stopActiveModelServingSessions({
      modelArtifactLineageId: model.id,
      reason: "Reject this Model",
    });
    const timestamp = new Date().toISOString();
    const rejected = await deps.store.saveModelArtifactLineage({
      ...model,
      status: "rejected",
      rejectedAt: timestamp,
      rejectionReason: input.reason,
    });
    await updateModelCreateImproveRelease({
      modelId: model.id,
      jobId: model.jobId,
      artifactId: model.artifactId,
      status: "rejected",
      receiptId: `model_rejection_${contentHash([model.id, timestamp, input.reason]).slice(0, 24)}`,
      timestamp,
      reason: input.reason,
    });
    return rejected;
  }

  async function bindModel(input: {
    profileId: string;
    modelId: string;
    role: ModelBindingRole;
    roleTargetId: string;
    promotedBy?: string;
  }) {
    const role = ModelBindingRoleSchema.parse(input.role);
    const roleTargetId = input.roleTargetId.trim();
    if (!roleTargetId) throw new Error("Model binding target is required.");
    const model = await deps.store.getModelArtifactLineage(input.modelId);
    if (!model || model.status !== "imported") throw new Error("Imported model not found.");
    if (!model.promotable || !model.frozenEvaluationArtifactId) {
      throw new Error("This Model did not pass its source-owned frozen evaluation promotion gate.");
    }
    const [taskset, job, artifact, evaluationArtifact] = await Promise.all([
      deps.store.getTaskset(model.tasksetId),
      deps.store.getTrainingJob(model.jobId),
      deps.store.getTrainingArtifact(model.artifactId),
      deps.store.getTrainingArtifact(model.frozenEvaluationArtifactId),
    ]);
    if (!taskset || taskset.profileId !== input.profileId) {
      throw new Error("The Model does not belong to the active Profile.");
    }
    if (!job || job.status !== "succeeded" || !artifact) {
      throw new Error("The Model artifact does not have a completed training receipt.");
    }
    if (
      !evaluationArtifact ||
      evaluationArtifact.kind !== "evaluation" ||
      evaluationArtifact.jobId !== job.id ||
      evaluationArtifact.metadata.thresholdPassed !== true
    ) {
      throw new Error("The Model has no matching frozen-evaluation threshold receipt.");
    }
    await Promise.all([
      assertArtifactIntegrity(artifact.path, artifact.sha256, artifact.sizeBytes),
      assertArtifactIntegrity(
        evaluationArtifact.path,
        evaluationArtifact.sha256,
        evaluationArtifact.sizeBytes,
      ),
    ]);
    const current = await deps.store.getActiveModelBinding({
      profileId: input.profileId,
      role,
      roleTargetId,
    });
    if (current?.modelArtifactLineageId === model.id) return current;
    const timestamp = new Date().toISOString();
    const binding = ModelBindingSchema.parse({
      schemaVersion: "openpond.modelBinding.v1",
      id: `model_binding_${contentHash([
        input.profileId,
        role,
        roleTargetId,
        model.id,
        timestamp,
      ]).slice(0, 24)}`,
      profileId: input.profileId,
      role,
      roleTargetId,
      modelArtifactLineageId: model.id,
      tasksetId: taskset.id,
      evaluationArtifactId: evaluationArtifact.id,
      status: "active",
      priorBindingId: current?.id ?? null,
      rollbackTargetBindingId: current?.id ?? null,
      promotedBy: input.promotedBy?.trim() || "local_user",
      promotedAt: timestamp,
      rolledBackAt: null,
      metadata: {
        jobId: job.id,
        artifactId: artifact.id,
        artifactHash: artifact.sha256,
        trainingMethod: (await deps.store.getTrainingPlan(job.planId))?.recipe.method ?? null,
        evaluationThresholdPassed: true,
      },
    });
    await deps.store.replaceActiveModelBinding({
      profileId: input.profileId,
      role,
      roleTargetId,
      expectedActiveBindingId: current?.id ?? null,
      next: binding,
      timestamp,
    });
    await deps.store.saveModelArtifactLineage({ ...model, pinned: true });
    if (current) {
      const prior = await deps.store.getModelArtifactLineage(
        current.modelArtifactLineageId,
      );
      if (prior) {
        await deps.store.saveModelArtifactLineage({ ...prior, pinned: true });
      }
    }
    await updateModelCreateImproveRelease({
      modelId: model.id,
      jobId: model.jobId,
      artifactId: model.artifactId,
      status: "released",
      receiptId: binding.id,
      timestamp,
      reason: null,
    });
    return binding;
  }

  async function rollbackModelBinding(input: {
    bindingId: string;
    rolledBackBy?: string;
  }) {
    const binding = await deps.store.getModelBinding(input.bindingId);
    if (!binding || binding.status !== "active") {
      throw new Error("Active Model binding not found.");
    }
    const rollbackTarget = binding.rollbackTargetBindingId
      ? await deps.store.getModelBinding(binding.rollbackTargetBindingId)
      : null;
    if (
      rollbackTarget &&
      (
        rollbackTarget.profileId !== binding.profileId ||
        rollbackTarget.role !== binding.role ||
        rollbackTarget.roleTargetId !== binding.roleTargetId
      )
    ) {
      throw new Error("The recorded rollback target does not match the active Model role.");
    }
    const timestamp = new Date().toISOString();
    const restored = rollbackTarget
      ? ModelBindingSchema.parse({
          ...rollbackTarget,
          id: `model_binding_${contentHash([
            binding.id,
            rollbackTarget.id,
            timestamp,
          ]).slice(0, 24)}`,
          status: "active",
          priorBindingId: binding.id,
          rollbackTargetBindingId: rollbackTarget.priorBindingId,
          promotedBy: input.rolledBackBy?.trim() || "local_user",
          promotedAt: timestamp,
          rolledBackAt: null,
          metadata: {
            ...rollbackTarget.metadata,
            action: "rollback",
            rolledBackBindingId: binding.id,
            restoredFromBindingId: rollbackTarget.id,
          },
        })
      : null;
    await deps.store.replaceActiveModelBinding({
      profileId: binding.profileId,
      role: binding.role,
      roleTargetId: binding.roleTargetId,
      expectedActiveBindingId: binding.id,
      next: restored,
      timestamp,
    });
    if (restored) {
      const restoredModel = await deps.store.getModelArtifactLineage(
        restored.modelArtifactLineageId,
      );
      if (restoredModel) {
        await deps.store.saveModelArtifactLineage({
          ...restoredModel,
          pinned: true,
        });
      }
    }
    const model = await deps.store.getModelArtifactLineage(binding.modelArtifactLineageId);
    if (model) {
      await updateModelCreateImproveRelease({
        modelId: model.id,
        jobId: model.jobId,
        artifactId: model.artifactId,
        status: "rolled_back",
        receiptId: binding.id,
        timestamp,
        reason: null,
      });
    }
    return {
      rolledBackBindingId: binding.id,
      activeBinding: restored,
    };
  }

  async function updateModelConfiguration(input: { modelId: string; configuration: unknown }) {
    const model = await deps.store.getModelArtifactLineage(input.modelId);
    if (!model || model.status !== "imported") throw new Error("Imported model not found.");
    const configuration = LocalModelChatConfigurationSchema.parse({
      ...(input.configuration as Record<string, unknown>),
      updatedAt: new Date().toISOString(),
    });
    return deps.store.saveModelArtifactLineage({ ...model, chatConfiguration: configuration });
  }

  async function setModelPinned(input: { modelId: string; pinned: boolean }) {
    const model = await deps.store.getModelArtifactLineage(input.modelId);
    if (!model) throw new Error("Model version not found.");
    if (!input.pinned) {
      const activeBinding = (await deps.store.listModelBindings()).find(
        (binding) =>
          binding.status === "active" &&
          binding.modelArtifactLineageId === model.id,
      );
      if (activeBinding) {
        throw new Error("Current Model versions stay pinned.");
      }
    }
    return deps.store.saveModelArtifactLineage({
      ...model,
      pinned: input.pinned,
    });
  }

  async function saveCredential(input: { destinationId: string; value: string }) {
    if (input.destinationId === "openpond_managed") throw new Error("OpenPond Managed uses account authentication, not a local BYOK credential.");
    if (input.destinationId === "fireworks") throw new Error("Fireworks training uses the saved Settings > Providers credential; it does not use a second training credential.");
    return writeTrainingDestinationSecret({ directory: path.join(deps.storeDir, "secrets"), destinationId: input.destinationId, value: input.value, timestamp: new Date().toISOString() });
  }

  async function cancelJob(jobId: string) {
    const job = await deps.store.getTrainingJob(jobId);
    if (!job) throw new Error("Training job not found.");
    return registry.get(job.destinationId).cancel(job.id);
  }

  async function evaluateJob(jobId: string) {
    const job = await deps.store.getTrainingJob(jobId);
    if (!job) throw new Error("Training job not found.");
    if (job.destinationId !== "fireworks") {
      throw new Error(
        "Explicit provider evaluation is currently implemented for Fireworks jobs.",
      );
    }
    return fireworks.evaluate(job.id);
  }

  async function handleFireworksRft(payload: unknown) {
    return fireworksRftEnvironment.handle(payload);
  }

  async function close(): Promise<void> {
    await Promise.all([localCpu.close(), fireworksServing.close()]);
  }

  async function stopActiveModelServingSessions(input: {
    tasksetId?: string;
    modelArtifactLineageId?: string;
    reason: string;
  }): Promise<void> {
    const sessions = (await fireworksServing.list()).filter((session) =>
      ["starting", "ready", "stopping"].includes(session.state)
      && (!input.tasksetId || session.tasksetId === input.tasksetId)
      && (
        !input.modelArtifactLineageId
        || session.modelArtifactLineageId === input.modelArtifactLineageId
      ));
    for (const session of sessions) {
      const stopped = await fireworksServing.stop(session.id, "user");
      if (stopped.state !== "stopped") {
        throw new Error(
          `${input.reason} could not confirm Fireworks cleanup: ${stopped.error ?? stopped.state}.`,
        );
      }
    }
  }

  return {
    registry,
    destinations,
    createPlan,
    buildBundle,
    deleteTaskset,
    previewExpertBootstrap: expertBootstrap.preview,
    approveExpertBootstrap: expertBootstrap.approve,
    approve,
    launch,
    start,
    prepareStart,
    startPrepared,
    state,
    importExternal,
    exportBundle,
    artifactDownload,
    modelPackageDownload,
    rejectModel,
    bindModel,
    rollbackModelBinding,
    updateModelConfiguration,
    setModelPinned,
    saveCredential,
    cancelJob,
    evaluateJob,
    isFireworksModel: fireworksServing.appliesTo,
    startModelServing: fireworksServing.start,
    stopModelServing: fireworksServing.stop,
    streamFireworksModel: fireworksServing.stream,
    handleFireworksRft,
    close,
  };

  async function updateModelCreateImproveRelease(input: {
    modelId: string;
    jobId: string;
    artifactId: string;
    status: "released" | "rejected" | "rolled_back";
    receiptId: string;
    timestamp: string;
    reason: string | null;
  }): Promise<void> {
    const runs = await deps.store.listCreateImproveRuns({
      targetKind: "model",
      limit: 500,
    });
    for (const run of runs) {
      if (
        run.target.kind !== "model" ||
        (
          run.target.trainingJobId !== input.jobId &&
          run.target.artifactId !== input.artifactId
        )
      ) {
        continue;
      }
      const candidate = run.candidates.find((item) =>
        item.target.kind === "model" &&
        (
          item.target.trainingJobId === input.jobId ||
          item.artifactRefs.includes(input.artifactId)
        ));
      const candidates = candidate
        ? run.candidates.map((item) =>
            item.id === candidate.id
              ? {
                  ...item,
                  status: input.status === "released"
                    ? "accepted" as const
                    : input.status === "rejected"
                      ? "rejected" as const
                      : item.status,
                  updatedAt: input.timestamp,
                }
              : item)
        : run.candidates;
      let staged = run;
      if (input.status === "released" && staged.state !== "released") {
        if (staged.state === "ready") {
          staged = nextCreateImproveRunRevision(staged, {
            state: "awaiting_promotion",
            updatedAt: input.timestamp,
          });
        }
        if (staged.state === "awaiting_promotion") {
          staged = nextCreateImproveRunRevision(staged, {
            state: "reconciling_release",
            updatedAt: input.timestamp,
          });
        }
        if (staged.state !== "reconciling_release") {
          throw new Error(`Model promotion cannot release a run from ${staged.state}.`);
        }
        staged = nextCreateImproveRunRevision(staged, {
          state: "released",
          updatedAt: input.timestamp,
        });
      } else if (input.status === "rejected" && staged.state !== "rejected") {
        if (staged.state === "ready") {
          staged = nextCreateImproveRunRevision(staged, {
            state: "awaiting_promotion",
            updatedAt: input.timestamp,
          });
        }
        if (staged.state !== "awaiting_promotion") {
          throw new Error(`Model rejection cannot complete a run from ${staged.state}.`);
        }
        staged = nextCreateImproveRunRevision(staged, {
          state: "rejected",
          updatedAt: input.timestamp,
        });
      } else if (input.status === "rolled_back" && staged.state === "released") {
        staged = nextCreateImproveRunRevision(staged, {
          state: "ready",
          updatedAt: input.timestamp,
        });
      }
      await deps.store.upsertCreateImproveRun(nextCreateImproveRunRevision(staged, {
        state: staged.state,
        candidates,
        releaseOutcome: {
          ...run.releaseOutcome,
          status: input.status,
          releaseReceiptRef: input.receiptId,
          updatedAt: input.timestamp,
        },
        externalExecutionRefs: [
          ...run.externalExecutionRefs.filter((ref) =>
            !(ref.kind === "release" && ref.id === input.receiptId)),
          {
            kind: "release",
            id: input.receiptId,
            status: input.status,
            metadata: {
              modelId: input.modelId,
              artifactId: input.artifactId,
            },
          },
        ],
        blockedReason: input.status === "rejected" ? input.reason : null,
        updatedAt: input.timestamp,
      }));
    }
  }
}

function withAuthoritativeRecipeHashes(taskset: Taskset, recipe: unknown): unknown {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) return recipe;
  const candidate = recipe as Record<string, unknown>;
  if (candidate.method !== "grpo") return recipe;
  const reward =
    candidate.reward && typeof candidate.reward === "object" && !Array.isArray(candidate.reward)
      ? candidate.reward as Record<string, unknown>
      : {};
  return {
    ...candidate,
    reward: {
      ...reward,
      graderHash: contentHash(taskset.graders),
    },
  };
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertArtifactIntegrity(
  artifactPath: string,
  expectedHash: string,
  expectedSize: number,
): Promise<void> {
  const bytes = await readFile(artifactPath);
  if (bytes.byteLength !== expectedSize || sha256(bytes) !== expectedHash) {
    throw new Error("Model promotion refused an artifact that failed integrity verification.");
  }
}
