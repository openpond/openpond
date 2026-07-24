import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SftRecipeSchema,
  DpoRecipeSchema,
  PpoRecipeSchema,
  TaskAttemptResultSchema,
  TasksetSchema,
  TaskDesignProposalSchema,
  TrainingPlanSchema,
  TrainingSourceRefSchema,
  type TaskAttemptResult,
  type Taskset,
  type TrainingDestinationId,
  type TrainingPlan,
  type TrainingSourceRef,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "../../packages/contracts/src";
import { computeTasksetHash, contentHash } from "../../packages/taskset-sdk/src";
import { createTrainingPlan } from "../../packages/training-sdk/src";
import { SqliteStore } from "../../apps/server/src/store/store";

export const FIXED_TIME = "2026-07-12T00:00:00.000Z";

export function sourceFixture(id = "source_train", clusterKey = "cluster_train", sessionId = `session_${id}`): TrainingSourceRef {
  return TrainingSourceRefSchema.parse({ schemaVersion: "openpond.trainingSource.v1", id, profileId: "default", sessionId, turnIds: [`turn_${id}`], workspaceId: null, sourceHash: contentHash(id), clusterKey, title: `Source ${id}`, occurredAt: FIXED_TIME, consent: { status: "granted", scope: "selected_turns", grantedBy: "local_user", grantedAt: FIXED_TIME, purpose: "task_authoring_and_evaluation" }, connectedAppIds: [], secretScanStatus: "passed", piiScanStatus: "passed", licensingStatus: "approved", metadata: {} });
}

