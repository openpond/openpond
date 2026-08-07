import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  RftRecipeSchema,
  TasksetSchema,
  type RftRecipe,
} from "../../packages/contracts/src";
import { computeTasksetHash } from "../../packages/taskset-sdk/src";
import {
  generateCrossSystemTasks,
  generateCrossSystemWorld,
} from "../../apps/server/src/training/cross-system-operations/world-generator";
import { tasksetFixture } from "./training-fixtures";

export function rftTasksetFixture() {
  const base = tasksetFixture({ ready: true });
  const worldSpecs = [
    { seed: 101, split: "train" as const, difficulty: "easy" as const },
    { seed: 202, split: "frozen_eval" as const, difficulty: "easy" as const },
  ];
  const generatedTasks = worldSpecs.flatMap((spec) =>
    generateCrossSystemTasks(generateCrossSystemWorld(spec)).filter(
      (task) => task.phrasingVariant === 0,
    ),
  );
  const selectedTasks = [
    generatedTasks.find((task) => task.split === "train")!,
    generatedTasks.find((task) => task.split === "frozen_eval")!,
  ];
  const tasks = selectedTasks.map((task, index) => ({
    ...base.tasks[index]!,
    id: `authored_${task.id}`,
    clusterKey: task.clusterKey,
    split: task.split,
    input: { prompt: task.prompt },
    expectedOutput: { text: `ANSWER: ${JSON.stringify(task.expectedAnswer)}` },
    privilegedContextRef: `private_${task.id}`,
    tags: ["cross-system-operations"],
    metadata: { taskId: task.id, family: task.family, worldId: task.worldId },
  }));
  const draft = TasksetSchema.parse({
    ...base,
    status: "needs_review",
    readiness: null,
    capabilities: {
      ...base.capabilities,
      taskKind: "single_agent",
      supportedSignals: ["reward"],
      compatibleMethods: ["grpo"],
      rewardKinds: ["deterministic"],
      requiresTools: true,
      requiresState: true,
      environmentPlacements: ["local", "remote"],
    },
    environment: {
      ...base.environment,
      kind: "stateful_harness",
      stateful: true,
      toolNames: ["search_crm", "query_billing", "search_support", "run_python"],
      metadata: {
        flagship: "cross-system-operations",
        toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      },
    },
    tasks,
    graderFixtures: base.graderFixtures.map((fixture) => ({
      ...fixture,
      taskId: tasks[1]!.id,
      output: fixture.expectedPassed ? { text: tasks[1]!.expectedOutput!.text } : fixture.output,
    })),
    learningSignals: {
      demonstrations: [],
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: [
        {
          id: "reward_train",
          kind: "reward",
          taskId: tasks[0]!.id,
          task: tasks[0]!.input.prompt,
          rules: [{ id: "reward_train_exact", points: 1, condition: "Return the exact answer." }],
          otherwisePoints: 0,
          executable: true,
          sourceRefs: [base.sourceRefs[0]!.id],
          artifactRef: "private_deterministic_grader",
          approved: true,
          confidence: 1,
          metadata: {},
        },
      ],
      labels: [],
    },
    metadata: { ...base.metadata, flagship: "cross-system-operations", trainingMethod: "grpo", worldSpecs },
    contentHash: "00000000",
  });
  const hash = computeTasksetHash(draft);
  return TasksetSchema.parse({
    ...draft,
    status: "ready",
    readiness: {
      schemaVersion: "openpond.tasksetReadiness.v1",
      tasksetId: draft.id,
      tasksetHash: hash,
      ready: true,
      recommendedMethod: "grpo",
      trainingPath: { primaryMethod: "grpo", bootstrap: null },
      compatibleDestinationClasses: ["hosted_managed"],
      blockers: [],
      warnings: [],
      baselineReward: { count: 4, mean: 0.5, min: 0, max: 1, variance: 0.25 },
      generatedAt: "2026-07-17T00:00:00.000Z",
    },
    contentHash: hash,
  });
}

export function managedRftRecipe(): RftRecipe {
  return RftRecipeSchema.parse({
    schemaVersion: "openpond.rftRecipe.v1",
    method: "grpo",
    parameterization: "lora",
    baseModel: {
      id: "Qwen/Qwen3-0.6B",
      revision: "c1899de289a04d12100db370d81485cdf75e47ca",
      tokenizerRevision: "c1899de289a04d12100db370d81485cdf75e47ca",
      chatTemplateHash: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
    },
    dataset: { trainSplit: "train", validationSplit: "frozen_eval", maxPromptTokens: 1024 },
    lora: { rank: 16 },
    rollout: {
      groupSize: 4,
      concurrency: 4,
      maxTurns: 15,
      maxOutputTokens: 512,
      temperature: 0.8,
      topP: 0.95,
      seed: 17,
    },
    optimizer: { learningRate: 0.00001, maxSteps: 2 },
    loss: { method: "grpo", klBeta: null },
    reward: {
      graderId: "expected_output",
      graderHash: "graderhash00000000",
      environmentId: "cross-system-operations",
      environmentVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
      toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
    },
    resourceLimits: { wallTimeMs: 1_800_000, maxRollouts: 8, maxPayloadBytes: 1_000_000 },
  });
}
