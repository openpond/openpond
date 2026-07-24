import assert from "node:assert/strict";
import test from "node:test";
import {
  TaskCreationRequestSchema,
  TasksetReadinessReportSchema,
  ModelRunDraftSchema,
  TrainingMethodAvailabilitySchema,
  TrainingMethodSchema,
  TrainingRecipeSchema,
  UnsupportedTrainingRecipeSchema,
} from "../packages/contracts/src/index.js";
import { createTrainingPlan } from "../packages/training-sdk/src/index.js";
import { computeTasksetHash, validateTaskset } from "../packages/taskset-sdk/src/index.js";
import { buildTasksetReadiness } from "../apps/server/src/training/readiness.js";
import {
  FIXED_TIME,
  sftRecipeFixture,
  tasksetFixture,
} from "./helpers/training-fixtures.js";

test("Dataset build intent is persisted independently from the training method hint", () => {
  const request = TaskCreationRequestSchema.parse({
    schemaVersion: "openpond.taskCreationRequest.v1",
    id: "request_preferences",
    profileId: "default",
    surface: "training_page",
    mode: "defaults",
    entryMode: "manual",
    resourceIntent: "dataset",
    buildIntent: "preferences",
    buildSpecification: {
      kind: "preferences",
      preference: "Prefer the answer that is correct and concise.",
      pairs: [{
        id: "pair_1",
        prompt: "What is 2 + 2?",
        chosen: "4",
        rejected: "It may be 5.",
        rationale: "The chosen response is correct.",
      }],
    },
    objective: "Prefer concise correct answers.",
    methodHint: "dpo",
    sourceIds: [],
    candidateId: null,
    analysisModel: null,
    createdAt: FIXED_TIME,
  });

  assert.equal(request.buildIntent, "preferences");
  assert.equal(request.buildSpecification?.kind, "preferences");
  assert.equal(request.methodHint, "dpo");
});

test("PPO is first-class and cannot fall back to an unsupported placeholder recipe", () => {
  assert.equal(TrainingMethodSchema.parse("ppo"), "ppo");
  assert.equal(UnsupportedTrainingRecipeSchema.safeParse({
    schemaVersion: "openpond.unsupportedRecipe.v1",
    method: "ppo",
    parameterization: "lora",
    unsupportedReason: "PPO must use its complete policy/reference/critic contract.",
  }).success, false);
  assert.equal(TrainingRecipeSchema.safeParse({
    schemaVersion: "openpond.unsupportedRecipe.v1",
    method: "ppo",
    parameterization: "lora",
    unsupportedReason: "PPO must use its complete policy/reference/critic contract.",
  }).success, false);
});

test("Model run drafts keep Model and immutable Dataset identity separate", () => {
  const draft = ModelRunDraftSchema.parse({
    schemaVersion: "openpond.modelRunDraft.v1",
    id: "run_draft_fixture",
    profileId: "default",
    modelId: "model_independent_fixture",
    status: "draft",
    title: "Run draft",
    datasetMode: "existing",
    tasksetRef: {
      id: "dataset_fixture",
      revision: 3,
      contentHash: "a".repeat(64),
    },
    datasetCreationId: null,
    buildIntent: null,
    buildSpecification: null,
    baseModel: null,
    method: "sft",
    destinationId: null,
    runPreset: "small",
    recipe: null,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  });

  assert.notEqual(draft.modelId, draft.tasksetRef?.id);
  assert.equal(draft.tasksetRef?.revision, 3);
  assert.equal(draft.runPreset, "small");
});

test("method readiness and destination availability remain distinct", () => {
  const readiness = TasksetReadinessReportSchema.parse({
    schemaVersion: "openpond.tasksetReadiness.v1",
    tasksetId: "dataset_preferences",
    tasksetHash: "a".repeat(64),
    ready: false,
    recommendedMethod: "dpo",
    methodReadiness: [{
      method: "dpo",
      status: "needs_dataset_work",
      reasonCodes: ["preference_pairs_missing"],
      reasons: ["Add chosen and rejected response pairs."],
    }],
    compatibleDestinationClasses: ["export"],
    blockers: [],
    warnings: [],
    baselineReportId: null,
    generatedAt: FIXED_TIME,
  });
  const availability = TrainingMethodAvailabilitySchema.parse({
    method: "ppo",
    state: "destination_unavailable",
    reasonCodes: ["destination_unavailable", "value_model_required"],
    reasons: ["No configured destination currently executes PPO."],
  });

  assert.equal(readiness.methodReadiness[0]?.reasonCodes[0], "preference_pairs_missing");
  assert.equal(availability.state, "destination_unavailable");
});

