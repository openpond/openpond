import { access, cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  type GradeResult,
  type OpenPondProfileState,
  type TaskAttemptResult,
} from "@openpond/contracts";
import {
  TrainingAdapterRegistry,
  TrainingDestinationRegistry,
} from "@openpond/training-sdk";
import type { SqliteStore } from "../store/store.js";
import {
  PortablePreparationTrainingDestination,
} from "./destinations.js";
import { createCrossSystemExpertBootstrapService } from "./cross-system-operations/expert-bootstrap-service.js";
import { projectBaseModelCandidates } from "./base-model-candidates.js";
import type { ManagedModelBindingCallbacks } from "./managed-model-binding-coordinator.js";
import {
  createTrainingDatasetSelection,
  type ProjectDatasetArtifact,
} from "./training-dataset-selection.js";
import { isInside } from "./training-service-helpers.js";
import { createDestinationTrainingEngineRegistry } from "./managed-training-engine-registry.js";
import type { RegistryModelSearchResult } from "./model-registry-search.js";
import { createPortableModelRunService } from "./portable-model-run-service.js";
import { compileDesktopHarnessContext } from "./portable-evals-adapter.js";
import { createPortableTrainingServiceSupport } from "./portable-training-service-support.js";
import { createTrainingArtifactExportService } from "./training-artifact-export-service.js";
import { createTrainingModelBindingService } from "./training-model-binding-service.js";
import { createTrainingPlanLifecycleService } from "./training-plan-lifecycle-service.js";
import { createTrainingModelConfigurationService } from "./training-model-controls.js";
import type { TasksetWorkAttemptRuntime } from "./taskset-work-attempt-runner.js";

