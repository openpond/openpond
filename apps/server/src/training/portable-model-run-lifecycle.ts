import path from "node:path";

import {
  ModelArtifactLineageSchema,
  ModelRunSchema,
  ModelVersionSchema,
  TrainingJobSourceSnapshotSchema,
  TrainingJobSchema,
  type ModelRun,
  type ModelComparisonEntryRef,
  type ModelProject,
  type Taskset,
  type TrainingArtifacts,
  type TrainingExecutionRef,
  type TrainingExecutionStatus,
  type TrainingJob,
  type TrainingJobSourceSnapshot,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";
import { importPortableModelRunArtifacts } from "./portable-model-run-artifacts.js";

type PortableReleaseGraph = {
  resolvedBundleHash: string;
  profileRelease: {
    id: string;
    revision: number;
    contentHash: string;
  };
  harnessRelease: {
    id: string;
    contentHash: string;
  };
  agentRelease: {
    id: string;
    contentHash: string;
  } | null;
  grader: {
    id: string;
    contentHash: string;
  };
};

type PortableModelVersionReservation = {
  id: string;
  version: number;
};

export async function preparePortableModelRunLifecycle(input: {
  store: SqliteStore;
  modelProject: ModelProject;
  modelRunId: string;
  taskset: Taskset;
  sourceProjectRevision: number;
  releaseGraph: PortableReleaseGraph;
  maximumSpendUsd: number | null;
  startedAt: string;
  comparisonSeriesEntry?: ModelComparisonEntryRef | null;
}): Promise<{
  modelRun: ModelRun;
  targetVersion: PortableModelVersionReservation;
  sourceSnapshot: TrainingJobSourceSnapshot;
}> {
  const setup = input.modelProject.trainingSetup;
  const baseModel = setup.baseModel;
  const method = setup.method;
  const destinationId = setup.destinationId;
  if (!baseModel || !method || !destinationId || !setup.tasksetRef) {
    throw new Error(
      "Portable Model Run lifecycle requires an exact saved run.",
    );
  }
  const existingRun = await input.store.getModelRun(input.modelRunId);
  if (existingRun) {
    throw new Error(
      `Canonical Model Run ${input.modelRunId} already exists with status ${existingRun.status}.`,
    );
  }
  const versions = await input.store.listModelVersions({
    modelId: input.modelProject.id,
  });
  const baseVersion = versions.find((version) => version.version === 0);
  if (baseVersion) {
    if (
      baseVersion.kind !== "base_reference"
      || baseVersion.profileId !== input.modelProject.profileId
      || baseVersion.baseModel.modelId !== baseModel.modelId
      || baseVersion.baseModel.revision !== baseModel.revision
      || baseVersion.baseModel.tokenizerRevision
        !== baseModel.tokenizerRevision
      || baseVersion.baseModel.chatTemplateHash
        !== baseModel.chatTemplateHash
    ) {
      throw new Error(
        "Existing base Model Version does not match this portable run.",
      );
    }
  } else {
    const core = {
      schemaVersion: "openpond.modelVersion.v1" as const,
      id: modelVersionId(input.modelProject.id, 0),
      modelId: input.modelProject.id,
      profileId: input.modelProject.profileId,
      version: 0,
      kind: "base_reference" as const,
      status: "available" as const,
      baseModel,
      taskset: setup.tasksetRef,
      releaseGraph: input.releaseGraph,
      artifactLineageId: null,
      adapterStatus: "not_trained" as const,
      createdAt: input.startedAt,
    };
    await input.store.saveModelVersion(
      ModelVersionSchema.parse({
        ...core,
        contentHash: contentHash(core),
      }),
    );
  }
  const modelRuns = await input.store.listModelRuns({
    modelId: input.modelProject.id,
  });
  const reservedIds = new Set([
    ...versions.map((version) => version.id),
    ...modelRuns.map((run) => run.modelVersionId),
  ]);
  let targetVersionNumber = 1;
  while (
    reservedIds.has(
      modelVersionId(input.modelProject.id, targetVersionNumber),
    )
  ) {
    targetVersionNumber += 1;
  }
  const targetVersion = {
    id: modelVersionId(input.modelProject.id, targetVersionNumber),
    version: targetVersionNumber,
  };
  const modelRun = await input.store.saveModelRun(
    ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1",
      id: input.modelRunId,
      modelId: input.modelProject.id,
      modelVersionId: targetVersion.id,
      profileId: input.modelProject.profileId,
      kind: "training",
      status: "prepared",
      method,
      destinationId,
      taskset: setup.tasksetRef,
      comparisonSeriesEntry: input.comparisonSeriesEntry ?? null,
      harnessRelease: input.releaseGraph.harnessRelease,
      quote: {
        maximumSpendUsd: input.maximumSpendUsd ?? 0,
        hourlyCostUsd: null,
      },
      reward: null,
      receipt: null,
      adapterArtifactLineageId: null,
      failure: null,
      startedAt: input.startedAt,
      completedAt: null,
      updatedAt: input.startedAt,
    }),
  );
  const sourceSnapshot = TrainingJobSourceSnapshotSchema.parse({
    schemaVersion: "openpond.trainingJobSourceSnapshot.v1",
    modelProjectId: input.modelProject.id,
    sourceProjectRevision: input.sourceProjectRevision,
    profileId: input.modelProject.profileId,
    taskset: setup.tasksetRef,
    tasksetRelease: setup.tasksetRelease,
    harnessRelease: setup.harnessRelease,
    baseModel,
    method,
  });
  return { modelRun, targetVersion, sourceSnapshot };
}