test("two Models can train from one Dataset without sharing plan identity", () => {
  const taskset = tasksetFixture({ ready: true });
  const first = createTrainingPlan({
    modelId: "model_alpha",
    taskset,
    destinationId: "local_cpu_fixture",
    recipe: sftRecipeFixture(),
  });
  const second = createTrainingPlan({
    modelId: "model_beta",
    taskset,
    destinationId: "local_cpu_fixture",
    recipe: sftRecipeFixture(),
  });

  assert.equal(first.tasksetId, second.tasksetId);
  assert.notEqual(first.modelId, second.modelId);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.contentHash, second.contentHash);
});

test("one Model can bind distinct immutable Dataset revisions across plans", () => {
  const firstRevision = tasksetFixture({ ready: true });
  const nextDraft = {
    ...firstRevision,
    revision: firstRevision.revision + 1,
    objective: "Reproduce an approved greeting style with concise outputs.",
    readiness: null,
    contentHash: "00000000",
    updatedAt: "2026-07-12T01:00:00.000Z",
  };
  const nextHash = computeTasksetHash(nextDraft);
  const secondRevision = {
    ...nextDraft,
    status: "ready" as const,
    contentHash: nextHash,
    readiness: {
      ...firstRevision.readiness!,
      tasksetHash: nextHash,
      generatedAt: "2026-07-12T01:00:00.000Z",
    },
  };
  const first = createTrainingPlan({
    modelId: "model_long_lived",
    taskset: firstRevision,
    destinationId: "local_cpu_fixture",
    recipe: sftRecipeFixture(),
  });
  const second = createTrainingPlan({
    modelId: "model_long_lived",
    taskset: secondRevision,
    destinationId: "local_cpu_fixture",
    recipe: sftRecipeFixture(),
  });

  assert.equal(first.modelId, second.modelId);
  assert.notEqual(first.tasksetHash, second.tasksetHash);
  assert.notEqual(first.id, second.id);
});

test("readiness gives method-specific DPO and PPO repair guidance", () => {
  const taskset = tasksetFixture();
  const report = buildTasksetReadiness({
    taskset,
    baseline: null,
    graderAudit: null,
    generatedAt: FIXED_TIME,
  });
  const dpo = report.methodReadiness.find((entry) => entry.method === "dpo");
  const ppo = report.methodReadiness.find((entry) => entry.method === "ppo");

  assert.equal(dpo?.status, "needs_dataset_work");
  assert.ok(dpo?.reasonCodes.includes("preference_pairs_missing"));
  assert.ok(ppo?.reasonCodes.includes("executable_reward_missing"));
  assert.ok(ppo?.reasonCodes.includes("value_model_required"));
});

test("signal validation rejects an invalid chosen/rejected pair", () => {
  const base = tasksetFixture();
  const draft = {
    ...base,
    capabilities: {
      ...base.capabilities,
      supportedSignals: ["preference" as const],
      compatibleMethods: ["dpo" as const],
      rewardKinds: ["none" as const],
    },
    learningSignals: {
      demonstrations: [],
      preferences: [{
        id: "preference_invalid",
        kind: "preference" as const,
        taskId: base.tasks[0]!.id,
        sourceRefs: [base.sourceRefs[0]!.id],
        artifactRef: "preference_invalid_artifact",
        approved: true,
        confidence: 1,
        prompt: "Answer the question.",
        chosen: "The same response.",
        rejected: "The same response.",
        rationale: null,
        metadata: {},
      }],
      corrections: [],
      feedback: [],
      rewards: [],
      labels: [],
    },
    contentHash: "00000000",
  };
  const taskset = {
    ...draft,
    contentHash: computeTasksetHash(draft),
  };

  assert.ok(validateTaskset(taskset).issues.some((issue) =>
    issue.code === "preference_pair_identical"));
});
