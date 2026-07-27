import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  HarnessRunManifestSchema,
  ResolvedTrainingPlanSchema,
  TrainingExecutionRefSchema,
  TrainingJobSchema,
  type TrainingApproval,
  type TrainingCatalog,
  type TrainingPreparationPlan,
  type TrainingPreparedStart,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import {
  TrainingAdapterRegistry,
  buildTasksetTrainingBundle,
  materializeResolvedTrainingBundle,
} from "@openpond/training-sdk";

import type { SqliteStore } from "../store/store.js";
import { readRecoveredPortableArtifacts } from "./portable-model-run-artifacts.js";
import {
  failPreparedPortableModelRun,
  markPortableModelRunRunning,
  portableModelVersionMetadata,
  portableReleaseGraphMetadata,
  portableStatusFromModelRun,
  preparePortableModelRunLifecycle,
  reconcilePortableModelRunLifecycle,
} from "./portable-model-run-lifecycle.js";
import { resolvePortableBindings } from "./portable-training-catalog.js";

export function createPortableModelRunService(deps: {
  store: SqliteStore;
  storeDir: string;
  adapters: TrainingAdapterRegistry;
  catalog(): Promise<TrainingCatalog>;
  prepare(input: {
    modelRunId: string;
    maximumSpendUsd?: number | null;
    retentionDays?: number | null;
  }): Promise<TrainingPreparationPlan>;
  prepareStart(input: {
    modelId: string;
    tasksetId: string;
    destinationId: NonNullable<
      Awaited<ReturnType<SqliteStore["getModelRunDraft"]>>
    >["destinationId"];
    recipe: unknown;
    retentionDays?: number | null;
  }): Promise<TrainingPreparedStart>;
  approve(input: {
    planId: string;
    bundleId: string;
    maximumCostUsd?: number | null;
  }): Promise<TrainingApproval>;
  prepareModel?: (input: {
    modelId: string;
    revision: string | null;
  }) => Promise<unknown>;
}) {
  async function start(input: {
    modelRunId: string;
    maximumSpendUsd: number | null;
    retentionDays?: number | null;
    manifest?: unknown;
  }) {
    const modelRun = await deps.store.getModelRunDraft(input.modelRunId);
    if (!modelRun || modelRun.status !== "ready_to_run") {
      throw new Error("A ready saved Model Run is required.");
    }
    if (
      !modelRun.tasksetRef ||
      !modelRun.baseModel ||
      !modelRun.recipe ||
      !modelRun.destinationId
    ) {
      throw new Error("The saved Model Run is incomplete.");
    }
    const preparation = await deps.prepare({
      modelRunId: modelRun.id,
      maximumSpendUsd: input.maximumSpendUsd,
      retentionDays: input.retentionDays,
    });
    if (
      preparation.state === "unsupported" ||
      preparation.state === "compute_setup_required"
    ) {
      throw new Error(
        preparation.reason ?? "Model Run preparation is incomplete."
      );
    }
    if (preparation.state === "model_download_required") {
      if (!deps.prepareModel) {
        throw new Error(
          "This Model requires a verified downloader before training can start."
        );
      }
      await deps.prepareModel({
        modelId: modelRun.baseModel.modelId,
        revision: modelRun.baseModel.revision,
      });
    }
    const prepared = await deps.prepareStart({
      modelId: modelRun.modelId,
      tasksetId: modelRun.tasksetRef.id,
      destinationId: modelRun.destinationId,
      recipe: modelRun.recipe,
      retentionDays: input.retentionDays,
    });
    const approval = await deps.approve({
      planId: prepared.plan.id,
      bundleId: prepared.bundle.id,
      maximumCostUsd: input.maximumSpendUsd,
    });
    const bindings = resolvePortableBindings({
      modelRun,
      catalog: await deps.catalog(),
    });
    if (!bindings.runtime || !bindings.compute || !bindings.engine) {
      throw new Error(
        "The saved Model Run has no complete portable adapter binding."
      );
    }
    const taskset = await deps.store.getTaskset(modelRun.tasksetRef.id);
    if (!taskset || taskset.contentHash !== modelRun.tasksetRef.contentHash) {
      throw new Error("The saved Model Run Taskset release is stale.");
    }
    const graph = buildTasksetTrainingBundle({
      taskset,
      modelRun,
      runtime: bindings.runtime,
      compute: bindings.compute,
      engine: bindings.engine,
      approval: {
        approvalHash: contentHash(approval),
        approvedAt: approval.approvedAt,
        maximumSpendUsd: approval.maximumCostUsd,
      },
      openpondRelease: "0.0.38",
      workerProtocol: "openpond.connectedWorker.v1",
    });
    const resolvedPlanBase = {
      schemaVersion: "openpond.resolvedTrainingPlan.v1" as const,
      manifest: graph.manifest,
      recipe: modelRun.recipe,
      runtime: bindings.runtime,
      compute: bindings.compute,
      engine: bindings.engine,
      execution: {
        trainingPlanId: prepared.plan.id,
        approvalId: approval.id,
      },
      maximumSpendUsd: approval.maximumCostUsd,
      approvalHash: contentHash(approval),
    };
    const resolvedPlan = ResolvedTrainingPlanSchema.parse({
      ...resolvedPlanBase,
      contentHash: contentHash(resolvedPlanBase),
    });
    assertSubmittedManifest(input.manifest, graph.manifest);
    const publishedGraph = await publishRunGraph({
      storeDir: deps.storeDir,
      graph,
    });
    const engineAdapter = deps.adapters.engine(bindings.engine.adapterId);
    const validation = await engineAdapter.validate(resolvedPlan);
    if (!validation.valid) {
      throw new Error(
        `Portable engine validation failed: ${validation.issues
          .map((issue) => issue.message)
          .join("; ")}`
      );
    }
    const grader = taskset.graders[0];
    const profileRelease = graph.profileRelease;
    if (!grader || !profileRelease) {
      throw new Error(
        "Portable training requires released Profile and grader identity.",
      );
    }
    const portableReleaseGraph = portableReleaseGraphMetadata({
      resolvedBundleHash: graph.resolvedBundleManifest.contentHash,
      profileRelease,
      harnessRelease: graph.manifest.harnessRelease,
      agentRelease:
        taskset.environment.actionBindings?.[0]?.agentRelease ?? null,
      grader: {
        id: grader.id,
        contentHash: contentHash(grader),
      },
    });
    const lifecycle = await preparePortableModelRunLifecycle({
      store: deps.store,
      draft: modelRun,
      taskset,
      releaseGraph: portableReleaseGraph,
      maximumSpendUsd: approval.maximumCostUsd,
      startedAt: approval.approvedAt,
    });
    let executionRef;
    try {
      executionRef = TrainingExecutionRefSchema.parse(
        await engineAdapter.launch(resolvedPlan)
      );
    } catch (error) {
      await failPreparedPortableModelRun({
        store: deps.store,
        modelRunId: modelRun.id,
        error,
      });
      throw error;
    }
    const launched =
      (await deps.store.getTrainingJob(executionRef.runId)) ??
      TrainingJobSchema.parse({
        schemaVersion: "openpond.trainingJob.v1",
        id: executionRef.runId,
        planId: prepared.plan.id,
        bundleHash: prepared.bundle.contentHash,
        approvalId: approval.id,
        destinationId: modelRun.destinationId,
        status: "queued",
        nonProduction:
          modelRun.destinationId === "local_cpu_fixture",
        workerPid: null,
        startedAt: null,
        completedAt: null,
        error: null,
        createdAt: executionRef.createdAt,
        updatedAt: executionRef.createdAt,
        metadata: {},
      });
    const job = await deps.store.saveTrainingJob({
      ...launched,
      metadata: {
        ...launched.metadata,
        modelRunId: modelRun.id,
        harnessRunManifestId: graph.manifest.id,
        harnessRunManifestHash: graph.manifest.contentHash,
        harnessReleaseHash: graph.harnessRelease.contentHash,
        datasetReleaseHash: graph.datasetRelease.contentHash,
        evidenceSetReleaseHash: graph.evidenceSetRelease?.contentHash ?? null,
        manifestPath: publishedGraph.manifestPath,
        resolvedBundleDirectory: publishedGraph.resolvedBundleDirectory,
        portableAdapterBindings: bindings,
        portableExecutionRef: executionRef,
        portableValidationReceipt: validation,
        portableModelVersion: portableModelVersionMetadata(
          lifecycle.targetVersion,
        ),
        portableReleaseGraph,
      },
    });
    await markPortableModelRunRunning({
      store: deps.store,
      modelRunId: modelRun.id,
      startedAt: executionRef.createdAt,
    });
    await deps.store.saveModelRunDraft({
      ...modelRun,
      status: "launched",
      updatedAt: new Date().toISOString(),
    });
    return {
      preparation,
      manifest: graph.manifest,
      harnessRelease: {
        id: graph.harnessRelease.id,
        contentHash: graph.harnessRelease.contentHash,
      },
      evidenceSetRelease: graph.evidenceSetRelease
        ? {
            id: graph.evidenceSetRelease.id,
            contentHash: graph.evidenceSetRelease.contentHash,
          }
        : null,
      plan: prepared.plan,
      bundle: prepared.bundle,
      approval,
      job,
    };
  }

  async function execution(modelRunId: string) {
    const job = (await deps.store.listTrainingJobs()).find(
      (candidate) =>
        candidate.id === modelRunId ||
        candidate.metadata.modelRunId === modelRunId
    );
    if (!job) {
      throw new Error("No training execution exists for this Model Run.");
    }
    return job;
  }

  function executionRef(job: Awaited<ReturnType<typeof execution>>) {
    return TrainingExecutionRefSchema.safeParse(
      job.metadata.portableExecutionRef
    );
  }

  async function status(modelRunId: string) {
    const canonical = await deps.store.getModelRun(modelRunId);
    if (
      canonical
      && ["succeeded", "failed", "cancelled"].includes(canonical.status)
    ) {
      return portableStatusFromModelRun(canonical);
    }
    const job = await execution(modelRunId);
    const parsed = executionRef(job);
    if (parsed.success && deps.adapters.hasEngine(parsed.data.adapterId)) {
      const adapter = deps.adapters.engine(parsed.data.adapterId);
      let executionStatus;
      try {
        executionStatus = await adapter.status(parsed.data);
      } catch (error) {
        const recovered = await readRecoveredPortableArtifacts({
          storeDir: deps.storeDir,
          runId: parsed.data.runId,
        });
        if (!recovered) throw error;
        const recoveredAt = new Date().toISOString();
        const modelRun = await reconcilePortableModelRunLifecycle({
          store: deps.store,
          storeDir: deps.storeDir,
          modelRunId,
          job,
          executionRef: parsed.data,
          status: {
            runId: parsed.data.runId,
            state: "succeeded",
            phase: "artifact_recovery",
            progress: 1,
            updatedAt: recoveredAt,
            errorCode: null,
          },
          artifacts: recovered,
        });
        return portableStatusFromModelRun(modelRun);
      }
      if (
        !["succeeded", "failed", "cancelled"].includes(
          executionStatus.state,
        )
      ) {
        await reconcilePortableModelRunLifecycle({
          store: deps.store,
          storeDir: deps.storeDir,
          modelRunId,
          job,
          executionRef: parsed.data,
          status: executionStatus,
        });
        return executionStatus;
      }
      let artifacts = null;
      try {
        artifacts = await adapter.collect(parsed.data);
      } catch (error) {
        const failedStatus = {
          ...executionStatus,
          state: "failed" as const,
          phase:
            executionStatus.state === "succeeded"
              ? "artifact_collection_failed"
              : executionStatus.phase,
          errorCode:
            executionStatus.errorCode ?? "artifact_collection_failed",
        };
        const modelRun = await reconcilePortableModelRunLifecycle({
          store: deps.store,
          storeDir: deps.storeDir,
          modelRunId,
          job,
          executionRef: parsed.data,
          status: failedStatus,
          failure: error instanceof Error ? error.message : String(error),
        });
        return portableStatusFromModelRun(modelRun);
      }
      const modelRun = await reconcilePortableModelRunLifecycle({
        store: deps.store,
        storeDir: deps.storeDir,
        modelRunId,
        job,
        executionRef: parsed.data,
        status: executionStatus,
        artifacts,
      });
      return portableStatusFromModelRun(modelRun);
    }
    throw new Error("Training execution has no registered portable engine.");
  }

  async function events(modelRunId: string) {
    return deps.store.listTrainingJobEvents((await execution(modelRunId)).id);
  }

  async function logs(modelRunId: string) {
    const job = await execution(modelRunId);
    const parsed = executionRef(job);
    if (parsed.success && deps.adapters.hasEngine(parsed.data.adapterId)) {
      return deps.adapters.engine(parsed.data.adapterId).logs(parsed.data);
    }
    throw new Error("Training execution has no registered portable engine.");
  }

  async function artifacts(modelRunId: string) {
    const job = await execution(modelRunId);
    const canonical = await deps.store.getModelRun(modelRunId);
    if (
      canonical
      && ["succeeded", "failed", "cancelled"].includes(canonical.status)
    ) {
      return deps.store.listTrainingArtifacts(job.id);
    }
    const parsed = executionRef(job);
    if (parsed.success && deps.adapters.hasEngine(parsed.data.adapterId)) {
      await status(modelRunId);
      const reconciled = await deps.store.getModelRun(modelRunId);
      if (
        reconciled
        && ["succeeded", "failed", "cancelled"].includes(reconciled.status)
      ) {
        return deps.store.listTrainingArtifacts(job.id);
      }
      throw new Error(
        "Portable training artifacts are available only after terminal reconciliation.",
      );
    }
    return deps.store.listTrainingArtifacts(job.id);
  }

  async function cancel(modelRunId: string) {
    const job = await execution(modelRunId);
    const parsed = executionRef(job);
    if (parsed.success && deps.adapters.hasEngine(parsed.data.adapterId)) {
      await deps.adapters.engine(parsed.data.adapterId).cancel(parsed.data);
      const timestamp = new Date().toISOString();
      const modelRun = await reconcilePortableModelRunLifecycle({
        store: deps.store,
        storeDir: deps.storeDir,
        modelRunId,
        job,
        executionRef: parsed.data,
        status: {
          runId: parsed.data.runId,
          state: "cancelled",
          phase: "cancelled",
          progress: 1,
          updatedAt: timestamp,
          errorCode: null,
        },
      });
      return portableStatusFromModelRun(modelRun);
    }
    throw new Error("Training execution has no registered portable engine.");
  }

  return { start, status, events, logs, artifacts, cancel };
}

