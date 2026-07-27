import { rm } from "node:fs/promises";
import path from "node:path";
import {
  type ComputeInventory,
  type GradeResult,
  type TaskAttemptResult,
} from "@openpond/contracts";
import {
  TrainingAdapterRegistry,
  TrainingDestinationRegistry,
} from "@openpond/training-sdk";
import type { SqliteStore } from "../store/store.js";
import {
  ExportTrainingDestination,
  PortablePreparationTrainingDestination,
  UnavailableTrainingDestination,
} from "./destinations.js";
import { listTrainingDestinationSecretRefs, writeTrainingDestinationSecret } from "./destination-secrets.js";
import { LocalCpuTrainingDestination } from "./local-cpu-destination.js";
import { FireworksTrainingDestination, type FireworksProviderCredential } from "./fireworks-destination.js";
import { createFireworksRftEnvironment, validateFireworksRftCallbackCredential } from "./fireworks-rft-environment.js";
import type { FireworksRftEvaluatorProvisioner } from "./fireworks-rft-evaluator.js";
import { createCrossSystemExpertBootstrapService } from "./cross-system-operations/expert-bootstrap-service.js";
import { createFireworksServingService } from "./fireworks-serving-service.js";
import { projectBaseModelCandidates } from "./base-model-candidates.js";
import type { ManagedModelBindingCallbacks } from "./managed-model-binding-coordinator.js";
import {
  createTrainingDatasetSelection,
  type ProjectDatasetArtifact,
} from "./training-dataset-selection.js";
import { isInside } from "./training-service-helpers.js";
import { createPortableDestinationAdapterRegistry } from "./portable-destination-engine.js";
import type { RegistryModelSearchResult } from "./model-registry-search.js";
import { createPortableModelRunService } from "./portable-model-run-service.js";
import { createPortableTrainingServiceSupport } from "./portable-training-service-support.js";
import { createTrainingArtifactExportService } from "./training-artifact-export-service.js";
import { createTrainingModelBindingService } from "./training-model-binding-service.js";
import { createTrainingPlanLifecycleService } from "./training-plan-lifecycle-service.js";
import {
  createTrainingModelConfigurationService,
  stopActiveFireworksServingSessions,
} from "./training-model-controls.js";

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
  projectDatasetArtifact?: ProjectDatasetArtifact;
  resolveDatasetTask?: (input: {
    tasksetId: string;
    taskId: string;
    split: "train" | "frozen_eval";
  }) => Promise<import("@openpond/contracts").TaskDataRecord>;
  fireworksRequest?: typeof fetch;
  provisionFireworksRftEvaluator?: FireworksRftEvaluatorProvisioner;
  fireworksRftPublicBaseUrl?: () => string | null;
  prepareModel?: (input: {
    modelId: string;
    revision: string | null;
  }) => Promise<unknown>;
  registerPortableAdapters?: (registry: TrainingAdapterRegistry) => void;
  connectedWorkerConfigured?: boolean;
  connectedEngineConfigured?: boolean;
  primeRawConfigured?: boolean;
  connectedWorkerImageDigest?: string | null;
  searchTrainingModels?: (query: string) => Promise<RegistryModelSearchResult[]>;
} & ManagedModelBindingCallbacks) {
  const registry = new TrainingDestinationRegistry();
  const {
    setModelPinned,
    updateModelConfiguration,
  } = createTrainingModelConfigurationService(deps.store);
  const resolveTaskset = (id: string) => deps.store.getTaskset(id);
  const {
    projectArtifactRows,
    resolveTrainingSelection,
  } = createTrainingDatasetSelection({
    storeDir: deps.storeDir,
    projectDatasetArtifact: deps.projectDatasetArtifact,
  });
  registry.register(new ExportTrainingDestination(resolveTaskset));
  const localCpu = new LocalCpuTrainingDestination({ store: deps.store, storeDir: deps.storeDir, projectDir: deps.localWorkerProjectDir, resolveModelPath: deps.resolveModelPath, modelArtifactStore: deps.modelArtifactStore });
  registry.register(localCpu);
  registry.register(
    deps.primeRawConfigured
      ? new PortablePreparationTrainingDestination("prime_hosted", {
          resolveTaskset,
          estimatedCostUsd: null,
          methods: ["grpo"],
          environmentPlacements: ["local"],
          assumptions: [
            "Prime provisions raw compute before the generic connected-worker bootstrap.",
            "A fresh provider quote is bounded by the available Prime wallet balance.",
          ],
          modelAllowlist: [
            "Qwen/Qwen3-0.6B",
            "Qwen/Qwen3-8B",
          ],
        })
      : new UnavailableTrainingDestination(
          "prime_hosted",
          "Prime raw compute requires a configured provider adapter and connected-worker bootstrap.",
          resolveTaskset,
        ),
  );
  const fireworks = new FireworksTrainingDestination({
    store: deps.store,
    storeDir: deps.storeDir,
    resolveCredential: deps.resolveFireworksCredential ?? (async () => null),
    recordCredentialValidation: deps.recordFireworksCredentialValidation,
    gradeAttempt: deps.gradeTaskAttempt,
    resolveTrainingSelection,
    resolveTask: deps.resolveDatasetTask,
    request: deps.fireworksRequest,
    provisionRftEvaluator: deps.provisionFireworksRftEvaluator,
    rftPublicBaseUrl: deps.fireworksRftPublicBaseUrl,
  });
  const fireworksRftEnvironment = createFireworksRftEnvironment({
    store: deps.store,
    resolveTask: deps.resolveDatasetTask,
    gradeAttempt: deps.gradeTaskAttempt,
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
  const modelBindings = createTrainingModelBindingService({
    store: deps.store,
    fireworksServing,
    deactivateManagedBinding: deps.deactivateManagedBinding,
    reactivateManagedBinding: deps.reactivateManagedBinding,
    activateManagedBinding: deps.activateManagedBinding,
  });
  const artifactExports = createTrainingArtifactExportService({
    store: deps.store,
    storeDir: deps.storeDir,
    localCpu,
  });
  registry.register(fireworks);
  registry.register(
    deps.connectedWorkerConfigured
      ? new PortablePreparationTrainingDestination("ssh_gpu", {
          resolveTaskset,
          estimatedCostUsd: 0,
          methods: ["grpo"],
          environmentPlacements: ["local"],
          assumptions: [
            "The user owns the connected GPU; OpenPond adds no provider charge.",
            "The exact signed worker image is already running at the configured endpoint.",
          ],
        })
      : new UnavailableTrainingDestination(
          "ssh_gpu",
          "Configure an authenticated connected worker endpoint.",
          resolveTaskset,
        ),
  );
  deps.registerDestinations?.(registry);
  const {
    adapters: portableAdapters,
    bridges: portableDestinationBridges,
  } = createPortableDestinationAdapterRegistry({
    destinations: registry,
    store: deps.store,
    catalog: () => portableCatalog(),
  });
  deps.registerPortableAdapters?.(portableAdapters);
  void localCpu.reconcile();
  void fireworks.reconcile();
  void fireworksServing.reconcile();

  async function destinations() { return Promise.all(registry.list().map((destination) => destination.capabilities())); }

  const portableSupport = createPortableTrainingServiceSupport({
    store: deps.store,
    destinations,
    adapters: portableAdapters,
    computeInventory: deps.computeInventory,
    revalidateCompute: deps.revalidateCompute,
    connectedWorkerConfigured: deps.connectedWorkerConfigured,
    connectedEngineConfigured: deps.connectedEngineConfigured,
    primeRawConfigured: deps.primeRawConfigured,
    connectedWorkerImageDigest: deps.connectedWorkerImageDigest,
    searchTrainingModels: deps.searchTrainingModels,
  });
  const portableCatalog = portableSupport.catalog;
  const prepareModelRun = portableSupport.prepare;

  const {
    createPlan,
    buildBundle,
    approve,
    launch,
    start,
    prepareStart,
    startPrepared,
  } = createTrainingPlanLifecycleService({
    store: deps.store,
    storeDir: deps.storeDir,
    registry,
    projectArtifactRows,
    revalidateCompute: deps.revalidateCompute,
    resolveApprovalActor: deps.resolveApprovalActor,
  });

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
    await stopActiveFireworksServingSessions(fireworksServing, {
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

  const portableModelRuns = createPortableModelRunService({
    store: deps.store,
    storeDir: deps.storeDir,
    adapters: portableAdapters,
    bridges: portableDestinationBridges,
    destinations: registry,
    catalog: portableCatalog,
    prepare: prepareModelRun,
    prepareStart,
    approve,
    prepareModel: deps.prepareModel,
  });

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

  const {
    importExternal,
    exportBundle,
    artifactDownload,
    modelPackageDownload,
  } = artifactExports;

  const {
    rejectModel,
    bindModel,
    rollbackModelBinding,
  } = modelBindings;

  async function saveCredential(input: { destinationId: string; value: string }) {
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

  return {
    registry,
    portableAdapters,
    destinations,
    portableCatalog,
    prepareModelRun,
    startModelRun: portableModelRuns.start,
    modelRunStatus: portableModelRuns.status,
    modelRunEvents: portableModelRuns.events,
    modelRunLogs: portableModelRuns.logs,
    modelRunArtifacts: portableModelRuns.artifacts,
    cancelModelRun: portableModelRuns.cancel,
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

}