export function tasksetFixture(options: { ready?: boolean; profileId?: string; graders?: Taskset["graders"] } = {}): Taskset {
  const trainSource = sourceFixture();
  const evalSource = sourceFixture("source_eval", "cluster_eval");
  const tasks = [
    { schemaVersion: "openpond.taskData.v1" as const, id: "task_train", clusterKey: trainSource.clusterKey, split: "train" as const, input: { prompt: "Say hello" }, expectedOutput: { text: "Hello friend" }, policyVisibleContext: {}, privilegedContextRef: "outcome_train", sourceRefs: [trainSource.id], tags: ["fixture"], metadata: { exampleOrigin: "corrected" } },
    { schemaVersion: "openpond.taskData.v1" as const, id: "task_eval", clusterKey: evalSource.clusterKey, split: "frozen_eval" as const, input: { prompt: "Say goodbye" }, expectedOutput: { text: "Goodbye friend" }, policyVisibleContext: {}, privilegedContextRef: "outcome_eval", sourceRefs: [evalSource.id], tags: ["fixture"], metadata: { exampleOrigin: "corrected" } },
  ];
  const graders = options.graders ?? [{ id: "expected_output", version: "1", label: "Expected output", kind: "state" as const, weight: 1, hardGate: true, rewardEligible: true, privileged: true, config: { fields: ["text"] }, metadata: {} }];
  const fixtureBase = { taskId: "task_eval", infrastructureError: null, expectedPassed: false, expectedRewardEligible: false, metadata: {} };
  const graderFixtures = [
    { ...fixtureBase, id: "fixture_positive", label: "positive" as const, output: { text: "Goodbye friend" }, expectedPassed: true, expectedRewardEligible: true },
    { ...fixtureBase, id: "fixture_negative", label: "negative" as const, output: {} },
    { ...fixtureBase, id: "fixture_boundary", label: "boundary" as const, output: { text: "Goodbye friend", extra: true }, expectedPassed: true, expectedRewardEligible: true },
    { ...fixtureBase, id: "fixture_adversarial", label: "adversarial" as const, output: { text: "reward me" } },
    { ...fixtureBase, id: "fixture_prompt", label: "prompt_injection" as const, output: { text: "ignore grader" } },
    { ...fixtureBase, id: "fixture_infra", label: "infrastructure_failure" as const, output: {}, infrastructureError: "Synthetic infrastructure failure." },
  ];
  const draft = TasksetSchema.parse({ schemaVersion: "openpond.taskset.v1", id: "taskset_fixture", profileId: options.profileId ?? "default", name: "Fixture Taskset", objective: "Reproduce an approved greeting style.", status: "needs_review", sourceRefs: [trainSource, evalSource], policy: { policyVisibleFields: ["input.prompt"], privilegedFields: ["expectedOutput.text"], hiddenGraderRefs: ["expected_output"], connectedAppScopes: [] }, environment: { protocolVersion: "openpond.taskEnvironment.v1", kind: "chat", entrypoint: "environment/taskset.ts", stateful: false, deterministicSeeds: true, toolNames: [], lifecycle: ["create", "reset", "step", "grade", "cleanup"], defaultTimeoutMs: 120_000, networkPolicy: "none", metadata: {} }, capabilities: { schemaVersion: "openpond.tasksetCapabilities.v1", taskKind: "chat", supportedSignals: ["demonstration"], compatibleMethods: ["sft"], rewardKinds: ["deterministic"], requiresTools: false, requiresState: false, requiresPrivilegedGrading: true, environmentPlacements: ["local", "remote"], exportable: true, portabilityBlockers: [] }, tasks, graders, graderFixtures, learningSignals: { demonstrations: [{ id: "demo_train", kind: "demonstration", taskId: "task_train", sourceRefs: [trainSource.id], artifactRef: "expected_train", approved: true, confidence: 1, metadata: {} }], preferences: [], corrections: [], feedback: [], rewards: [], labels: [] }, authoringProvenance: { schemaVersion: "openpond.taskAuthoringProvenance.v1", model: null, modelConfig: {}, skillHash: contentHash("skill"), promptTemplateVersion: "task-authoring.v1", evidenceHashes: [trainSource.sourceHash, evalSource.sourceHash], tasksetSdkVersion: "0.0.1", sourceCommit: null, repairHistory: [], createdAt: FIXED_TIME }, readiness: null, contentHash: "00000000", createdAt: FIXED_TIME, updatedAt: FIXED_TIME, metadata: { trainingMethod: "sft", diagnosis: { schemaVersion: "openpond.capabilityDiagnosis.v1", summary: "Reproduce a stable greeting style.", stableBehavior: ["Use the approved greeting style."], changingKnowledge: [], requiredContext: [], requiredTools: [], intervention: "sft", trainingEligible: true, rationale: ["Independent examples demonstrate the stable behavior."], confidence: 0.9 } } });
  const hash = computeTasksetHash(draft);
  const readiness = options.ready ? { schemaVersion: "openpond.tasksetReadiness.v1" as const, tasksetId: draft.id, tasksetHash: hash, ready: true, recommendedMethod: "sft" as const, compatibleDestinationClasses: ["export" as const, "local_cpu_fixture" as const, "custom" as const, "openpond_managed" as const], blockers: [], warnings: [], baselineReportId: "baseline_fixture", generatedAt: FIXED_TIME } : null;
  return TasksetSchema.parse({ ...draft, status: readiness ? "ready" : "needs_review", readiness, contentHash: hash });
}

