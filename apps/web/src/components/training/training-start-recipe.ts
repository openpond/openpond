import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  DATASET_EXACT_ANSWER_ENVIRONMENT_ID,
  DATASET_EXACT_ANSWER_ENVIRONMENT_VERSION,
  DATASET_NO_TOOLS_CONTRACT_HASH,
  type BaseModelCandidate,
  type LearnedPreferenceRewardBinding,
  type RftLossMethod,
  type Taskset,
  type TrainingCatalog,
  type TrainingDestinationId,
  type TrainingRecipe,
} from "@openpond/contracts";

export function trainingRecipe(input: {
  method: string;
  taskset: Taskset;
  destinationId: TrainingDestinationId;
  baseModelId: string;
  maxSteps: number;
  sequenceLength: number;
  rank: number;
  learningRate: number;
  klBeta: number | null;
  rolloutGroupSize: number;
  rolloutConcurrency: number;
  rolloutMaxOutputTokens: number;
  trainingExamples: number;
  rftLossMethod?: RftLossMethod;
  executionMode?: TrainingCatalog["targets"][number]["executionMode"];
  catalogModel?: TrainingCatalog["models"][number] | null;
  learnedPreferenceReward?: LearnedPreferenceRewardBinding | null;
}): TrainingRecipe {
  if (
    input.method !== "grpo"
    || input.destinationId !== "openpond_managed"
  ) {
    throw new Error("This Model improvement path requires OpenPond Managed GRPO.");
  }
  const crossSystem =
    input.taskset.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH
    || input.taskset.environment.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH;
  const grader = input.taskset.graders.find((candidate) => candidate.rewardEligible);
  const groupSize = input.rolloutGroupSize;
  const rolloutConcurrency = input.rolloutConcurrency;
  const wallTimeMs = Math.max(
    30 * 60 * 1_000,
    (2 + input.maxSteps * 8) * 60 * 1_000,
  );
  return {
    schemaVersion: "openpond.rftRecipe.v1",
    method: "grpo",
    parameterization: "lora",
    baseModel: providerNativeModelRef(input),
    dataset: {
      trainSplit: "train",
      validationSplit: "frozen_eval",
      maxPromptTokens: 4_096,
      maxExamples: input.trainingExamples,
      selectionStrategy: input.taskset.datasetArtifact
        ? "rft_easy_curriculum_v1"
        : "stable_hash_top_n",
    },
    lora: { rank: 16 },
    rollout: {
      groupSize,
      concurrency: rolloutConcurrency,
      maxTurns: crossSystem ? 15 : 1,
      maxOutputTokens: 512,
      temperature: 0.8,
      topP: 0.95,
      seed: 17,
    },
    optimizer: { learningRate: 0.00001, maxSteps: input.maxSteps },
    loss: {
      method: input.rftLossMethod ?? defaultRftLossMethod(input.taskset),
      klBeta: input.klBeta,
    },
    reward: crossSystem
      ? {
          graderId: "cross-system-exact-verifier",
          graderHash: "server-derived-grader-hash",
          environmentId: "cross-system-operations",
          environmentVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
          toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
          learnedPreference: input.learnedPreferenceReward ?? null,
        }
      : {
          graderId: grader?.id ?? "math_final_answer",
          graderHash: "server-derived-grader-hash",
          environmentId: DATASET_EXACT_ANSWER_ENVIRONMENT_ID,
          environmentVersion: DATASET_EXACT_ANSWER_ENVIRONMENT_VERSION,
          toolContractHash: DATASET_NO_TOOLS_CONTRACT_HASH,
          learnedPreference: input.learnedPreferenceReward ?? null,
        },
    resourceLimits: {
      wallTimeMs,
      maxRollouts: Math.max(groupSize, input.maxSteps * groupSize),
      maxPayloadBytes: 1_000_000,
    },
    policyOptimization: null,
  };
}

export function rolloutTopologyIncompatibility(input: {
  groupSize: number;
  concurrency: number;
}): string | null {
  if (!Number.isInteger(input.groupSize) || input.groupSize < 2 || input.groupSize > 16) {
    return "Rollouts per prompt must be a whole number from 2 through 16.";
  }
  if (
    !Number.isInteger(input.concurrency)
    || input.concurrency < 1
    || input.concurrency > 16
  ) {
    return "Concurrent rollouts must be a whole number from 1 through 16.";
  }
  if (
    input.concurrency > input.groupSize
    || input.groupSize % input.concurrency !== 0
  ) {
    return "Concurrent rollouts must divide the rollout group evenly without exceeding it.";
  }
  return null;
}

export function defaultRftLossMethod(taskset: Taskset): RftLossMethod {
  const dapoSource = taskset.sourceRefs.some((source) => {
    const metadata = source.metadata as Record<string, unknown>;
    const repositoryId = "repositoryId" in source ? String(source.repositoryId) : "";
    return repositoryId.toLowerCase().includes("dapo-math")
      || source.title.toLowerCase().includes("dapo-math")
      || String(metadata.datasetName ?? "").toLowerCase().includes("dapo-math");
  });
  return dapoSource ? "dapo" : "grpo";
}

export function preserveBaseModelSelection(
  candidates: BaseModelCandidate[],
  currentSelectionKey: string,
  destinationId: TrainingDestinationId,
  method: "sft" | "dpo" | "grpo" | "ppo",
): string {
  const current = candidates.find((candidate) => candidate.selectionKey === currentSelectionKey);
  return current?.executionOptions.some(
    (option) => option.destinationId === destinationId && option.methods.includes(method),
  ) ? currentSelectionKey : "";
}

function providerNativeModelRef(input: {
  baseModelId: string;
  catalogModel?: TrainingCatalog["models"][number] | null;
}) {
  return {
    id: input.baseModelId,
    revision: input.catalogModel?.revision ?? "provider-managed-model-resource-v1",
    tokenizerRevision: input.catalogModel?.tokenizerRevision ?? "provider-managed-tokenizer-v1",
    chatTemplateHash: input.catalogModel?.chatTemplateHash ?? "provider-managed-chat-template-v1",
  };
}
