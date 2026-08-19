import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ModelProjectSchema } from "@openpond/contracts";
import {
  contentHash,
  DEFAULT_REFINER_MAX_OUTPUT_TOKENS,
} from "@openpond/harness";

import { createLocalHarnessWorkspace } from
  "../../apps/server/src/harness/local-harness-workspace-service.js";
import { SqliteStore } from "../../apps/server/src/store/store.js";
import { createBenchmarkTasksetService } from
  "../../apps/server/src/training/benchmark-tasksets.js";
import {
  createHarnessRefinerExecutionPlan,
  HARNESS_REFINER_BENCHMARK_MAX_INVOCATIONS_PER_TASK,
  HARNESS_REFINER_BENCHMARK_REFINER_TIMEOUT_MS,
} from
  "../../apps/server/src/training/harness-refiner-benchmark-protocol.js";
import { resolveBenchmarkUpstreamModel } from
  "../../apps/server/src/training/training-model-runtime.js";

const storeDir = process.env.OPENPOND_APP_HOME?.trim();
if (!storeDir) throw new Error("OPENPOND_APP_HOME is required for benchmark admission.");
const apiBaseUrl = process.env.OPENPOND_API_URL?.trim();
if (!apiBaseUrl) throw new Error("OPENPOND_API_URL is required for benchmark admission.");
const apiUrl = new URL(apiBaseUrl);
const gatewayEnvironment = apiUrl.hostname.startsWith("staging-")
  ? "staging"
  : apiUrl.hostname === "api.openpond.ai"
    ? "production"
    : "custom";
const outputPath = path.resolve(
  process.env.OPENPOND_REFINER_ADMISSION_OUTPUT?.trim()
    || path.join(storeDir, "harness-refiner-admission.json"),
);
const timestamp = new Date().toISOString();
const profileId = "harness-refiner-benchmark-v2";
const modelProjectId = "harness-refiner-flash-v2";
const model = {
  providerId: "openpond" as const,
  modelId: "accounts/fireworks/models/deepseek-v4-flash",
};
const maximumSpendUsd = 5;
const store = new SqliteStore(storeDir);

try {
  if ((await store.listHarnessWorkspaces()).length > 0) {
    throw new Error("Benchmark admission requires a fresh isolated local store.");
  }
  const harness = await createLocalHarnessWorkspace({
    store,
    storeDir,
    id: "harness-refiner-benchmark-baseline",
    ownerId: "desktop-personal",
    name: "Harness Refiner benchmark baseline",
    now: () => timestamp,
  });
  await store.selectHarnessWorkspace({
    ownerKind: "personal",
    ownerId: "desktop-personal",
    workspaceId: harness.workspace.id,
    updatedAt: timestamp,
  });
  await store.setHarnessBackgroundReviewSettings({
    workspaceId: harness.workspace.id,
    enabled: false,
    updatedAt: timestamp,
  });
  await store.setHarnessEvaluationReviewSettings({
    workspaceId: harness.workspace.id,
    settings: {
      enabled: false,
      activityEnabled: false,
      activityBatchSize: 10,
      cadence: "manual",
      maxEstimatedCostUsd: 0,
      nextRunAt: null,
      lastRunAt: null,
      lastResult: null,
      lastError: null,
      updatedAt: timestamp,
    },
  });
  await store.saveModelProject(ModelProjectSchema.parse({
    schemaVersion: "openpond.modelProject.v1",
    id: modelProjectId,
    profileId,
    name: "Harness Refiner DeepSeek V4 Flash",
    objective: "Run the versioned deterministic-reward Harness Refiner comparison.",
    defaultBaseModel: null,
    defaultDestinationId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const taskset = await createBenchmarkTasksetService({
    store,
    storeDir,
    now: () => timestamp,
  }).ensureHarnessRefiner({ profileId });
  const executionPlan = createHarnessRefinerExecutionPlan({
    taskset,
    seeds: [17],
    repetitions: 1,
  });
  const upstreamModel = await resolveBenchmarkUpstreamModel(model);
  const core = {
    schemaVersion: "openpond.harnessRefinerBenchmarkAdmission.v1",
    id: "harness-refiner-benchmark-admission-20260818-v2",
    profileId,
    modelProjectId,
    model,
    gateway: {
      service: "openpond-chat",
      environment: gatewayEnvironment,
      apiBaseUrl: apiUrl.origin,
    },
    upstreamModel,
    reasoningEffort: "low",
    sampling: { maxOutputTokens: 4_096, temperature: 0, topP: 1 },
    refiner: {
      timeoutMs: HARNESS_REFINER_BENCHMARK_REFINER_TIMEOUT_MS,
      maxOutputTokens: DEFAULT_REFINER_MAX_OUTPUT_TOKENS,
      maxInvocationsPerTask: HARNESS_REFINER_BENCHMARK_MAX_INVOCATIONS_PER_TASK,
      retryPolicy: "resume-same-attempt-and-trigger-once",
    },
    seed: 17,
    repetitions: 1,
    maximumSpendUsd,
    taskset: {
      id: taskset.benchmark!.releaseId,
      contentHash: taskset.benchmark!.releaseHash,
      projectedTasksetId: taskset.id,
      projectedContentHash: taskset.contentHash,
    },
    initialHarness: {
      id: harness.release.harnessRelease.id,
      contentHash: harness.release.harnessRelease.contentHash,
    },
    executionPlan,
    plannedAttempts: executionPlan.reduce(
      (sum, stage) => sum + stage.attemptCount,
      0,
    ),
    backgroundReviewEnabled: false,
    scheduledReviewEnabled: false,
    admittedAt: timestamp,
  } as const;
  const receipt = { ...core, contentHash: contentHash(core) };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      status: "admitted",
      taskset: receipt.taskset,
      initialHarness: receipt.initialHarness,
      model: receipt.model,
      gateway: receipt.gateway,
      upstreamModel: receipt.upstreamModel,
      reasoningEffort: receipt.reasoningEffort,
      maximumSpendUsd: receipt.maximumSpendUsd,
      plannedAttempts: receipt.plannedAttempts,
      executionPlan: receipt.executionPlan,
      contentHash: receipt.contentHash,
      outputPath,
    })}\n`,
  );
} finally {
  await store.close();
}
