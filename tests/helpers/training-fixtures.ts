import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SftRecipeSchema,
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
    { schemaVersion: "openpond.taskData.v1" as const, id: "task_train", clusterKey: trainSource.clusterKey, split: "train" as const, input: { prompt: "Say hello" }, expectedOutput: { text: "Hello friend" }, policyVisibleContext: {}, privilegedContextRef: "outcome_train", sourceRefs: [trainSource.id], tags: ["fixture"], metadata: {} },
    { schemaVersion: "openpond.taskData.v1" as const, id: "task_eval", clusterKey: evalSource.clusterKey, split: "frozen_eval" as const, input: { prompt: "Say goodbye" }, expectedOutput: { text: "Goodbye friend" }, policyVisibleContext: {}, privilegedContextRef: "outcome_eval", sourceRefs: [evalSource.id], tags: ["fixture"], metadata: {} },
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
  const draft = TasksetSchema.parse({ schemaVersion: "openpond.taskset.v1", id: "taskset_fixture", profileId: options.profileId ?? "default", name: "Fixture Taskset", objective: "Reproduce an approved greeting style.", status: "needs_review", sourceRefs: [trainSource, evalSource], policy: { policyVisibleFields: ["input.prompt"], privilegedFields: ["expectedOutput.text"], hiddenGraderRefs: ["expected_output"], connectedAppScopes: [] }, environment: { protocolVersion: "openpond.taskEnvironment.v1", kind: "chat", entrypoint: "environment/taskset.ts", stateful: false, deterministicSeeds: true, toolNames: [], lifecycle: ["create", "reset", "step", "grade", "cleanup"], defaultTimeoutMs: 120_000, networkPolicy: "none", metadata: {} }, capabilities: { schemaVersion: "openpond.tasksetCapabilities.v1", taskKind: "chat", supportedSignals: ["demonstration"], compatibleMethods: ["sft"], rewardKinds: ["deterministic"], requiresTools: false, requiresState: false, requiresPrivilegedGrading: true, environmentPlacements: ["local", "remote"], exportable: true, portabilityBlockers: [] }, tasks, graders, graderFixtures, learningSignals: { demonstrations: [{ id: "demo_train", kind: "demonstration", taskId: "task_train", sourceRefs: [trainSource.id], artifactRef: "expected_train", approved: true, confidence: 1, metadata: {} }], preferences: [], corrections: [], feedback: [], rewards: [], labels: [] }, authoringProvenance: { schemaVersion: "openpond.taskAuthoringProvenance.v1", model: null, modelConfig: {}, skillHash: contentHash("skill"), promptTemplateVersion: "task-authoring.v1", evidenceHashes: [trainSource.sourceHash, evalSource.sourceHash], tasksetSdkVersion: "0.0.1", sourceCommit: null, repairHistory: [], createdAt: FIXED_TIME }, readiness: null, contentHash: "00000000", createdAt: FIXED_TIME, updatedAt: FIXED_TIME, metadata: {} });
  const hash = computeTasksetHash(draft);
  const readiness = options.ready ? { schemaVersion: "openpond.tasksetReadiness.v1" as const, tasksetId: draft.id, tasksetHash: hash, ready: true, recommendedMethod: "sft" as const, compatibleDestinationClasses: ["export" as const, "local_cpu_fixture" as const, "custom" as const, "openpond_managed" as const], blockers: [], warnings: [], baselineReportId: "baseline_fixture", generatedAt: FIXED_TIME } : null;
  return TasksetSchema.parse({ ...draft, status: readiness ? "ready" : "needs_review", readiness, contentHash: hash });
}

export function sftRecipeFixture() {
  return SftRecipeSchema.parse({ schemaVersion: "openpond.sftRecipe.v1", method: "sft", parameterization: "lora", baseModel: { id: "openpond/tiny-cpu-gpt2-fixture", revision: "architecture-v1-seed-17", tokenizerRevision: "wordlevel-v1", chatTemplateHash: "fixture00000000" }, dataset: { trainSplit: "train", validationSplit: "frozen_eval", completionOnly: true, maxSequenceLength: 64 }, lora: { rank: 2, alpha: 4, dropout: 0, targetModules: ["c_attn"] }, optimizer: { learningRate: 0.01, epochs: 1, maxSteps: 2, batchSize: 1, gradientAccumulationSteps: 1, seed: 17 }, resourceLimits: { cpuThreads: 2, memoryBytes: 2_000_000_000, wallTimeMs: 120_000 } });
}

export function planFixture(taskset = tasksetFixture({ ready: true }), destinationId: TrainingDestinationId = "local_cpu_fixture"): TrainingPlan {
  const draft = createTrainingPlan({ taskset, destinationId, recipe: sftRecipeFixture(), exportApproved: true });
  const compatibility = { schemaVersion: "openpond.trainingCompatibility.v1" as const, compatible: true, destinationId, tasksetId: taskset.id, recipeMethod: "sft" as const, issues: [], checkedAt: FIXED_TIME };
  return TrainingPlanSchema.parse({ ...draft, compatibility, contentHash: contentHash({ ...draft, compatibility, contentHash: "" }) });
}

export function attemptFixture(input: Partial<TaskAttemptResult> = {}): TaskAttemptResult {
  return TaskAttemptResultSchema.parse({ schemaVersion: "openpond.taskAttempt.v1", id: "attempt_fixture", tasksetId: "taskset_fixture", taskId: "task_eval", split: "frozen_eval", attempt: 0, seed: 0, modelRef: { providerId: "custom-openai-compatible", modelId: "local-fixture" }, startedAt: FIXED_TIME, completedAt: FIXED_TIME, output: { text: "Goodbye friend" }, runtimeEventRefs: [], artifactRefs: [], privilegedOutcomeRef: "outcome_eval", infrastructureError: null, costUsd: 0, latencyMs: 1, userInterventions: 0, metadata: {}, ...input });
}

export function proposalFixture(sourceIds = ["source_train", "source_eval"]) {
  const taskset = tasksetFixture();
  return TaskDesignProposalSchema.parse({ schemaVersion: "openpond.taskDesignProposal.v1", id: "proposal_fixture", name: "Fixture task design", objective: "Reproduce an approved greeting style.", taskKind: "chat", sourceIds, assumptions: ["Selected outputs are approved demonstrations."], successCriteria: ["Match expected response state."], proposedGraders: taskset.graders, graderFixtures: taskset.graderFixtures.map((fixture) => ({ id: fixture.id, taskIndex: 0, label: fixture.label, output: fixture.output, infrastructureError: fixture.infrastructureError, expectedPassed: fixture.expectedPassed, expectedRewardEligible: fixture.expectedRewardEligible, metadata: { ...fixture.metadata, preferFrozenEvaluation: true } })), generatedFiles: [], proposedMethod: "sft", policy: taskset.policy, warnings: [], createdAt: FIXED_TIME });
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
  const turn: Turn = { id: turnId, sessionId, providerTurnId: null, modelRef: { providerId: "openpond", modelId: "openpond-chat" }, prompt: input.prompt ?? "Research this topic and update the product.", startedAt: FIXED_TIME, completedAt: FIXED_TIME, status: "completed", error: null, metadata: {}, createPipelineRequest: null, createPipeline: null };
  const event: RuntimeEvent = { id: `event_${turnId}`, sessionId, turnId, name: "assistant.delta", timestamp: FIXED_TIME, source: "provider", status: "running", output: input.assistant ?? "Completed the research and product update." };
  await store.mutate((data) => { data.sessions.push(session); data.turns.push(turn); data.events.push(event); });
  return { session, turn, event };
}
