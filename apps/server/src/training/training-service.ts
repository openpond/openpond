import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { loadOpenPondProfileState } from "@openpond/cloud";
import {
  LocalModelChatConfigurationSchema,
  SftRecipeSchema,
  TrainingApprovalSchema,
  TrainingPlanSchema,
  type TrainingDestinationId,
  type ComputeInventory,
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

export function createTrainingService(deps: {
  store: SqliteStore;
  storeDir: string;
  localWorkerProjectDir: string;
  registerDestinations?: (registry: TrainingDestinationRegistry) => void;
  revalidateCompute?: () => Promise<void>;
  resolveModelPath?: (modelId: string, revision: string) => Promise<string | null>;
  modelArtifactStore?: () => Promise<string | null>;
  computeInventory?: () => Promise<ComputeInventory | null>;
}) {
  const registry = new TrainingDestinationRegistry();
  const resolveTaskset = (id: string) => deps.store.getTaskset(id);
  registry.register(new ExportTrainingDestination(resolveTaskset));
  const localCpu = new LocalCpuTrainingDestination({ store: deps.store, storeDir: deps.storeDir, projectDir: deps.localWorkerProjectDir, resolveModelPath: deps.resolveModelPath, modelArtifactStore: deps.modelArtifactStore });
  registry.register(localCpu);
  registry.register(new UnavailableTrainingDestination("openpond_managed", "OpenPond Managed is a client stub; the managed service is not implemented in this repository.", resolveTaskset));
  registry.register(new UnavailableTrainingDestination("custom", "Register a custom TrainingDestination implementation before launch.", resolveTaskset));
  registry.register(new UnavailableTrainingDestination("prime_hosted", "Prime hosted training is not connected in this open-source build.", resolveTaskset));
  registry.register(new UnavailableTrainingDestination("fireworks", "Fireworks training is not connected in this open-source build.", resolveTaskset));
  registry.register(new HardwareGatedTrainingDestination("local_cuda", { inventory: deps.computeInventory ?? (async () => null), resolveTaskset }));
  registry.register(new HardwareGatedTrainingDestination("local_mlx", { inventory: deps.computeInventory ?? (async () => null), resolveTaskset }));
  registry.register(new UnavailableTrainingDestination("ssh_gpu", "User-owned SSH GPU execution is deferred until its worker conformance suite is complete.", resolveTaskset));
  deps.registerDestinations?.(registry);
  void localCpu.reconcile();

  async function destinations() { return Promise.all(registry.list().map((destination) => destination.capabilities())); }

  async function createPlan(input: { tasksetId: string; destinationId: TrainingDestinationId; recipe: unknown; exportApproved?: boolean; retentionDays?: number | null; region?: string | null }) {
    const taskset = await deps.store.getTaskset(input.tasksetId);
    if (!taskset) throw new Error("Taskset not found.");
    if (!taskset.readiness?.ready) throw new Error("Taskset is not ready for training. Resolve readiness blockers first.");
    const recipe = SftRecipeSchema.parse(input.recipe);
    const draft = createTrainingPlan({ taskset, destinationId: input.destinationId, recipe, exportApproved: input.exportApproved, retentionDays: input.retentionDays, region: input.region });
    const compatibility = await registry.get(input.destinationId).validate(draft);
    const plan = TrainingPlanSchema.parse({ ...draft, compatibility, contentHash: contentHash({ ...draft, compatibility, contentHash: "" }) });
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
    const jobIds = new Set(relatedJobs.map((job) => job.id));
    const managedTrainingRoot = path.resolve(deps.storeDir, "training");
    for (const artifact of artifacts.filter((artifact) => jobIds.has(artifact.jobId))) {
      const artifactPath = path.resolve(artifact.path);
      if (isInside(managedTrainingRoot, artifactPath)) await rm(artifactPath, { force: true, recursive: true });
    }
    for (const planId of planIds) await rm(path.join(managedTrainingRoot, "bundles", planId), { force: true, recursive: true });
    const profile = await loadOpenPondProfileState();
    if (profile.sourcePath && (profile.activeProfile ?? "default") === taskset.profileId) {
      await rm(path.join(profile.sourcePath, "tasksets", taskset.id), { force: true, recursive: true });
    }
    await deps.store.deleteTasksetData(tasksetId);
    return { deleted: true, tasksetId };
  }

  async function approve(input: { planId: string; bundleId: string; approvedBy?: string; maximumCostUsd?: number | null }) {
    const plan = await deps.store.getTrainingPlan(input.planId);
    const bundle = await deps.store.getTrainingBundle(input.bundleId);
    if (!plan || !bundle || bundle.planId !== plan.id) throw new Error("Training Plan and Bundle do not match.");
    if (!plan.compatibility.compatible) throw new Error("Incompatible Training Plans cannot be approved.");
    const recipe = SftRecipeSchema.parse(plan.recipe);
    const approval = TrainingApprovalSchema.parse({ schemaVersion: "openpond.trainingApproval.v1", id: `training_approval_${randomUUID()}`, planId: plan.id, bundleHash: bundle.contentHash, destinationId: plan.destinationId, modelId: recipe.baseModel.id, method: recipe.method, parameterization: recipe.parameterization, maximumCostUsd: input.maximumCostUsd ?? plan.estimatedCostUsd, approvedBy: input.approvedBy ?? "local_user", approvedAt: new Date().toISOString() });
    return deps.store.saveTrainingApproval(approval);
  }

  async function launch(input: { planId: string; approvalId: string }) {
    const plan = await deps.store.getTrainingPlan(input.planId);
    const approval = await deps.store.getTrainingApproval(input.approvalId);
    if (!plan || !approval || approval.planId !== plan.id || approval.destinationId !== plan.destinationId) throw new Error("Training approval does not match this plan.");
    const bundle = await deps.store.findTrainingBundleByPlanAndHash(plan.id, approval.bundleHash);
    if (!bundle) throw new Error("Approved Training Bundle was not found.");
    const job = await registry.get(plan.destinationId).launch(plan, approval);
    await deps.store.saveTrainingJob(job);
    return job;
  }

  async function start(input: { tasksetId: string; destinationId: TrainingDestinationId; recipe: unknown; exportApproved?: boolean; maximumCostUsd?: number | null }) {
    await deps.revalidateCompute?.();
    const plan = await createPlan({ tasksetId: input.tasksetId, destinationId: input.destinationId, recipe: input.recipe, exportApproved: input.exportApproved });
    const bundle = await buildBundle(plan.id);
    const approval = await approve({ planId: plan.id, bundleId: bundle.manifest.id, maximumCostUsd: input.maximumCostUsd });
    await deps.revalidateCompute?.();
    const job = await launch({ planId: plan.id, approvalId: approval.id });
    return { plan, bundle: bundle.manifest, approval, job };
  }

  async function state() {
    const [plans, bundles, jobs, artifacts, models, destinationCapabilities, secretRefs] = await Promise.all([deps.store.listTrainingPlans(), deps.store.listTrainingBundles(), deps.store.listTrainingJobs(), deps.store.listTrainingArtifacts(), deps.store.listModelArtifactLineage(), destinations(), listTrainingDestinationSecretRefs(path.join(deps.storeDir, "secrets"))]);
    return { plans, bundles, jobs, artifacts, models, destinations: destinationCapabilities, credentialRefs: secretRefs };
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

  async function rejectModel(input: { modelId: string; reason: string }) {
    const model = await deps.store.getModelArtifactLineage(input.modelId);
    if (!model) throw new Error("Imported model not found.");
    return deps.store.saveModelArtifactLineage({ ...model, status: "rejected", rejectedAt: new Date().toISOString(), rejectionReason: input.reason });
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

  async function saveCredential(input: { destinationId: string; value: string }) {
    if (input.destinationId === "openpond_managed") throw new Error("OpenPond Managed uses account authentication, not a local BYOK credential.");
    return writeTrainingDestinationSecret({ directory: path.join(deps.storeDir, "secrets"), destinationId: input.destinationId, value: input.value, timestamp: new Date().toISOString() });
  }

  async function close(): Promise<void> { await localCpu.close(); }

  return { registry, destinations, createPlan, buildBundle, deleteTaskset, approve, launch, start, state, importExternal, exportBundle, artifactDownload, rejectModel, updateModelConfiguration, saveCredential, close };
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
