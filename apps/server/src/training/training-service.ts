import { access, cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  type GradeResult,
  type OpenPondProfileState,
  type ModelProject,
  type RewardModelVersion,
  RewardModelRunSchema,
  type RewardModelRecipe,
  type TaskAttemptResult,
  type Taskset,
} from "@openpond/contracts";
import type { PreferenceDatasetRelease, TasksetRelease } from "@openpond/evals";
import { contentHash } from "@openpond/harness";
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
import {
  buildManagedRewardModelLaunchInput,
  managedRewardModelIdempotencyKey,
  type ManagedRewardModelBase,
} from "./reward-model-launch-input.js";
import { projectQualifiedRewardModel } from "./reward-model-qualification-projection.js";
import {
  loadRewardModelQualificationReport,
  saveRewardModelQualificationReport,
} from "./reward-model-qualification-store.js";
import { bindLearnedPreferenceReward } from "./learned-preference-reward-binding.js";
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
    resolveReleasedHarness: async ({ taskset, modelProject }) => {
      const releasedHarness = await deps.resolveReleasedHarness?.() ?? null;
      const profile = !releasedHarness && deps.loadProfileState ? await deps.loadProfileState() : null;
      const context = compileDesktopHarnessContext({
        taskset,
        profile,
        releasedHarness,
        model: {
          providerId: "openpond",
          modelId: modelProject.trainingSetup.baseModel!.modelId,
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

  async function launchRewardModel(input: {
    id: string;
    rewardModelId: string;
    modelProject: ModelProject;
    taskset: Taskset;
    tasksetRelease: TasksetRelease;
    dataset: PreferenceDatasetRelease;
    recipe: RewardModelRecipe;
    managedBaseModel: ManagedRewardModelBase;
  }) {
    if (
      input.recipe.tasksetRelease.id !== input.dataset.tasksetRelease.id ||
      input.recipe.tasksetRelease.contentHash !== input.dataset.tasksetRelease.contentHash
    ) {
      throw new Error("Reward Model recipe and D0 must pin the same Taskset release.");
    }
    if (
      input.tasksetRelease.id !== input.dataset.tasksetRelease.id ||
      input.tasksetRelease.contentHash !== input.dataset.tasksetRelease.contentHash
    ) {
      throw new Error("Reward Model Run must use the exact Taskset release pinned by D0.");
    }
    const now = new Date().toISOString();
    const recipeHash = contentHash(input.recipe);
    const prepared = RewardModelRunSchema.parse({
      schemaVersion: "openpond.rewardModelRun.v1",
      id: input.id,
      rewardModelId: input.rewardModelId,
      rewardModelVersionId: null,
      profileId: input.taskset.profileId,
      role: "reward",
      scope: input.recipe.runScope,
      status: "prepared",
      taskset: {
        id: input.taskset.id,
        revision: input.tasksetRelease.revision,
        contentHash: input.tasksetRelease.contentHash,
      },
      tasksetRelease: {
        id: input.tasksetRelease.id,
        contentHash: input.tasksetRelease.contentHash,
      },
      preferenceDatasetRelease: {
        id: input.dataset.id,
        contentHash: input.dataset.contentHash,
      },
      recipeRelease: {
        id: `reward-model-recipe:${recipeHash.slice(0, 24)}`,
        contentHash: recipeHash,
      },
      destinationId: "openpond_managed",
      quote: { maximumSpendUsd: input.recipe.resourceLimits.maximumSpendUsd, hourlyCostUsd: null },
      managedRunId: null,
      progress: { completedSteps: 0, totalSteps: input.recipe.optimizer.maxSteps, latestLoss: null },
      receipt: null,
      qualificationReport: null,
      accruedSpendUsd: null,
      failureOwner: null,
      failure: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    });
    await deps.store.saveRewardModelRun(prepared);
    try {
      const attempts = await deps.store.listTaskAttempts(input.taskset.id);
      const request = await buildManagedRewardModelLaunchInput({
        idempotencyKey: managedRewardModelIdempotencyKey({
          runId: prepared.id,
          recipeHash,
        }),
        name: `OpenPond Managed Reward · ${input.rewardModelId}`.slice(0, 191),
        sourceRunRef: `openpond:reward-model-run:${prepared.id}`,
        taskset: prepared.taskset,
        tasksetRelease: input.tasksetRelease,
        dataset: input.dataset,
        recipe: input.recipe,
        managedBaseModel: input.managedBaseModel,
        attempts,
      });
      const launched = await portableAdapters.createRewardModelLaunch({
        request,
        modelProjectId: input.modelProject.id,
        processorRelease: input.recipe.processorRelease,
        recipe: input.recipe,
        approvedAt: prepared.startedAt,
      });
      return deps.store.saveRewardModelRun({
        ...prepared,
        status: "running",
        managedRunId: launched.job.id,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      return deps.store.saveRewardModelRun({
        ...prepared,
        status: "failed",
        failureOwner: "authoring",
        failure: error instanceof Error ? error.message : "Reward Model launch failed.",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async function learnedPreferenceRewardBinding(input: {
    tasksetId: string;
    rewardModelVersionId: string;
  }) {
    const version = await deps.store.getRewardModelVersion(input.rewardModelVersionId);
    if (!version || version.taskset.id !== input.tasksetId) {
      throw new Error("Reward Model Version was not found for this Taskset.");
    }
    const run = (await deps.store.listRewardModelRuns({ tasksetId: input.tasksetId }))
      .find((candidate) => candidate.rewardModelVersionId === version.id && candidate.status === "succeeded");
    if (!run?.qualificationReport || !run.receipt?.managedExecutionReceipt) {
      throw new Error("Reward Model Version has no immutable qualification report.");
    }
    const report = await loadRewardModelQualificationReport({
      storeDir: deps.storeDir,
      id: run.qualificationReport.id,
      contentHash: run.qualificationReport.contentHash,
    });
    if (!report) {
      throw new Error("Reward Model qualification report payload is unavailable.");
    }
    const rewardComposerCore = {
      schemaVersion: "openpond.rewardComposer.v1",
      taskset: version.taskset,
      rewardModelVersion: { id: version.id, contentHash: version.contentHash },
      qualificationReport: run.qualificationReport,
    };
    const rewardComposerHash = contentHash(rewardComposerCore);
    return bindLearnedPreferenceReward({
      version,
      qualificationReport: report,
      rewardComposerRelease: {
        id: `reward-composer:${rewardComposerHash.slice(0, 24)}`,
        contentHash: rewardComposerHash,
      },
      executionReceipt: run.receipt.managedExecutionReceipt,
    });
  }

  async function retryRewardModelQualification(
    runId: string,
    retryRunId: string,
  ) {
    const run = await deps.store.getRewardModelRun(runId);
    if (
      !run ||
      run.status !== "failed" ||
      run.failureOwner !== "qualification" ||
      !run.managedRunId ||
      run.rewardModelVersionId
    ) {
      throw new Error("Only a failed Reward Model qualification with a completed managed Run can be retried.");
    }
    const remote = await portableAdapters.rewardModelJob(run.managedRunId);
    if (remote.job.state !== "completed") {
      throw new Error("Reward Model qualification retry requires a completed managed Run.");
    }
    if (await deps.store.getRewardModelRun(retryRunId)) {
      throw new Error("Reward Model qualification retry ID already exists.");
    }
    const now = new Date().toISOString();
    const retryRun = RewardModelRunSchema.parse({
      ...run,
      id: retryRunId,
      status: "running",
      rewardModelVersionId: null,
      receipt: null,
      qualificationReport: null,
      failureOwner: null,
      failure: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    });
    await deps.store.saveRewardModelRun(retryRun);
    await reconcileRewardModelRuns();
    const reconciled = await deps.store.getRewardModelRun(retryRunId);
    if (!reconciled) {
      throw new Error("Reward Model Run disappeared during qualification retry.");
    }
    return reconciled;
  }

  async function cancelRewardModelRun(runId: string) {
    const run = await deps.store.getRewardModelRun(runId);
    if (!run || run.status !== "running" || !run.managedRunId) {
      throw new Error("Only a running managed Reward Model Run can be cancelled.");
    }
    const remote = await portableAdapters.rewardModelJob(run.managedRunId);
    await portableAdapters.cancelRewardModelJob(run.managedRunId, remote.job.version);
    await reconcileRewardModelRuns();
    return (await deps.store.getRewardModelRun(runId)) ?? run;
  }

  async function activity() {
    await portableModelRuns.reconcileActive();
    await reconcileRewardModelRuns();
    return { jobs: await deps.store.listTrainingJobs() };
  }

  async function reconcileRewardModelRuns() {
    const active = (await deps.store.listRewardModelRuns()).filter((run) =>
      run.status === "prepared" || run.status === "running",
    );
    await Promise.all(active.map(async (run) => {
      if (!run.managedRunId) return;
      try {
        const remote = await portableAdapters.rewardModelJob(run.managedRunId);
        const upload = remote.resources.find((resource) =>
          resource.kind === "artifact_upload" && resource.state === "consumed",
        );
        const uploadMetadata = recordOrNull(upload?.metadata);
        const evidence = uploadMetadata?.evidence;
        const evidenceRecord = evidence && typeof evidence === "object" && !Array.isArray(evidence)
          ? evidence as Record<string, unknown>
          : null;
        const completedSteps = typeof evidenceRecord?.steps === "number"
          && Number.isInteger(evidenceRecord.steps)
          ? evidenceRecord.steps
          : run.progress.completedSteps;
        const latestLoss = typeof evidenceRecord?.loss === "number" && Number.isFinite(evidenceRecord.loss)
          ? evidenceRecord.loss
          : run.progress.latestLoss;
        if (completedSteps !== run.progress.completedSteps || latestLoss !== run.progress.latestLoss) {
          await deps.store.saveRewardModelRun({
            ...run,
            progress: { ...run.progress, completedSteps, latestLoss },
            updatedAt: new Date().toISOString(),
          });
        }
        if (remote.job.state === "failed" || remote.job.state === "cancelled") {
          await deps.store.saveRewardModelRun({
            ...run,
            status: remote.job.state === "cancelled" ? "cancelled" : "failed",
            failureOwner: "provider",
            failure: remote.job.terminalReason ?? "Managed Reward Model job did not complete.",
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          return;
        }
        if (remote.job.state === "completed") {
          try {
            const resourceMetadata = uploadMetadata;
            const inventory = Array.isArray(resourceMetadata?.inventory)
              ? resourceMetadata.inventory.filter(isInventoryFile)
              : [];
            const checkpointPrefix = typeof resourceMetadata?.objectPrefix === "string"
              ? resourceMetadata.objectPrefix
              : "";
            const artifactSha256 = typeof resourceMetadata?.artifactSha256 === "string"
              ? resourceMetadata.artifactSha256
              : "";
            const rewardBase = recordOrNull(resourceMetadata?.baseModel);
            const rewardProcessor = recordOrNull(resourceMetadata?.processor);
            const harness = recordOrNull(resourceMetadata?.harnessRunManifest);
            const taskset = await deps.store.getTaskset(run.taskset.id);
            if (!taskset || !rewardBase || !rewardProcessor || !harness || !checkpointPrefix || !artifactSha256 || !remote.executionReceiptRef) {
              throw new Error("Completed managed Reward Model job is missing immutable launch lineage.");
            }
            const versionNumber = nextRewardModelVersionNumber(
              await deps.store.listRewardModelVersions(),
              run.rewardModelId,
            );
            const version = projectQualifiedRewardModel({
              run,
              baseModel: {
                schemaVersion: "openpond.baseModelPreference.v1",
                modelId: stringField(rewardBase, "repoId"),
                revision: stringField(rewardBase, "revision"),
                tokenizerRevision: stringField(rewardBase, "revision"),
                chatTemplateHash: null,
                modelAssetId: null,
                source: "managed",
              },
              runtime: managedRewardModelRuntime(rewardBase, rewardProcessor),
              resolvedBundleHash: stringField(harness, "resolvedBundleHash"),
              profileRelease: { id: run.profileId, revision: taskset.revision, contentHash: taskset.contentHash },
              harnessRelease: objectRef(harness.harnessRelease, "harness release"),
              grader: taskset.preferenceComparison
                ? { id: taskset.preferenceComparison.releaseId, contentHash: taskset.preferenceComparison.releaseHash }
                : { id: `preference-dataset:${run.preferenceDatasetRelease.id}`, contentHash: run.preferenceDatasetRelease.contentHash },
              providerRunId: run.managedRunId,
              versionNumber,
              checkpointPrefix,
              artifactSha256,
              inventory,
              evidence: evidenceRecord ?? {},
              cleanup: {
                computeReleased: remote.resources.every((resource) => resource.state !== "active"),
                providerTerminalObserved: remote.job.cleanupAttestation !== null && remote.job.cleanupAttestation !== undefined,
              },
              managedExecutionReceipt: remote.executionReceiptRef,
              createdAt: new Date().toISOString(),
            });
            await saveRewardModelQualificationReport({
              storeDir: deps.storeDir,
              report: version.report,
            });
            await deps.store.saveRewardModelVersion(version.version);
            await deps.store.saveRewardModelRun({
              ...run,
              status: "succeeded",
              rewardModelVersionId: version.version.id,
              receipt: version.receipt,
              qualificationReport: { id: version.report.id, contentHash: version.report.contentHash },
              progress: { ...run.progress, completedSteps: run.progress.totalSteps, latestLoss },
              completedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          } catch (error) {
            await deps.store.saveRewardModelRun({
              ...run,
              status: "failed",
              failureOwner: "qualification",
              failure: error instanceof Error ? error.message : "Reward Model qualification projection failed.",
              completedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
        }
      } catch {
        // The durable run remains inspectable and is retried on the next state refresh.
      }
    }));
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
      rewardModelVersions,
      rewardModelRuns,
    ] = await Promise.all([
      deps.store.listTrainingPlans(),
      deps.store.listTrainingBundles(),
      Promise.resolve(activeState.jobs),
      deps.store.listTrainingArtifacts(),
      deps.store.listModelArtifactLineage(),
      deps.store.listRolloutTrajectoryReceipts(),
      deps.store.listModelBindings(),
      destinations(),
      deps.store.listRewardModelVersions(),
      deps.store.listRewardModelRuns(),
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
      rewardModelVersions,
      rewardModelRuns,
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
    launchRewardModel,
    retryRewardModelQualification,
    cancelRewardModelRun,
    learnedPreferenceRewardBinding,
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
    createPreferenceCalibrationBatch: (request: unknown) => portableAdapters.createCalibrationBatch(request),
    preferenceCalibrationBatch: (jobId: string) => portableAdapters.calibrationBatch(jobId),
    close,
  };

}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) throw new Error(`Managed Reward Model ${key} is missing.`);
  return field;
}

export function managedRewardModelRuntime(
  value: Record<string, unknown>,
  processor: Record<string, unknown>,
): NonNullable<RewardModelVersion["runtime"]> {
  const source = stringField(value, "source");
  if (source !== "huggingface") {
    throw new Error("Managed Reward Model runtime must be a Hugging Face release.");
  }
  const repoId = stringField(value, "repoId");
  const revision = stringField(value, "revision");
  const configHash = stringField(value, "configHash");
  const tokenizerHash = stringField(value, "tokenizerHash");
  const licenseId = stringField(value, "licenseId");
  const gated = value.gated === true;
  const processorRepository = stringField(processor, "repository");
  const processorRevision = stringField(processor, "revision");
  const processorConfigHash = stringField(processor, "configHash");
  if (processorRepository !== repoId || processorRevision !== revision) {
    throw new Error("Managed Reward Model processor must match its immutable base release.");
  }
  return {
    baseModel: { source, repoId, revision, configHash, tokenizerHash, licenseId, gated },
    processor: {
      repository: processorRepository,
      revision: processorRevision,
      configHash: processorConfigHash,
    },
  };
}

export function nextRewardModelVersionNumber(
  versions: RewardModelVersion[],
  rewardModelId: string,
): number {
  return versions
    .filter((version) => version.modelId === rewardModelId)
    .reduce((maximum, version) => Math.max(maximum, version.version), 0) + 1;
}

function objectRef(value: unknown, label: string): { id: string; contentHash: string } {
  const parsed = recordOrNull(value);
  if (!parsed) throw new Error(`Managed Reward Model ${label} is missing.`);
  return { id: stringField(parsed, "id"), contentHash: stringField(parsed, "contentHash") };
}

function isInventoryFile(value: unknown): value is { path: string; sha256: string; sizeBytes: number } {
  const parsed = recordOrNull(value);
  return Boolean(parsed && typeof parsed.path === "string" && typeof parsed.sha256 === "string" && typeof parsed.sizeBytes === "number");
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