export async function markPortableModelRunRunning(input: {
  store: SqliteStore;
  modelRunId: string;
  startedAt: string;
}): Promise<ModelRun> {
  const modelRun = await requiredModelRun(input.store, input.modelRunId);
  if (isTerminal(modelRun.status)) return modelRun;
  return input.store.saveModelRun(
    ModelRunSchema.parse({
      ...modelRun,
      status: "running",
      startedAt: input.startedAt,
      updatedAt: input.startedAt,
    }),
  );
}

export async function failPreparedPortableModelRun(input: {
  store: SqliteStore;
  modelRunId: string;
  error: unknown;
  completedAt?: string;
}): Promise<ModelRun> {
  const modelRun = await requiredModelRun(input.store, input.modelRunId);
  if (isTerminal(modelRun.status)) return modelRun;
  const completedAt = input.completedAt ?? new Date().toISOString();
  return input.store.saveModelRun(
    ModelRunSchema.parse({
      ...modelRun,
      status: "failed",
      failure: safeError(input.error),
      completedAt,
      updatedAt: completedAt,
    }),
  );
}

export async function reconcilePortableModelRunLifecycle(input: {
  store: SqliteStore;
  storeDir: string;
  modelRunId: string;
  job: TrainingJob;
  executionRef: TrainingExecutionRef;
  status: TrainingExecutionStatus;
  artifacts?: TrainingArtifacts | null;
  failure?: string | null;
}): Promise<ModelRun> {
  const current = await requiredModelRun(input.store, input.modelRunId);
  if (isTerminal(current.status)) return current;
  if (!isTerminal(input.status.state)) {
    const updated = await input.store.saveModelRun({
      ...current,
      status: "running",
      updatedAt: input.status.updatedAt,
    });
    await saveLifecycleJob(input, {
      status: jobStatus(input.status.state),
      completedAt: null,
      error: null,
    });
    return updated;
  }
  if (input.status.state !== "succeeded") {
    if (
      input.status.state !== "failed"
      && input.status.state !== "cancelled"
    ) {
      throw new Error(
        `Unsupported terminal training state ${input.status.state}.`,
      );
    }
    const completedAt = input.status.updatedAt;
    const failure =
      input.status.state === "failed"
        ? input.failure
          ?? input.status.errorCode
          ?? `Training failed during ${input.status.phase}.`
        : null;
    const terminal = await input.store.saveModelRun(
      ModelRunSchema.parse({
        ...current,
        status: input.status.state,
        failure,
        completedAt,
        updatedAt: completedAt,
      }),
    );
    await saveLifecycleJob(input, {
      status: input.status.state,
      completedAt,
      error: failure,
    });
    return terminal;
  }
  if (!input.artifacts) {
    throw new Error(
      "Successful portable training requires collected artifacts.",
    );
  }
  const [source, plan] = await Promise.all([
    resolveTrainingJobSourceSnapshot(input.store, input.job, input.modelRunId),
    input.store.getTrainingPlan(input.job.planId),
  ]);
  if (!plan) {
    throw new Error(
      "Portable training lineage disappeared before artifact import.",
    );
  }
  const taskset = await input.store.getTaskset(source.taskset.id);
  if (
    !taskset
    || taskset.contentHash !== source.taskset.contentHash
  ) {
    throw new Error(
      "Portable training Taskset changed before artifact import.",
    );
  }
  const completedAt = input.status.updatedAt;
  const imported = await importPortableModelRunArtifacts({
    store: input.store,
    job: input.job,
    source,
    executionRef: input.executionRef,
    completedAt,
    portable: input.artifacts,
  });
  const {
    artifacts: persistedArtifacts,
    weights,
    provider,
  } = imported;
  const releaseGraph = portableReleaseGraph(input.job);
  if (!weights) {
    if (provider !== "sandbox") {
      throw new Error("Portable training completed without adapter weights.");
    }
    const evidence = input.artifacts.artifacts.filter((artifact) =>
      ["metrics", "trace", "receipt"].includes(artifact.kind),
    );
    const receiptArtifact = persistedArtifacts.find(
      (artifact) => artifact.metadata.portableKind === "receipt",
    );
    if (!receiptArtifact) {
      throw new Error(
        "Sandbox managed training completed without a persisted execution receipt.",
      );
    }
    const traceHash = input.artifacts.artifacts.find(
      (artifact) => artifact.kind === "trace",
    )?.sha256 ?? null;
    const versions = await input.store.listModelVersions({
      modelId: source.modelProjectId,
    });
    const baseVersion = versions.find((version) =>
      version.version === 0
      && version.kind === "base_reference"
      && version.baseModel.modelId === source.baseModel.modelId
      && version.baseModel.revision === source.baseModel.revision
    );
    if (!baseVersion) {
      throw new Error(
        "Sandbox no-signal completion lost its exact base Model Version.",
      );
    }
    const receiptCore = {
      schemaVersion: "openpond.modelRunReceipt.v1" as const,
      provider,
      providerRunId:
        input.executionRef.providerJobId ?? input.executionRef.runId,
      assignmentHash: input.artifacts.manifestHash,
      resultHash: input.artifacts.contentHash,
      transcriptHash: contentHash(evidence),
      traceHash,
      resolvedBundleHash: releaseGraph.resolvedBundleHash,
      artifactPath: artifactReceiptPath(
        input.storeDir,
        receiptArtifact.path,
      ),
      cleanup: {
        computeReleased: true,
        tunnelClosed: true,
      },
      telemetry: null,
    };
    const terminal = await input.store.saveModelRun(
      ModelRunSchema.parse({
        ...current,
        status: "succeeded",
        receipt: {
          ...receiptCore,
          contentHash: contentHash(receiptCore),
        },
        adapterArtifactLineageId: null,
        failure: null,
        completedAt,
        updatedAt: completedAt,
      }),
    );
    await saveLifecycleJob(input, {
      status: "succeeded",
      completedAt,
      error: null,
      metadata: {
        provider,
        providerJobId:
          input.executionRef.providerJobId ?? input.executionRef.runId,
        phase: "complete_no_learning_signal",
        portableArtifactCount: persistedArtifacts.length,
        noLearningSignal: true,
        modelVersionId: current.modelVersionId,
        unchangedBaseModelVersionId: baseVersion.id,
      },
    });
    return terminal;
  }
  const existingLineages = (
    await input.store.listModelArtifactLineage(taskset.id)
  ).filter((lineage) => lineage.jobId === input.job.id);
  const lineage =
    existingLineages[0]
    ?? await input.store.saveModelArtifactLineage(
      ModelArtifactLineageSchema.parse({
        schemaVersion: "openpond.modelArtifactLineage.v1",
        id: `model_lineage_${contentHash([
          source.modelProjectId,
          weights.sha256,
          plan.contentHash,
        ]).slice(0, 24)}`,
        modelId: source.modelProjectId,
        artifactId: weights.id,
        jobId: input.job.id,
        tasksetId: taskset.id,
        tasksetHash: taskset.contentHash,
        graderHash: contentHash(taskset.graders),
        planHash: plan.contentHash,
        bundleHash: input.job.bundleHash,
        recipeHash: contentHash(plan.recipe),
        workerVersion: engineMetadata(
          input.job,
          "workerVersion",
          "portable-worker",
        ),
        trainerVersion: `${
          engineMetadata(input.job, "adapterId", input.executionRef.adapterId)
        }@${
          engineMetadata(input.job, "upstreamRevision", "unknown")
        }`,
        importedAt: completedAt,
        frozenEvaluationArtifactId:
          persistedArtifacts.find(
            (artifact) => artifact.kind === "evaluation",
          )?.id ?? null,
        promotable: false,
        pinned: false,
        status: "imported",
        rejectedAt: null,
        rejectionReason: null,
        managedServing: null,
      }),
    );
  const reservation = modelVersionReservation(input.job, current);
  const versionCore = {
    schemaVersion: "openpond.modelVersion.v1" as const,
    id: reservation.id,
    modelId: source.modelProjectId,
    profileId: source.profileId,
    version: reservation.version,
    kind: "lora_adapter" as const,
    status: "available" as const,
    baseModel: source.baseModel,
    taskset: source.taskset,
    comparisonSeriesEntry: current.comparisonSeriesEntry ?? null,
    releaseGraph,
    artifactLineageId: lineage.id,
    adapterStatus: "trained" as const,
    createdAt: completedAt,
  };
  await input.store.saveModelVersion(
    ModelVersionSchema.parse({
      ...versionCore,
      contentHash: contentHash(versionCore),
    }),
  );
  const evidence = input.artifacts.artifacts.filter((artifact) =>
    ["metrics", "trace", "receipt"].includes(artifact.kind),
  );
  const traceHash =
    input.artifacts.artifacts.find(
      (artifact) => artifact.kind === "trace",
    )?.sha256 ?? null;
  const receiptCore = {
    schemaVersion: "openpond.modelRunReceipt.v1" as const,
    provider,
    providerRunId:
      input.executionRef.providerJobId ?? input.executionRef.runId,
    assignmentHash: input.artifacts.manifestHash,
    resultHash: input.artifacts.contentHash,
    transcriptHash: contentHash(evidence),
    traceHash,
    resolvedBundleHash: releaseGraph.resolvedBundleHash,
    artifactPath: artifactReceiptPath(
      input.storeDir,
      weights.path,
    ),
    cleanup: {
      computeReleased: true,
      tunnelClosed: true,
    },
    telemetry: null,
  };
  const terminal = await input.store.saveModelRun(
    ModelRunSchema.parse({
      ...current,
      status: "succeeded",
      receipt: {
        ...receiptCore,
        contentHash: contentHash(receiptCore),
      },
      adapterArtifactLineageId: lineage.id,
      failure: null,
      completedAt,
      updatedAt: completedAt,
    }),
  );
  await saveLifecycleJob(input, {
    status: "succeeded",
    completedAt,
    error: null,
    metadata: {
      provider,
      providerJobId:
        input.executionRef.providerJobId ?? input.executionRef.runId,
      phase: "complete",
      portableArtifactCount: persistedArtifacts.length,
      importedModelLineageId: lineage.id,
      adapterArtifactId: weights.id,
      adapterArtifactLineageId: lineage.id,
      modelVersionId: reservation.id,
    },
  });
  return terminal;
}