export function createTrainingService(deps: {
  store: SqliteStore;
  storeDir: string;
  registerDestinations?: (registry: TrainingDestinationRegistry) => void;
  resolveApprovalActor?: () => Promise<string | null>;
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
  tasksetWorkRuntime?: TasksetWorkAttemptRuntime;
  registerPortableAdapters?: (registry: TrainingAdapterRegistry) => void;
  resolveManagedTrainingAccess?: () => Promise<{
    apiBaseUrl: string;
    token: string;
    teamId: string;
  }>;
  searchTrainingModels?: (query: string) => Promise<RegistryModelSearchResult[]>;
  loadProfileState?: () => Promise<OpenPondProfileState>;
  resolveReleasedHarness?: () => Promise<{
    agentSnapshot: import("@openpond/harness").AgentSnapshot;
    harnessRelease: import("@openpond/harness").HarnessRelease;
  } | null>;
} & ManagedModelBindingCallbacks) {
  const registry = new TrainingDestinationRegistry();
  const {
    setModelPinned,
    updateModelConfiguration,
  } = createTrainingModelConfigurationService(deps.store);
  const resolveTaskset = (id: string) => deps.store.getTaskset(id);
  const { projectArtifactRows } = createTrainingDatasetSelection({
    storeDir: deps.storeDir,
    projectDatasetArtifact: deps.projectDatasetArtifact,
  });
  registry.register(
    new PortablePreparationTrainingDestination("openpond_managed", {
      resolveTaskset,
      estimatedCostUsd: null,
      methods: ["grpo"],
      environmentPlacements: ["local", "remote"],
      assumptions: [
        "OpenPond Managed selects qualified compute capacity after approval.",
        "The approved maximum spend is enforced before provider resources start.",
      ],
      modelAllowlist: ["Qwen/Qwen3-0.6B"],
    }),
  );
  const expertBootstrap = createCrossSystemExpertBootstrapService({
    store: deps.store,
    storeDir: deps.storeDir,
    resolveApprovalActor: deps.resolveApprovalActor,
  });
  const modelBindings = createTrainingModelBindingService({
    store: deps.store,
    deactivateManagedBinding: deps.deactivateManagedBinding,
    reactivateManagedBinding: deps.reactivateManagedBinding,
    activateManagedBinding: deps.activateManagedBinding,
  });
  const artifactExports = createTrainingArtifactExportService({
    store: deps.store,
    storeDir: deps.storeDir,
  });
  deps.registerDestinations?.(registry);
  const portableAdapters = createDestinationTrainingEngineRegistry({
    destinations: registry,
    store: deps.store,
    storeDir: deps.storeDir,
    resolveManagedAccess: deps.resolveManagedTrainingAccess,
    catalog: () => portableCatalog(),
  });
  deps.registerPortableAdapters?.(portableAdapters);

  async function destinations() { return Promise.all(registry.list().map((destination) => destination.capabilities())); }

  const portableSupport = createPortableTrainingServiceSupport({
    store: deps.store,
    destinations,
    adapters: portableAdapters,
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
  });

  async function deleteTaskset(tasksetId: string) {
    const taskset = await deps.store.getTaskset(tasksetId);
    if (!taskset) throw new Error("Taskset not found.");
    if (taskset.purpose === "benchmark" && taskset.benchmark?.source === "builtin") {
      throw new Error("Built-in benchmark Tasksets are read-only.");
    }
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
    await rm(path.join(managedTrainingRoot, "tasksets", taskset.id), { force: true, recursive: true });
    await deps.store.deleteTasksetData(tasksetId);
    return { deleted: true, tasksetId };
  }

  const portableModelRuns = createPortableModelRunService({
    store: deps.store,
    storeDir: deps.storeDir,
    adapters: portableAdapters,
    catalog: portableCatalog,
    prepare: prepareModelRun,
    prepareStart,
    approve,
    resolveReleasedHarness: async ({ taskset, modelRun }) => {
      const releasedHarness = await deps.resolveReleasedHarness?.() ?? null;
      const profile = !releasedHarness && deps.loadProfileState ? await deps.loadProfileState() : null;
      const context = compileDesktopHarnessContext({
        taskset,
        profile,
        releasedHarness,
        model: {
          providerId: "openpond",
          modelId: modelRun.baseModel!.modelId,
        },
      });
      if (profile?.sourcePath) {
        await materializeHarnessSource({
          sourcePath: profile.sourcePath,
          storeDir: deps.storeDir,
          harnessHash: context.harnessRelease.contentHash,
        });
      }
      return {
        harnessRelease: {
          id: context.harnessRelease.id,
          contentHash: context.harnessRelease.contentHash,
        },
        tasksetRelease: {
          id: context.tasksetRelease.id,
          contentHash: context.tasksetRelease.contentHash,
        },
      };
    },
  });
  void portableModelRuns.reconcileActive({ force: true });

  async function activity() {
    await portableModelRuns.reconcileActive();
    return { jobs: await deps.store.listTrainingJobs() };
  }

  async function state() {
    const activeState = await activity();
    const [
      plans,
      bundles,
      jobs,
      artifacts,
      models,
      rolloutReceipts,
      modelBindings,
      destinationCapabilities,
    ] = await Promise.all([
      deps.store.listTrainingPlans(),
      deps.store.listTrainingBundles(),
      Promise.resolve(activeState.jobs),
      deps.store.listTrainingArtifacts(),
      deps.store.listModelArtifactLineage(),
      deps.store.listRolloutTrajectoryReceipts(),
      deps.store.listModelBindings(),
      destinations(),
    ]);
    return {
      plans,
      bundles,
      jobs,
      artifacts,
      models,
      rolloutReceipts,
      modelBindings,
      destinations: destinationCapabilities,
      baseModelCandidates: projectBaseModelCandidates({ destinations: destinationCapabilities }),
    };
  }

  const {
    exportBundle,
    artifactDownload,
    modelPackageDownload,
  } = artifactExports;

  const {
    rejectModel,
    bindModel,
    rollbackModelBinding,
  } = modelBindings;

  async function cancelJob(jobId: string) {
    const job = await deps.store.getTrainingJob(jobId);
    if (!job) throw new Error("Training job not found.");
    return registry.get(job.destinationId).cancel(job.id);
  }

  async function refreshManagedRunEvidence(jobId: string): Promise<void> {
    const job = await deps.store.getTrainingJob(jobId);
    if (!job || job.destinationId !== "openpond_managed") return;
    await portableAdapters.refreshManagedEvidence(job);
  }

  async function close(): Promise<void> {
    await Promise.all([
      portableAdapters.close(),
    ]);
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
    activity,
    state,
    exportBundle,
    artifactDownload,
    modelPackageDownload,
    rejectModel,
    bindModel,
    rollbackModelBinding,
    updateModelConfiguration,
    setModelPinned,
    cancelJob,
    refreshManagedRunEvidence,
    close,
  };

}

async function materializeHarnessSource(input: {
  sourcePath: string;
  storeDir: string;
  harnessHash: string;
}): Promise<void> {
  const root = path.join(
    input.storeDir,
    "training",
    "harnesses",
    input.harnessHash,
    "source",
  );
  try {
    await access(root);
    return;
  } catch {
    // Materialize once per immutable Harness hash.
  }
  await mkdir(path.dirname(root), { recursive: true });
  const temporary = `${root}.materializing-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  try {
    await cp(path.resolve(input.sourcePath), temporary, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await rename(temporary, root).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
