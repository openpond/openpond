import { promises as fs } from "node:fs";
import path from "node:path";

import {
  ModelVersionSchema,
  type ChatModelRef,
  type ModelProject,
  type ModelRun,
  type OpenPondProfileState,
} from "@openpond/contracts";
import type {
  BenchmarkComparison,
  BenchmarkRunSummary,
} from "@openpond/evals";
import { contentHash } from "@openpond/harness";
import {
  commitProfileBenchmarkRef,
  type ProfileBenchmarkGitReceipt,
} from "@openpond/cloud/profile/profile-git";

import { localHarnessWorkspacePaths } from "../harness/local-harness-workspace-service.js";
import type { SqliteStore } from "../store/store.js";
import type { HostedTokenPricing } from "./hosted-token-pricing.js";
import type {
  BenchmarkEvidenceSnapshotManifest,
  HarnessRefinerExecutionPlanItem,
  SequentialAdaptationSummary,
} from "./harness-refiner-benchmark-protocol.js";
import type {
  BenchmarkAttemptEvidence,
  EvaluationAttempt,
} from "./harness-refiner-benchmark-service-support.js";
import type { BenchmarkLineage } from "./harness-refiner-benchmark-lineage.js";

export type ManagedResultManifest = {
  schemaVersion: "openpond.harnessRefinerBenchmarkResult.v2";
  id: string;
  modelRunId: string;
  benchmarkId: "harness-refiner";
  model: ChatModelRef;
  upstreamModel: {
    providerId: string;
    modelId: string;
    revision: string;
    pricing?: HostedTokenPricing;
  };
  reasoningEffort: string | null;
  tasksetRelease: { id: string; contentHash: string };
  baseline: BenchmarkRunSummary;
  adaptation: BenchmarkRunSummary;
  refiner: { id: string; contentHash: string; outcomeCount: number };
  candidateAdaptation: SequentialAdaptationSummary;
  candidate: BenchmarkRunSummary;
  comparison: BenchmarkComparison;
  executionPlan: HarnessRefinerExecutionPlanItem[];
  evidenceSnapshot: BenchmarkEvidenceSnapshotManifest;
  lineage: BenchmarkLineage;
  publicationPolicy: {
    primaryReward: "deterministic_output_contract";
    supplementaryJudge: "not_executed_uncalibrated";
    diagnosticPasses: 1;
    confirmationPasses: 1;
    uncertainty: "paired_per_case_descriptive";
  };
  harness: {
    baseline: { id: string; contentHash: string };
    candidate: { id: string; contentHash: string };
  };
  createdAt: string;
  contentHash: string;
};

export function createResultManifest(
  input: Omit<
    ManagedResultManifest,
    | "schemaVersion"
    | "id"
    | "benchmarkId"
    | "tasksetRelease"
    | "harness"
    | "publicationPolicy"
    | "contentHash"
  >,
): ManagedResultManifest {
  const core = {
    schemaVersion: "openpond.harnessRefinerBenchmarkResult.v2" as const,
    id: `benchmark-result-${input.modelRunId}`,
    modelRunId: input.modelRunId,
    benchmarkId: "harness-refiner" as const,
    model: input.model,
    upstreamModel: input.upstreamModel,
    reasoningEffort: input.reasoningEffort,
    tasksetRelease: input.baseline.tasksetRelease,
    baseline: input.baseline,
    adaptation: input.adaptation,
    refiner: input.refiner,
    candidateAdaptation: input.candidateAdaptation,
    candidate: input.candidate,
    comparison: input.comparison,
    executionPlan: input.executionPlan,
    evidenceSnapshot: input.evidenceSnapshot,
    lineage: input.lineage,
    publicationPolicy: {
      primaryReward: "deterministic_output_contract" as const,
      supplementaryJudge: "not_executed_uncalibrated" as const,
      diagnosticPasses: 1 as const,
      confirmationPasses: 1 as const,
      uncertainty: "paired_per_case_descriptive" as const,
    },
    harness: {
      baseline: input.baseline.harnessRelease,
      candidate: input.candidate.harnessRelease,
    },
    createdAt: input.createdAt,
  };
  return { ...core, contentHash: contentHash(core) };
}