function assertSubmittedManifest(
  input: unknown,
  expected: ReturnType<typeof HarnessRunManifestSchema.parse>
): void {
  if (input === undefined) return;
  const submitted = HarnessRunManifestSchema.parse(input);
  const { contentHash: submittedHash, ...submittedContent } = submitted;
  if (
    contentHash(submittedContent) !== submittedHash ||
    submittedHash !== expected.contentHash
  ) {
    throw new Error(
      "Submitted Harness Run Manifest does not exactly match the revalidated server plan."
    );
  }
}

export async function publishRunGraph(input: {
  storeDir: string;
  graph: ReturnType<typeof buildTasksetTrainingBundle>;
}): Promise<{
  manifestPath: string;
  resolvedBundleDirectory: string;
}> {
  const manifestDirectory = path.join(
    input.storeDir,
    "training",
    "portable-releases",
    "manifests"
  );
  await mkdir(manifestDirectory, { recursive: true });
  const manifestPath = path.join(
    manifestDirectory,
    `${input.graph.manifest.contentHash}.json`
  );
  const serialized = `${JSON.stringify(input.graph.manifest, null, 2)}\n`;
  await writeFile(manifestPath, serialized, {
    flag: "wx",
    mode: 0o600,
  }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    if ((await readFile(manifestPath, "utf8")) !== serialized) {
      throw new Error("Published Harness Run Manifest changed.");
    }
  });
  const resolvedBundle = await materializeResolvedTrainingBundle({
    manifest: input.graph.resolvedBundleManifest,
    assets: input.graph.assets,
    cacheRoot: path.join(
      input.storeDir,
      "training",
      "portable-releases",
      "resolved-bundles"
    ),
  });
  if (
    resolvedBundle.manifest.contentHash !==
      input.graph.manifest.resolvedBundleHash
  ) {
    throw new Error(
      "Resolved Training Bundle does not match the Harness Run Manifest."
    );
  }
  return {
    manifestPath,
    resolvedBundleDirectory: resolvedBundle.directory,
  };
}
