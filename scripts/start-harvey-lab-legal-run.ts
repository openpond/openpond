import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ModelProjectSchema,
  RftRecipeSchema,
  type ModelProject,
} from "@openpond/contracts";
import {
  HARVEY_LAB_REVISION,
  contentHash,
  materializeHarveyLabLegalTaskset,
} from "@openpond/taskset-sdk";

import { appDataDir } from "../apps/server/src/paths.js";
import { MANAGED_RL_BASE_PROFILE } from "../apps/server/src/training/managed-rl-base-profile.js";
import { SqliteStore } from "../apps/server/src/store/store.js";

const mode = option("--mode");
if (mode !== "preflight" && mode !== "full") {
  throw new Error("--mode must be preflight or full");
}
const maximumSpendUsd = Number(option("--maximum-spend-usd"));
if (!Number.isFinite(maximumSpendUsd) || maximumSpendUsd <= 0) {
  throw new Error("--maximum-spend-usd must be a positive number");
}
const storeDir = path.resolve(option("--store-dir", appDataDir()));
const serverUrl = option("--server-url", "http://127.0.0.1:17874").replace(/\/$/, "");
const now = new Date().toISOString();

const materialized = await materializeHarveyLabLegalTaskset({
  storeDir,
  releaseStage: "week0",
});
const taskset = materialized.taskset;
const grader = taskset.graders[0];
if (!grader) throw new Error("The Week 0 legal Taskset has no grader.");

const steps = mode === "preflight" ? 1 : 16;
const recipe = RftRecipeSchema.parse({
  schemaVersion: "openpond.rftRecipe.v1",
  method: "grpo",
  parameterization: "lora",
  baseModel: {
    id: MANAGED_RL_BASE_PROFILE.modelId,
    revision: MANAGED_RL_BASE_PROFILE.revision,
    tokenizerRevision: MANAGED_RL_BASE_PROFILE.tokenizerRevision,
    chatTemplateHash: MANAGED_RL_BASE_PROFILE.chatTemplateHash,
  },
  dataset: {
    trainSplit: "train",
    validationSplit: "validation",
    maxPromptTokens: 4_096,
    maxExamples: 4,
    selectionStrategy: "stable_hash_top_n",
  },
  lora: { rank: 16 },
  rollout: {
    groupSize: 4,
    concurrency: 4,
    maxTurns: 40,
    maxOutputTokens: 1_024,
    temperature: 0.8,
    topP: 0.95,
    seed: 17,
  },
  optimizer: {
    learningRate: 0.00001,
    maxSteps: steps,
  },
  loss: {
    method: "grpo",
    klBeta: 0.01,
  },
  reward: {
    graderId: grader.id,
    graderHash: contentHash(grader),
    environmentId: taskset.environment.entrypoint,
    environmentVersion: HARVEY_LAB_REVISION,
    toolContractHash: contentHash(taskset.environment.toolNames),
  },
  resourceLimits: {
    wallTimeMs: mode === "preflight" ? 3_600_000 : 7_800_000,
    maxRollouts: steps * 4,
    maxPayloadBytes: 10 * 1024 * 1024,
  },
  policyOptimization: null,
});

const projectId = "model_legal_contract_review_week0";
const store = new SqliteStore(storeDir);
let project: ModelProject;
try {
  await store.upsertTaskset(taskset);
  const existing = await store.getModelProject(projectId);
  const baseModel = {
    schemaVersion: "openpond.baseModelPreference.v1" as const,
    modelId: MANAGED_RL_BASE_PROFILE.modelId,
    revision: MANAGED_RL_BASE_PROFILE.revision,
    tokenizerRevision: MANAGED_RL_BASE_PROFILE.tokenizerRevision,
    chatTemplateHash: MANAGED_RL_BASE_PROFILE.chatTemplateHash,
    modelAssetId: null,
    source: "managed" as const,
  };
  project = ModelProjectSchema.parse({
    schemaVersion: "openpond.modelProject.v2",
    id: projectId,
    profileId: taskset.profileId,
    revision: (existing?.revision ?? 0) + 1,
    name: "Legal Contract Review · Harvey LAB Week 0",
    objective:
      "Improve contract redlines and risk memos through the OpenPond Work harness against hidden LAB criteria.",
    defaultBaseModel: baseModel,
    defaultDestinationId: "openpond_managed",
    trainingSetup: {
      tasksetRef: {
        id: taskset.id,
        revision: taskset.revision,
        contentHash: taskset.contentHash,
      },
      tasksetRelease: null,
      harnessRelease: null,
      baseModel,
      method: "grpo",
      destinationId: "openpond_managed",
      managedRolloutPlacement: "remote",
      runPreset: "custom",
      recipe,
      preferredMaximumSpendUsd: maximumSpendUsd,
      preferredRetentionDays: null,
    },
    hosted: existing?.hosted ?? null,
    tasksetSyncs: existing?.tasksetSyncs ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  await store.saveModelProject(project);
} finally {
  await store.close();
}

const token = (await readFile(path.join(storeDir, "token"), "utf8")).trim();
if (!token) throw new Error("The local OpenPond capability token is empty.");
const authorizationHeaders = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
const readinessResponse = await fetch(`${serverUrl}/v1/training/readiness`, {
  method: "POST",
  headers: authorizationHeaders,
  body: JSON.stringify({ tasksetId: taskset.id }),
  signal: AbortSignal.timeout(180_000),
});
const readinessPayload = await readinessResponse.json().catch(() => ({})) as Record<string, unknown>;
if (!readinessResponse.ok || readinessPayload.ready !== true) {
  throw new Error(
    typeof readinessPayload.message === "string"
      ? readinessPayload.message
      : typeof readinessPayload.error === "string"
        ? readinessPayload.error
        : `Legal Taskset readiness failed with HTTP ${readinessResponse.status}`,
  );
}
const response = await fetch(
  `${serverUrl}/v1/training/model-projects/${encodeURIComponent(project.id)}/training/start`,
  {
    method: "POST",
    headers: authorizationHeaders,
    body: JSON.stringify({
      maximumSpendUsd,
      retentionDays: null,
      exportApproved: true,
    }),
    signal: AbortSignal.timeout(180_000),
  },
);
const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
if (!response.ok) {
  throw new Error(
    typeof payload.message === "string"
      ? payload.message
      : typeof payload.error === "string"
        ? payload.error
        : `Legal Model Run start failed with HTTP ${response.status}`,
  );
}

console.log(JSON.stringify({
  mode,
  projectId: project.id,
  projectRevision: project.revision,
  tasksetId: taskset.id,
  tasksetHash: taskset.contentHash,
  taskCount: taskset.tasks.length,
  trainTaskCount: taskset.tasks.filter((task) => task.split === "train").length,
  baseModel: MANAGED_RL_BASE_PROFILE,
  optimizerSteps: steps,
  rolloutGroupSize: recipe.rollout.groupSize,
  rolloutCount: recipe.resourceLimits.maxRollouts,
  maximumSpendUsd,
  manifest: payload.manifest ?? null,
  job: payload.job ?? null,
}, null, 2));

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