export async function writeManagedResult(
  storeDir: string,
  modelRunId: string,
  manifest: ManagedResultManifest,
) {
  const root = path.join(storeDir, "training", "model-runs", modelRunId, "benchmark");
  await fs.mkdir(root, { recursive: true });
  const filePath = path.join(root, `${manifest.contentHash}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path.relative(storeDir, filePath).replaceAll(path.sep, "/");
}

export async function loadLatestManagedResult(
  storeDir: string,
  modelRunId: string,
): Promise<ManagedResultManifest | null> {
  const root = path.join(storeDir, "training", "model-runs", modelRunId, "benchmark");
  let entries: string[];
  try {
    entries = (await fs.readdir(root)).filter((entry) => entry.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifests = await Promise.all(entries.map(async (entry) => {
    const value = JSON.parse(
      await fs.readFile(path.join(root, entry), "utf8"),
    ) as ManagedResultManifest;
    return value.schemaVersion === "openpond.harnessRefinerBenchmarkResult.v2"
        && value.modelRunId === modelRunId
      ? value
      : null;
  }));
  return manifests
    .filter((value): value is ManagedResultManifest => value !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

export async function preserveProfileResult(input: {
  profile: OpenPondProfileState;
  modelRunId: string;
  workspaceId: string;
  storeDir: string;
  manifest: ManagedResultManifest;
}): Promise<ProfileBenchmarkGitReceipt | null> {
  if (
    input.profile.mode !== "local"
    || !input.profile.repoPath
    || !input.profile.git?.head
  ) return null;
  const sourceRoot = localHarnessWorkspacePaths(
    input.storeDir,
    input.workspaceId,
  ).source;
  const sourceFiles = await listFiles(sourceRoot);
  const prefix = `benchmarks/harness-refiner/runs/${input.modelRunId}`;
  return commitProfileBenchmarkRef({
    repoPath: input.profile.repoPath,
    runId: input.modelRunId,
    baseCommit: input.profile.git.head,
    message: `Preserve Harness Refiner benchmark ${input.modelRunId}`,
    files: [
      {
        path: `${prefix}/result.json`,
        contents: `${JSON.stringify(input.manifest, null, 2)}\n`,
      },
      ...await Promise.all(sourceFiles.map(async (relativePath) => ({
        path: `${prefix}/candidate-harness/${relativePath}`,
        contents: await fs.readFile(path.join(sourceRoot, ...relativePath.split("/"))),
      }))),
    ],
  });
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, ...relative.split("/").filter(Boolean));
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, next));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

export async function ensureBaseVersion(input: {
  store: SqliteStore;
  project: ModelProject;
  modelRun: ModelRun;
  model: ChatModelRef;
  baseline: EvaluationAttempt | BenchmarkAttemptEvidence;
}) {
  if (!input.modelRun.modelVersionId) {
    throw new Error("A base-Version materialization Run requires a Model Version identity.");
  }
  const existing = await input.store.getModelVersion(input.modelRun.modelVersionId);
  if (existing) return existing;
  if (!("portable" in input.baseline)) {
    throw new Error("A portable baseline attempt is required to create the base Model Version.");
  }
  const runManifest = input.baseline.portable.runManifest;
  const tasksetRelease = input.baseline.portable.tasksetRelease;
  const graph = {
    resolvedBundleHash: contentHash({
      tasksetRelease: tasksetRelease.contentHash,
      runManifest: runManifest.contentHash,
    }),
    profileRelease: {
      id: `profile-release-${input.modelRun.profileId}`,
      revision: 1,
      contentHash: contentHash({ profileId: input.modelRun.profileId }),
    },
    harnessRelease: runManifest.harnessRelease,
    agentRelease: {
      id: input.baseline.portable.agentSnapshot.id,
      contentHash: input.baseline.portable.agentSnapshot.contentHash,
    },
    grader: {
      id: `grader-${tasksetRelease.id}`,
      contentHash: contentHash(tasksetRelease.graders),
    },
  };
  const core = {
    schemaVersion: "openpond.modelVersion.v1" as const,
    id: input.modelRun.modelVersionId,
    modelId: input.project.id,
    profileId: input.project.profileId,
    version: 0,
    kind: "base_reference" as const,
    status: "available" as const,
    baseModel: {
      schemaVersion: "openpond.baseModelPreference.v1" as const,
      modelId: `${input.model.providerId}/${input.model.modelId}`,
      revision: runManifest.model.revision,
      tokenizerRevision: runManifest.model.tokenizerRevision,
      chatTemplateHash: runManifest.model.chatTemplateHash,
      modelAssetId: null,
      source: "managed" as const,
    },
    taskset: input.modelRun.taskset,
    releaseGraph: graph,
    artifactLineageId: null,
    adapterStatus: "not_trained" as const,
    createdAt: input.modelRun.startedAt,
  };
  return input.store.saveModelVersion(ModelVersionSchema.parse({
    ...core,
    contentHash: contentHash(core),
  }));
}