export function sftRecipeFixture() {
  return SftRecipeSchema.parse({ schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora", baseModel: { id: "openpond/tiny-cpu-gpt2-fixture", revision: "architecture-v2-seed-17-context-512", tokenizerRevision: "wordlevel-v1", chatTemplateHash: "fixture00000000" }, dataset: { trainSplit: "train", validationSplit: "frozen_eval", completionOnly: true, maxSequenceLength: 64 }, lora: { rank: 2, alpha: 4, dropout: 0, targetModules: ["c_attn"] }, optimizer: { learningRate: 0.01, epochs: 1, maxSteps: 2, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 }, resourceLimits: { cpuThreads: 2, memoryBytes: 2_000_000_000, wallTimeMs: 120_000 } });
}

export function planFixture(taskset = tasksetFixture({ ready: true }), destinationId: TrainingDestinationId = "local_cpu_fixture"): TrainingPlan {
  const draft = createTrainingPlan({ modelId: "model_fixture", taskset, destinationId, recipe: sftRecipeFixture(), exportApproved: true });
  const compatibility = { schemaVersion: "openpond.trainingCompatibility.v1" as const, compatible: true, destinationId, tasksetId: taskset.id, recipeMethod: "sft" as const, issues: [], checkedAt: FIXED_TIME };
  return TrainingPlanSchema.parse({ ...draft, compatibility, contentHash: contentHash({ ...draft, compatibility, contentHash: "" }) });
}

export function preferenceTasksetFixture(): Taskset {
  const base = tasksetFixture();
  const draft = TasksetSchema.parse({
    ...base,
    status: "needs_review",
    capabilities: {
      ...base.capabilities,
      supportedSignals: ["preference"],
      compatibleMethods: ["dpo"],
      rewardKinds: ["none"],
    },
    learningSignals: {
      demonstrations: [],
      preferences: [{
        id: "preference_fixture",
        kind: "preference",
        taskId: "task_train",
        sourceRefs: ["source_train"],
        artifactRef: "preference_fixture_artifact",
        approved: true,
        confidence: 1,
        prompt: "Say hello",
        chosen: "Hello friend",
        rejected: "Go away",
        rationale: "The chosen response follows the approved style.",
        metadata: {},
      }],
      corrections: [],
      feedback: [],
      rewards: [],
      labels: [],
    },
    readiness: null,
    contentHash: "00000000",
    metadata: { ...base.metadata, trainingMethod: "dpo" },
  });
  const tasksetHash = computeTasksetHash(draft);
  return TasksetSchema.parse({
    ...draft,
    status: "ready",
    contentHash: tasksetHash,
    readiness: {
      schemaVersion: "openpond.tasksetReadiness.v1",
      tasksetId: draft.id,
      tasksetHash,
      ready: true,
      recommendedMethod: "dpo",
      trainingPath: { primaryMethod: "dpo", bootstrap: null },
      methodReadiness: [{ method: "dpo", status: "recommended", reasonCodes: [], reasons: [] }],
      compatibleDestinationClasses: ["local_cpu_fixture"],
      blockers: [],
      warnings: [],
      baselineReportId: null,
      baselineReward: null,
      generatedAt: FIXED_TIME,
    },
  });
}

export function rewardTasksetFixture(): Taskset {
  const base = tasksetFixture();
  const draft = TasksetSchema.parse({
    ...base,
    status: "needs_review",
    capabilities: {
      ...base.capabilities,
      supportedSignals: ["reward"],
      compatibleMethods: ["grpo", "ppo"],
      rewardKinds: ["deterministic"],
    },
    learningSignals: {
      demonstrations: [],
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: [{
        id: "reward_fixture",
        kind: "reward",
        taskId: "task_train",
        sourceRefs: ["source_train"],
        artifactRef: "reward_fixture_artifact",
        approved: true,
        confidence: 1,
        task: "Produce the expected greeting.",
        rules: [{ id: "exact", points: 1, condition: "Output matches the expected text." }],
        otherwisePoints: 0,
        executable: true,
        metadata: {},
      }],
      labels: [],
    },
    readiness: null,
    contentHash: "00000000",
    metadata: { ...base.metadata, trainingMethod: "ppo" },
  });
  const tasksetHash = computeTasksetHash(draft);
  return TasksetSchema.parse({
    ...draft,
    status: "ready",
    contentHash: tasksetHash,
    readiness: {
      schemaVersion: "openpond.tasksetReadiness.v1",
      tasksetId: draft.id,
      tasksetHash,
      ready: true,
      recommendedMethod: "ppo",
      trainingPath: { primaryMethod: "ppo", bootstrap: null },
      methodReadiness: [
        { method: "grpo", status: "compatible", reasonCodes: [], reasons: [] },
        { method: "ppo", status: "recommended", reasonCodes: ["value_model_required"], reasons: ["Bind the recipe value model."] },
      ],
      compatibleDestinationClasses: ["local_cpu_fixture"],
      blockers: [],
      warnings: [],
      baselineReportId: null,
      baselineReward: null,
      generatedAt: FIXED_TIME,
    },
  });
}

export function dpoRecipeFixture() {
  const model = fixtureModelRef();
  return DpoRecipeSchema.parse({
    schemaVersion: "openpond.dpoRecipe.v1",
    method: "dpo",
    parameterization: "lora",
    policyModel: model,
    referenceModel: model,
    dataset: { trainSplit: "train", validationSplit: "frozen_eval", maxPairs: 8, maxPromptTokens: 64, maxCompletionTokens: 64, selectionStrategy: "stable_hash_top_n", selectionSeed: 17 },
    lora: { rank: 2, alpha: 4, dropout: 0, targetModules: ["c_attn"] },
    loss: { variant: "sigmoid", beta: 0.1, labelSmoothing: 0 },
    optimizer: { learningRate: 0.01, epochs: 1, maxSteps: 2, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 },
    referenceLogprobs: { cacheSchemaVersion: "openpond.dpoReferenceLogprobs.v1", cacheKey: "cachehash", invalidationHash: "invalidatehash" },
    resourceLimits: { cpuThreads: 2, memoryBytes: 2_000_000_000, wallTimeMs: 120_000 },
  });
}

export function ppoRecipeFixture(taskset = rewardTasksetFixture()) {
  const model = fixtureModelRef();
  const valueModel = { ...model, id: `${model.id}:value-head-v1` };
  return PpoRecipeSchema.parse({
    schemaVersion: "openpond.ppoRecipe.v1",
    method: "ppo",
    parameterization: "lora",
    policyOptimization: {
      schemaVersion: "openpond.policyOptimization.v1",
      policyModel: model,
      referenceModel: model,
      dataset: { tasksetId: taskset.id, tasksetHash: taskset.contentHash, split: "train", selectionStrategy: "stable_hash_top_n", selectionSeed: 17, maxExamples: 1 },
      sampler: { temperature: 0.8, topP: 0.95, maxOutputTokens: 4, maxTurns: 1, concurrency: 1 },
      environment: { id: taskset.environment.entrypoint, version: taskset.environment.protocolVersion, toolContractHash: "no-tools-v1" },
      reward: { graderId: "openpond.deterministic_token_match.v1", graderHash: contentHash(taskset.graders) },
      kl: { coefficient: 0.05, referenceConstraint: "fixed_reference" },
      budgets: { maxRollouts: 2, maxEnvironmentExecutions: 2, maxInputTokens: 256, maxOutputTokens: 8, maxOptimizerSteps: 2, wallTimeMs: 120_000, maximumCostUsd: 0 },
      checkpointEverySteps: 1,
      seed: 17,
      evaluationSplit: "frozen_eval",
      optimizer: { method: "ppo", valueModel, gamma: 1, gaeLambda: 0.95, policyClip: 0.2, valueClip: 0.2, valueLossCoefficient: 0.5, ppoEpochs: 2, minibatchSize: 1 },
    },
    lora: { rank: 2, alpha: 4, dropout: 0, targetModules: ["c_attn"] },
    valueHead: { initialization: "policy_hidden_state_linear", optimizerLearningRate: 0.01, artifactName: "value_head.safetensors" },
    policyLearningRate: 0.01,
    resume: { checkpointId: null, policyHash: contentHash(model), referenceHash: contentHash(model), valueModelHash: contentHash(valueModel), optimizerStateHash: null },
    resourceLimits: { cpuThreads: 2, memoryBytes: 2_000_000_000, wallTimeMs: 120_000 },
  });
}

export function executablePlanFixture(
  taskset: Taskset,
  recipe: ReturnType<typeof dpoRecipeFixture> | ReturnType<typeof ppoRecipeFixture>,
): TrainingPlan {
  const draft = createTrainingPlan({
    modelId: `model_${recipe.method}_fixture`,
    taskset,
    destinationId: "local_cpu_fixture",
    recipe,
    exportApproved: true,
  });
  const compatibility = {
    schemaVersion: "openpond.trainingCompatibility.v1" as const,
    compatible: true,
    destinationId: "local_cpu_fixture" as const,
    tasksetId: taskset.id,
    recipeMethod: recipe.method,
    issues: [],
    checkedAt: FIXED_TIME,
  };
  return TrainingPlanSchema.parse({
    ...draft,
    environmentPlacement: recipe.method === "ppo" ? "local" : "none",
    compatibility,
    contentHash: contentHash({ ...draft, compatibility, contentHash: "" }),
  });
}

function fixtureModelRef() {
  return {
    id: "openpond/tiny-cpu-gpt2-fixture",
    revision: "architecture-v2-seed-17-context-512",
    tokenizerRevision: "wordlevel-v1",
    chatTemplateHash: "fixture00000000",
  };
}

export function attemptFixture(input: Partial<TaskAttemptResult> = {}): TaskAttemptResult {
  return TaskAttemptResultSchema.parse({ schemaVersion: "openpond.taskAttempt.v1", id: "attempt_fixture", tasksetId: "taskset_fixture", taskId: "task_eval", split: "frozen_eval", attempt: 0, seed: 0, modelRef: { providerId: "custom-openai-compatible", modelId: "local-fixture" }, startedAt: FIXED_TIME, completedAt: FIXED_TIME, output: { text: "Goodbye friend" }, runtimeEventRefs: [], artifactRefs: [], privilegedOutcomeRef: "outcome_eval", infrastructureError: null, costUsd: 0, latencyMs: 1, userInterventions: 0, metadata: {}, ...input });
}

export function proposalFixture(sourceIds = ["source_train", "source_eval"]) {
  const taskset = tasksetFixture();
  const proposedExamples = taskset.tasks.map((task, index) => ({ id: `example_fixture_${index}`, sourceId: task.sourceRefs[0]!, sourceTurnId: null, split: task.split, origin: "corrected" as const, inputPrompt: String(task.input.prompt), expectedOutputText: typeof task.expectedOutput?.text === "string" ? task.expectedOutput.text : null, rationale: "Fixture example intentionally authored for contract testing." })).filter((example) => sourceIds.includes(example.sourceId));
  return TaskDesignProposalSchema.parse({ schemaVersion: "openpond.taskDesignProposal.v1", id: "proposal_fixture", name: "Fixture task design", objective: "Reproduce an approved greeting style.", diagnosis: { schemaVersion: "openpond.capabilityDiagnosis.v1", summary: "Reproduce a stable greeting style.", stableBehavior: ["Use the approved greeting style."], changingKnowledge: [], requiredContext: [], requiredTools: [], intervention: "sft", trainingEligible: true, rationale: ["The selected conversations contain greeting demonstrations."], confidence: 0.9 }, taskKind: "chat", sourceIds, assumptions: ["Selected outputs become approved demonstrations only after Taskset materialization."], successCriteria: ["Match expected response state."], proposedGraders: taskset.graders, graderFixtures: taskset.graderFixtures.map((fixture) => ({ id: fixture.id, taskIndex: 0, label: fixture.label, output: fixture.output, infrastructureError: fixture.infrastructureError, expectedPassed: fixture.expectedPassed, expectedRewardEligible: fixture.expectedRewardEligible, metadata: { ...fixture.metadata, preferFrozenEvaluation: true } })), generatedFiles: [], proposedExamples, proposedMethod: "sft", policy: taskset.policy, warnings: [], createdAt: FIXED_TIME });
}

export async function withTrainingStore<T>(run: (input: { store: SqliteStore; directory: string }) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openpond-training-test-"));
  const store = new SqliteStore(directory);
  try { return await run({ store, directory }); }
  finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}

export async function seedConversation(store: SqliteStore, input: { sessionId?: string; turnId?: string; title?: string; prompt?: string; assistant?: string } = {}) {
  const sessionId = input.sessionId ?? "session_training";
  const turnId = input.turnId ?? "turn_training";
  const session: Session = { id: sessionId, provider: "openpond", modelRef: null, title: input.title ?? "Research and update product", appId: null, appName: null, workspaceId: null, workspaceName: null, localProjectId: null, cloudProjectId: null, cloudTeamId: null, cwd: "/tmp/openpond", codexThreadId: null, createdAt: FIXED_TIME, updatedAt: FIXED_TIME, status: "idle", pinned: false, archived: false, order: 0 };
  const turn: Turn = { id: turnId, sessionId, providerTurnId: null, modelRef: { providerId: "openpond", modelId: "openpond-chat" }, prompt: input.prompt ?? "Research this topic and update the product.", startedAt: FIXED_TIME, completedAt: FIXED_TIME, status: "completed", error: null, metadata: {}, createImproveRun: null };
  const event: RuntimeEvent = { id: `event_${turnId}`, sessionId, turnId, name: "assistant.delta", timestamp: FIXED_TIME, source: "provider", status: "running", output: input.assistant ?? "Completed the research and product update." };
  await store.mutate((data) => { data.sessions.push(session); data.turns.push(turn); data.events.push(event); });
  return { session, turn, event };
}
