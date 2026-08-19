import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BenchmarkDefinitionSchema,
  TasksetReleaseSchema,
  createBenchmarkDefinition,
  harnessRefinerBenchmarkAssets,
  harnessRefinerBenchmarkRelease,
  type BenchmarkDefinition,
  type TasksetRelease,
} from "@openpond/evals";
import {
  ImmutableAssetRefSchema,
  contentHash,
  type ImmutableAssetRef,
} from "@openpond/harness";
import {
  TasksetSchema,
  type GraderFixture,
  type GraderSpec,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";
import { computeTasksetHash } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";

const BUILTIN_DEFINITION_ID = "harness-refiner";

export function createBenchmarkTasksetService(input: {
  store: SqliteStore;
  storeDir: string;
  now?: () => string;
}) {
  const now = input.now ?? (() => new Date().toISOString());

  async function ensureHarnessRefiner(request: {
    profileId: string;
  }): Promise<Taskset> {
    const tasksetId = tasksetIdForProfile(request.profileId);
    const existing = await input.store.getTaskset(tasksetId);
    if (
      existing?.benchmark?.releaseId === harnessRefinerBenchmarkRelease.id
      && existing.benchmark.releaseHash === harnessRefinerBenchmarkRelease.contentHash
    ) {
      return existing;
    }
    const tasksetRoot = path.join(
      input.storeDir,
      "training",
      "tasksets",
      tasksetId,
    );
    const taskset = await projectRelease({
      release: harnessRefinerBenchmarkRelease,
      assets: harnessRefinerBenchmarkAssets,
      tasksetRoot,
      tasksetId,
      profileId: request.profileId,
      revision: existing ? existing.revision + 1 : 1,
      timestamp: now(),
    });
    await input.store.upsertTaskset(taskset);
    return taskset;
  }

  async function releaseForTaskset(taskset: Taskset): Promise<TasksetRelease | null> {
    if (taskset.purpose !== "benchmark" || !taskset.benchmark) return null;
    const releasePath = path.resolve(
      input.storeDir,
      "training",
      "tasksets",
      taskset.id,
      taskset.benchmark.managedReleasePath,
    );
    const release = TasksetReleaseSchema.parse(
      JSON.parse(await readFile(releasePath, "utf8")),
    );
    if (
      release.id !== taskset.benchmark.releaseId
      || release.contentHash !== taskset.benchmark.releaseHash
    ) {
      throw new Error("Managed benchmark release does not match its Taskset binding.");
    }
    return release;
  }

  return { ensureHarnessRefiner, releaseForTaskset };
}

function definitionForRelease(release: TasksetRelease): BenchmarkDefinition {
  return createBenchmarkDefinition({
    schemaVersion: "openpond.benchmarkDefinition.v1",
    id: BUILTIN_DEFINITION_ID,
    title: "Harness Refiner 20260818 v2",
    description:
      "Measures whether sequential, evidence-driven Harness improvements change verified reward on a frozen cohort; foreground tokens are secondary.",
    tasksetRelease: { id: release.id, contentHash: release.contentHash },
    adaptationSplit: "validation",
    evaluationSplit: "frozen_eval",
    primaryMetric: "success_rate",
    qualityGate: "non_regression",
    caseCounts: {
      adaptation: release.tasks.filter((task) => task.split === "validation").length,
      evaluation: release.tasks.filter((task) => task.split === "frozen_eval").length,
    },
    metadata: {
      builtin: true,
      protocol: "sequential_product_lifecycle_v3",
      orderSeed: "harness-refiner-20260818-order-v1",
      secondaryMetrics: ["foreground_tokens"],
    },
  });
}

async function projectRelease(input: {
  release: TasksetRelease;
  assets: Readonly<Record<string, string>>;
  tasksetRoot: string;
  tasksetId: string;
  profileId: string;
  revision: number;
  timestamp: string;
}): Promise<Taskset> {
  const definition = BenchmarkDefinitionSchema.parse(
    definitionForRelease(input.release),
  );
  const policyAssets = uniqueAssets(
    input.release.tasks.flatMap((task) => task.artifactRefs),
  );
  const managedAssetById = new Map<string, {
    artifactRef: string;
    fileName: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
  }>();
  await mkdir(path.join(input.tasksetRoot, "assets"), { recursive: true });
  await mkdir(path.join(input.tasksetRoot, "benchmark"), { recursive: true });
  await mkdir(path.join(input.tasksetRoot, "rubrics"), { recursive: true });
  await mkdir(path.join(input.tasksetRoot, "verifiers"), { recursive: true });
  await writeFile(
    path.join(input.tasksetRoot, "benchmark", "taskset.release.json"),
    JSON.stringify(input.release),
    "utf8",
  );
  for (const asset of policyAssets) {
    const contents = builtinAsset(input.assets, asset.path);
    if (contentHash(contents) !== asset.contentHash) {
      throw new Error(`Benchmark asset ${asset.path} failed its content hash.`);
    }
    const fileName = `${asset.id}-${path.basename(asset.path)}`;
    const artifactRef = path.posix.join("assets", fileName);
    await writeFile(path.join(input.tasksetRoot, artifactRef), contents, "utf8");
    managedAssetById.set(asset.id, {
      artifactRef,
      fileName,
      sha256: createHash("sha256").update(contents).digest("hex"),
      sizeBytes: Buffer.byteLength(contents),
      mediaType: asset.mediaType,
    });
  }
  const verifierGrader = input.release.graders.find(
    (grader) => grader.kind === "custom_verifier",
  );
  const supplementaryJudge = supplementaryModelJudge(input.release);
  if (!verifierGrader) {
    throw new Error("Benchmark release requires a custom verifier.");
  }
  await copyVerifierAsset(
    input.assets,
    input.tasksetRoot,
    supplementaryJudge.rubricRef,
  );
  await copyVerifierAsset(
    input.assets,
    input.tasksetRoot,
    verifierGrader.verifierRef,
  );

  const sourceId = `source-${input.tasksetId}`;
  const tasks: TaskDataRecord[] = input.release.tasks.map((task) => {
    return {
      schemaVersion: "openpond.taskData.v1",
      id: task.id,
      clusterKey: task.clusterKey,
      split: task.split,
      input: task.input,
      expectedOutput: task.expectedOutput,
      policyVisibleContext: task.policyVisibleContext,
      privilegedContextRef: task.privilegedContextRef,
      sourceRefs: [sourceId],
      assets: task.artifactRefs.map((asset) => {
        const managed = managedAssetById.get(asset.id);
        if (!managed) throw new Error(`Managed benchmark asset ${asset.id} is missing.`);
        return {
          id: asset.id,
          sourceRefId: sourceId,
          artifactRef: managed.artifactRef,
          fileName: managed.fileName,
          mediaType: managed.mediaType,
          sha256: managed.sha256,
          sizeBytes: managed.sizeBytes,
          split: task.split,
          metadata: { portableContentHash: asset.contentHash },
        };
      }),
      requiredOutputs: (task.requiredOutputs ?? []).map((output) => ({
        path: output.path,
        mediaType: output.mediaType,
        schemaRef: output.schemaRef?.id ?? null,
        maxBytes: output.maxBytes ?? undefined,
        metadata: output.metadata,
      })),
      tags: task.tags,
      metadata: {
        portableTaskId: task.id,
        portableTaskRecord: task,
      },
    };
  });
  const sourceFileHashes = [...managedAssetById.values()].map((asset) => asset.sha256);
  const graders: GraderSpec[] = [
    {
      id: verifierGrader.id,
      version: verifierGrader.version,
      label: "Output contract",
      kind: "custom_verifier",
      weight: verifierGrader.weight,
      hardGate: verifierGrader.hardGate,
      rewardEligible: verifierGrader.rewardEligible,
      privileged: verifierGrader.privileged,
      module: verifierGrader.verifierRef.path,
      exportName: "verify",
      timeoutMs: verifierGrader.timeoutMs,
      networkPolicy: "none",
      metadata: {
        portableVerifierHash: verifierGrader.verifierRef.contentHash,
        portableVerifierRef: verifierGrader.verifierRef,
      },
    },
  ];
  const fixtureTask = tasks.find((task) => task.id === "adaptation-launch-delay-email")
    ?? tasks[0]!;
  const graderFixtures = benchmarkFixtures(fixtureTask.id);
  const draft = TasksetSchema.parse({
    schemaVersion: "openpond.taskset.v1",
    id: input.tasksetId,
    revision: input.revision,
    profileId: input.profileId,
    profileRelease: null,
    createImproveRunId: null,
    name: definition.title,
    objective: definition.description,
    purpose: "benchmark",
    benchmark: {
      schemaVersion: "openpond.tasksetBenchmark.v1",
      definitionId: definition.id,
      releaseId: input.release.id,
      releaseHash: input.release.contentHash,
      managedReleasePath: "benchmark/taskset.release.json",
      adaptationSplit: definition.adaptationSplit,
      evaluationSplit: definition.evaluationSplit,
      primaryMetric: definition.primaryMetric,
      qualityGate: definition.qualityGate,
      source: "builtin",
      metadata: {},
    },
    status: "ready",
    sourceRefs: [{
      schemaVersion: "openpond.uploadedFileDatasetSource.v1",
      kind: "uploaded_file",
      id: sourceId,
      profileId: input.profileId,
      title: "Harness Refiner benchmark fixtures",
      sourceHash: input.release.contentHash,
      occurredAt: input.timestamp,
      licensingStatus: "approved",
      secretScanStatus: "passed",
      piiScanStatus: "passed",
      originalFileNames: [...managedAssetById.values()].map((asset) => asset.fileName),
      mediaTypes: [...new Set([...managedAssetById.values()].map((asset) => asset.mediaType))],
      sourceFileHashes,
      totalBytes: [...managedAssetById.values()].reduce((sum, asset) => sum + asset.sizeBytes, 0),
      parserVersion: "openpond-builtin-benchmark-v1",
      metadata: { generatedPublicFixture: true },
    }],
    policy: input.release.policy,
    environment: {
      protocolVersion: "openpond.taskEnvironment.v1",
      kind: "work",
      entrypoint: "openpond-work-v1",
      stateful: true,
      deterministicSeeds: input.release.environment.deterministicSeeds,
      toolNames: input.release.tools.map((tool) => tool.name),
      lifecycle: ["create", "reset", "step", "grade", "cleanup"],
      defaultTimeoutMs: input.release.environment.defaultTimeoutMs,
      networkPolicy: input.release.environment.networkPolicy,
      metadata: {
        portableEnvironmentHash: contentHash(input.release.environment),
        portableTools: input.release.tools,
        maxToolTurns: 40,
      },
    },
    capabilities: {
      schemaVersion: "openpond.tasksetCapabilities.v1",
      taskKind: "single_agent",
      supportedSignals: [],
      compatibleMethods: ["none"],
      rewardKinds: ["deterministic"],
      requiresTools: true,
      requiresState: true,
      requiresPrivilegedGrading: true,
      environmentPlacements: ["local", "remote"],
      exportable: true,
      portabilityBlockers: [],
    },
    tasks,
    graders,
    graderFixtures,
    learningSignals: {
      demonstrations: [],
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: [],
      labels: [],
    },
    authoringProvenance: {
      schemaVersion: "openpond.taskAuthoringProvenance.v1",
      model: null,
      modelConfig: {},
      skillHash: input.release.contentHash,
      promptTemplateVersion: "public-benchmark-release-v1",
      buildIntent: "rubric",
      buildSpecification: null,
      evidenceHashes: [input.release.contentHash, ...sourceFileHashes],
      tasksetSdkVersion: "portable-builtin-release-v1",
      sourceCommit: null,
      repairHistory: [],
      createdAt: input.timestamp,
    },
    readiness: null,
    contentHash: "00000000",
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    metadata: {
      portableTasksetRelease: {
        id: input.release.id,
        contentHash: input.release.contentHash,
      },
      supplementaryModelJudge: {
        id: supplementaryJudge.id,
        version: supplementaryJudge.version,
        rubricHash: supplementaryJudge.rubricRef.contentHash,
        calibrationStatus: supplementaryJudge.calibrationStatus,
        executable: false,
        rewardEligible: false,
      },
      portableCapabilities: input.release.capabilities,
    },
  });
  return TasksetSchema.parse({
    ...draft,
    contentHash: computeTasksetHash(draft),
  });
}

function tasksetIdForProfile(profileId: string): string {
  return `benchmark-harness-refiner-${contentHash(profileId).slice(0, 16)}`;
}

async function copyVerifierAsset(
  assets: Readonly<Record<string, string>>,
  tasksetRoot: string,
  asset: ImmutableAssetRef,
): Promise<string> {
  const contents = builtinAsset(assets, asset.path);
  if (contentHash(contents) !== asset.contentHash) {
    throw new Error(`Benchmark verifier asset ${asset.path} failed its content hash.`);
  }
  await writeFile(path.join(tasksetRoot, asset.path), contents, "utf8");
  return contents;
}

function builtinAsset(
  assets: Readonly<Record<string, string>>,
  assetPath: string,
): string {
  const contents = assets[assetPath];
  if (contents === undefined) {
    throw new Error(`Built-in benchmark asset ${assetPath} is unavailable.`);
  }
  return contents;
}

function benchmarkFixtures(taskId: string): GraderFixture[] {
  return [
    {
      id: "benchmark-positive",
      taskId,
      label: "positive",
      output: {
        text: "Subject: Acme pilot launch update\n\nThe launch is moving from August 20 to August 27 because final accessibility testing is not complete. Testing is expected to finish August 22, and existing pilot access remains available. Please send questions to pilot-support@example.com.",
      },
      infrastructureError: null,
      expectedPassed: true,
      expectedRewardEligible: true,
      metadata: {},
    },
    {
      id: "benchmark-negative",
      taskId,
      label: "negative",
      output: {
        text: "Draft saved to /workspace/outputs/acme-launch-email.md. Checklist: new date included; accessibility testing mentioned; pilot access preserved; support address included; under 140 words.",
      },
      infrastructureError: null,
      expectedPassed: false,
      expectedRewardEligible: true,
      metadata: {},
    },
    {
      id: "benchmark-boundary",
      taskId,
      label: "boundary",
      output: { text: "The launch is moving to August 27 while testing finishes." },
      infrastructureError: null,
      expectedPassed: false,
      expectedRewardEligible: true,
      metadata: {},
    },
  ];
}

function uniqueAssets<T extends { id: string }>(assets: T[]): T[] {
  return [...new Map(assets.map((asset) => [asset.id, asset])).values()];
}

function supplementaryModelJudge(release: TasksetRelease) {
  const raw = release.metadata.supplementaryModelJudge;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Benchmark release has no supplementary model-judge metadata.");
  }
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string"
    || typeof value.version !== "string"
    || value.calibrationStatus !== "pending"
    || value.executable !== false
    || value.rewardEligible !== false
  ) {
    throw new Error("Benchmark supplementary model-judge metadata is invalid.");
  }
  return {
    id: value.id,
    version: value.version,
    calibrationStatus: value.calibrationStatus,
    rubricRef: ImmutableAssetRefSchema.parse(value.rubricRef),
  };
}