export function portableStatusFromModelRun(
  modelRun: ModelRun,
): TrainingExecutionStatus {
  return {
    runId: modelRun.id,
    state:
      modelRun.status === "prepared"
        ? "queued"
        : modelRun.status,
    phase: modelRun.status,
    progress: isTerminal(modelRun.status) ? 1 : null,
    updatedAt: modelRun.updatedAt,
    errorCode:
      modelRun.status === "failed"
        ? "portable_model_run_failed"
        : null,
  };
}

export function portableReleaseGraphMetadata(
  value: PortableReleaseGraph,
): PortableReleaseGraph {
  return value;
}

export function portableModelVersionMetadata(
  value: PortableModelVersionReservation,
): PortableModelVersionReservation {
  return value;
}

function modelVersionId(modelId: string, version: number): string {
  return `model_version_${contentHash({ modelId, version }).slice(0, 24)}`;
}

async function requiredModelRun(
  store: SqliteStore,
  id: string,
): Promise<ModelRun> {
  const modelRun = await store.getModelRun(id);
  if (!modelRun) {
    throw new Error(`Canonical Model Run ${id} was not found.`);
  }
  return modelRun;
}

async function resolveTrainingJobSourceSnapshot(
  store: SqliteStore,
  job: TrainingJob,
  modelRunId: string,
): Promise<TrainingJobSourceSnapshot> {
  const current = TrainingJobSourceSnapshotSchema.safeParse(
    job.metadata.sourceSnapshot,
  );
  if (current.success) return current.data;

  void store;
  void modelRunId;
  throw new Error("Training Job source snapshot is missing or invalid.");
}

