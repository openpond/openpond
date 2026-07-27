import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  ModelProjectSchema,
  ModelRunSchema,
  ModelVersionSchema,
  PrimeRolloutSmokeReportSchema,
  type ModelRun,
  type PrimeRolloutSmokeReport,
  type Taskset,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";

export const PRIME_SMOKE_MODEL_ID = "Qwen/Qwen3-0.6B";
export const PRIME_SMOKE_MODEL_REVISION =
  "c1899de289a04d12100db370d81485cdf75e47ca";
export const PRIME_SMOKE_CHAT_TEMPLATE_HASH =
  "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8";

export type PrimeRolloutModelContext = {
  modelId: string;
  modelVersionId: string;
  runId: string;
};

export async function preparePrimeRolloutModel(input: {
  store: SqliteStore;
  taskset: Taskset;
  runId: string;
  maximumSpendUsd: number;
  startedAt: string;
  resolvedBundleHash: string;
  harnessRelease: { id: string; contentHash: string };
  agentRelease: { id: string; contentHash: string } | null;
}): Promise<PrimeRolloutModelContext> {
  const identity = primeRolloutModelIdentity(input.taskset);
  const grader = input.taskset.graders[0]!;
  const existingProject = await input.store.getModelProject(identity.modelId);
  await input.store.saveModelProject(
    ModelProjectSchema.parse({
      schemaVersion: "openpond.modelProject.v1",
      id: identity.modelId,
      profileId: input.taskset.profileId,
      name: `${input.taskset.name} · Qwen3 0.6B`,
      objective: input.taskset.objective,
      defaultBaseModel: primeSmokeBaseModelPreference(),
      defaultDestinationId: "prime_hosted",
      createdAt: existingProject?.createdAt ?? input.startedAt,
      updatedAt: input.startedAt,
    }),
  );
  const existingVersion = await input.store.getModelVersion(
    identity.modelVersionId,
  );
  if (!existingVersion) {
    const versionContent = {
      schemaVersion: "openpond.modelVersion.v1" as const,
      id: identity.modelVersionId,
      modelId: identity.modelId,
      profileId: input.taskset.profileId,
      version: 0,
      kind: "base_reference" as const,
      status: "available" as const,
      baseModel: primeSmokeBaseModelPreference(),
      taskset: {
        id: input.taskset.id,
        revision: input.taskset.revision,
        contentHash: input.taskset.contentHash,
      },
      releaseGraph: {
        resolvedBundleHash: input.resolvedBundleHash,
        profileRelease: input.taskset.profileRelease!,
        harnessRelease: input.harnessRelease,
        agentRelease: input.agentRelease,
        grader: {
          id: grader.id,
          contentHash: contentHash(grader),
        },
      },
      artifactLineageId: null,
      adapterStatus: "not_trained" as const,
      createdAt: input.startedAt,
    };
    await input.store.saveModelVersion(
      ModelVersionSchema.parse({
        ...versionContent,
        contentHash: contentHash(versionContent),
      }),
    );
  } else if (
    existingVersion.modelId !== identity.modelId
    || existingVersion.profileId !== input.taskset.profileId
    || existingVersion.taskset.id !== input.taskset.id
    || existingVersion.baseModel.modelId !== PRIME_SMOKE_MODEL_ID
    || existingVersion.baseModel.revision !== PRIME_SMOKE_MODEL_REVISION
  ) {
    throw new Error("Existing base Model Version does not match the smoke run.");
  }
  await input.store.saveModelRun(
    ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1",
      id: input.runId,
      modelId: identity.modelId,
      modelVersionId: identity.modelVersionId,
      profileId: input.taskset.profileId,
      kind: "rollout_smoke",
      status: "prepared",
      method: "grpo",
      destinationId: "prime_hosted",
      taskset: {
        id: input.taskset.id,
        revision: input.taskset.revision,
        contentHash: input.taskset.contentHash,
      },
      quote: {
        maximumSpendUsd: input.maximumSpendUsd,
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
  return {
    ...identity,
    runId: input.runId,
  };
}

export async function persistPrimeRolloutSmokeReport(input: {
  store: SqliteStore;
  storeDir: string;
  taskset: Taskset;
  report: PrimeRolloutSmokeReport;
  reportPath: string;
}): Promise<ModelRun> {
  const assignmentAgent = input.report.assignment.agentRelease;
  const context = await preparePrimeRolloutModel({
    store: input.store,
    taskset: input.taskset,
    runId: input.report.runId,
    maximumSpendUsd: input.report.maximumSpendUsd,
    startedAt: input.report.startedAt,
    resolvedBundleHash: input.report.upload.resolvedBundleHash,
    harnessRelease: input.report.assignment.harnessRelease,
    agentRelease: assignmentAgent,
  });
  const receiptContent = {
    schemaVersion: "openpond.modelRunReceipt.v1" as const,
    provider: input.report.provider,
    providerRunId: input.report.runId,
    assignmentHash: input.report.assignment.assignmentHash,
    resultHash: input.report.result.resultHash,
    transcriptHash: input.report.result.transcriptHash,
    traceHash: input.report.result.grade?.traceHash ?? null,
    resolvedBundleHash: input.report.upload.resolvedBundleHash,
    artifactPath: path
      .relative(input.storeDir, input.reportPath)
      .split(path.sep)
      .join("/"),
    cleanup: {
      computeReleased: input.report.cleanup.podTerminated,
      tunnelClosed: input.report.cleanup.tunnelClosed,
    },
  };
  return input.store.saveModelRun(
    ModelRunSchema.parse({
      schemaVersion: "openpond.modelRun.v1",
      id: input.report.runId,
      modelId: context.modelId,
      modelVersionId: context.modelVersionId,
      profileId: input.taskset.profileId,
      kind: "rollout_smoke",
      status: input.report.result.status,
      method: "grpo",
      destinationId: "prime_hosted",
      taskset: {
        id: input.taskset.id,
        revision: input.taskset.revision,
        contentHash: input.taskset.contentHash,
      },
      quote: {
        maximumSpendUsd: input.report.maximumSpendUsd,
        hourlyCostUsd: input.report.hourlyCostUsd,
      },
      reward: input.report.result.grade
        ? {
            raw: input.report.result.grade.reward,
            components: input.report.result.grade.components,
          }
        : null,
      receipt: {
        ...receiptContent,
        contentHash: contentHash(receiptContent),
      },
      adapterArtifactLineageId: null,
      failure: input.report.result.failure,
      startedAt: input.report.startedAt,
      completedAt: input.report.completedAt,
      updatedAt: input.report.completedAt,
    }),
  );
}

export async function failPrimeRolloutModelRun(input: {
  store: SqliteStore;
  runId: string;
  failedAt: string;
  error: string;
}): Promise<ModelRun | null> {
  const existing = await input.store.getModelRun(input.runId);
  if (!existing) return null;
  return input.store.saveModelRun(
    ModelRunSchema.parse({
      ...existing,
      status: "failed",
      failure: input.error,
      completedAt: input.failedAt,
      updatedAt: input.failedAt,
    }),
  );
}

export async function reconcilePrimeRolloutSmokeModels(input: {
  store: SqliteStore;
  storeDir: string;
}): Promise<{ imported: string[]; skipped: string[]; errors: string[] }> {
  const root = path.join(
    input.storeDir,
    "training",
    "prime-rollout-smoke",
  );
  const directories = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const reportPath = path.join(root, directory.name, "smoke-report.json");
    try {
      const report = PrimeRolloutSmokeReportSchema.parse(
        JSON.parse(await readFile(reportPath, "utf8")),
      );
      const existing = await input.store.getModelRun(report.runId);
      if (existing?.status === "succeeded") {
        skipped.push(report.runId);
        continue;
      }
      const taskset = await input.store.getTasksetRevision(
        report.assignment.taskset.id,
        report.assignment.taskset.revision,
        report.assignment.taskset.contentHash,
      );
      if (!taskset) {
        throw new Error(
          `Taskset ${report.assignment.taskset.id}@${report.assignment.taskset.revision} is unavailable.`,
        );
      }
      await persistPrimeRolloutSmokeReport({
        store: input.store,
        storeDir: input.storeDir,
        taskset,
        report,
        reportPath,
      });
      imported.push(report.runId);
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      errors.push(
        `${directory.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { imported, skipped, errors };
}

export function primeRolloutModelIdentity(taskset: Taskset): {
  modelId: string;
  modelVersionId: string;
} {
  const modelId = `model_${contentHash({
    profileId: taskset.profileId,
    tasksetId: taskset.id,
    baseModelId: PRIME_SMOKE_MODEL_ID,
  }).slice(0, 24)}`;
  return {
    modelId,
    modelVersionId: `model_version_${contentHash({
      modelId,
      version: 0,
    }).slice(0, 24)}`,
  };
}

function primeSmokeBaseModelPreference() {
  return {
    schemaVersion: "openpond.baseModelPreference.v1" as const,
    modelId: PRIME_SMOKE_MODEL_ID,
    revision: PRIME_SMOKE_MODEL_REVISION,
    tokenizerRevision: PRIME_SMOKE_MODEL_REVISION,
    chatTemplateHash: PRIME_SMOKE_CHAT_TEMPLATE_HASH,
    modelAssetId: null,
    source: "managed" as const,
  };
}