function engineMetadata(
  job: TrainingJob,
  key: string,
  fallback: string,
): string {
  const bindings = objectValue(job.metadata.portableAdapterBindings);
  const engine = objectValue(bindings.engine);
  return typeof engine[key] === "string" && engine[key].trim()
    ? engine[key]
    : fallback;
}

function modelVersionReservation(
  job: TrainingJob,
  modelRun: ModelRun,
): PortableModelVersionReservation {
  const value = objectValue(job.metadata.portableModelVersion);
  if (
    value.id !== modelRun.modelVersionId
    || typeof value.id !== "string"
    || !Number.isInteger(value.version)
    || Number(value.version) < 1
  ) {
    throw new Error(
      "Portable Model Version reservation is missing or changed.",
    );
  }
  return { id: value.id, version: Number(value.version) };
}

function portableReleaseGraph(job: TrainingJob): PortableReleaseGraph {
  const value = objectValue(job.metadata.portableReleaseGraph);
  const parsed = ModelVersionSchema.shape.releaseGraph.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "Portable Model Run release graph is missing or invalid.",
    );
  }
  return parsed.data;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function saveLifecycleJob(
  input: {
    store: SqliteStore;
    job: TrainingJob;
    status: TrainingExecutionStatus;
  },
  patch: {
    status: TrainingJob["status"];
    completedAt: string | null;
    error: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<TrainingJob> {
  return input.store.saveTrainingJob(
    TrainingJobSchema.parse({
      ...input.job,
      status: patch.status,
      startedAt:
        input.job.startedAt
        ?? (
          patch.status === "queued"
            ? null
            : input.status.updatedAt
        ),
      completedAt: patch.completedAt,
      error: patch.error,
      updatedAt: input.status.updatedAt,
      metadata: {
        ...input.job.metadata,
        phase: input.status.phase,
        progress: input.status.progress,
        ...(input.status.rolloutProgress
          ? { rolloutProgress: input.status.rolloutProgress }
          : {}),
        ...patch.metadata,
      },
    }),
  );
}

function jobStatus(
  state: TrainingExecutionStatus["state"],
): TrainingJob["status"] {
  if (state === "preparing") return "starting";
  return state;
}

function artifactReceiptPath(storeDir: string, artifactPath: string): string {
  const relative = path.relative(storeDir, artifactPath);
  if (
    relative
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  ) {
    return relative.split(path.sep).join("/");
  }
  return artifactPath;
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.trim().slice(0, 5_000) || "Portable training failed.";
}

function isTerminal(status: string): boolean {
  return ["succeeded", "failed", "cancelled"].includes(status);
}
