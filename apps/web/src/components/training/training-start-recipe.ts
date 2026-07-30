import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  DATASET_EXACT_ANSWER_ENVIRONMENT_ID,
  DATASET_EXACT_ANSWER_ENVIRONMENT_VERSION,
  DATASET_NO_TOOLS_CONTRACT_HASH,
  type BaseModelCandidate,
  type ModelAsset,
  type RftLossMethod,
  type Taskset,
  type TrainingCatalog,
  type TrainingDestinationId,
  type TrainingRecipe,
} from "@openpond/contracts";

const SMOLLM2_LORA_TARGET_MODULES = [
  "q_proj",
  "k_proj",
  "v_proj",
  "o_proj",
  "gate_proj",
  "up_proj",
  "down_proj",
];

export function trainingRecipe(input: {
  method: string;
  taskset: Taskset;
  destinationId: TrainingDestinationId;
  baseModelId: string;
  maxSteps: number;
  sequenceLength: number;
  rank: number;
  learningRate: number;
  model: ModelAsset | null;
  rolloutGroupSize: number;
  rolloutConcurrency: number;
  rolloutMaxOutputTokens: number;
  trainingExamples: number;
  rftLossMethod?: RftLossMethod;
  executionMode?: TrainingCatalog["targets"][number]["executionMode"];
  catalogModel?: TrainingCatalog["models"][number] | null;
}): TrainingRecipe {
  if (input.method === "grpo" && input.executionMode === "provider_native") {
    const managed = input.destinationId === "openpond_managed";
    const maxSteps = input.maxSteps;
    const rolloutGroupSize = managed ? 4 : input.rolloutGroupSize;
    const crossSystem =
      input.taskset.metadata.toolContractHash ===
        CROSS_SYSTEM_TOOL_CONTRACT_HASH ||
      input.taskset.environment.metadata.toolContractHash ===
        CROSS_SYSTEM_TOOL_CONTRACT_HASH;
    const grader = input.taskset.graders.find(
      (candidate) => candidate.rewardEligible
    );
    return {
      schemaVersion: "openpond.rftRecipe.v1",
      method: "grpo",
      parameterization: "lora",
      baseModel: providerNativeModelRef(input),
      dataset: {
        trainSplit: "train",
        validationSplit: "frozen_eval",
        maxPromptTokens: managed ? 4_096 : input.sequenceLength,
        maxExamples: input.trainingExamples,
        selectionStrategy: input.taskset.datasetArtifact
          ? "rft_easy_curriculum_v1"
          : "stable_hash_top_n",
      },
      lora: { rank: managed ? 16 : input.rank },
      rollout: {
        groupSize: rolloutGroupSize,
        concurrency: managed ? 4 : input.rolloutConcurrency,
        maxTurns: crossSystem ? 15 : 1,
        maxOutputTokens: managed ? 512 : input.rolloutMaxOutputTokens,
        temperature: 0.8,
        topP: 0.95,
        seed: 17,
      },
      optimizer: {
        learningRate: managed ? 0.00001 : input.learningRate,
        maxSteps,
      },
      loss: {
        method: input.rftLossMethod ?? defaultRftLossMethod(input.taskset),
        klBeta: null,
      },
      reward: crossSystem
        ? {
            graderId: "cross-system-exact-verifier",
            graderHash: "server-derived-grader-hash",
            environmentId: "cross-system-operations",
            environmentVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
            toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
          }
        : {
            graderId: grader?.id ?? "math_final_answer",
            graderHash: "server-derived-grader-hash",
            environmentId: DATASET_EXACT_ANSWER_ENVIRONMENT_ID,
            environmentVersion: DATASET_EXACT_ANSWER_ENVIRONMENT_VERSION,
            toolContractHash: DATASET_NO_TOOLS_CONTRACT_HASH,
          },
      resourceLimits: {
        wallTimeMs: managed ? 1_800_000 : 180_000,
        maxRollouts: Math.max(
          rolloutGroupSize,
          managed
            ? maxSteps * rolloutGroupSize
            : input.trainingExamples * rolloutGroupSize
        ),
        maxPayloadBytes: 1_000_000,
      },
      policyOptimization: null,
    };
  }
  if (input.method === "ppo" && input.destinationId === "local_cpu_fixture") {
    const policyModel = localPolicyModel(input.model);
    const valueModel = {
      ...policyModel,
      id: `${policyModel.id}:value-head-v1`,
    };
    const maxRollouts = Math.max(input.maxSteps, input.trainingExamples);
    const maximumOutputPerRollout = Math.max(
      1,
      Math.min(64, input.rolloutMaxOutputTokens)
    );
    const metadataToolContractHash =
      input.taskset.environment.metadata.toolContractHash;
    const toolContractHash =
      typeof metadataToolContractHash === "string"
        ? metadataToolContractHash
        : DATASET_NO_TOOLS_CONTRACT_HASH;
    return {
      schemaVersion: "openpond.ppoRecipe.v1",
      method: "ppo",
      parameterization: "lora",
      policyOptimization: {
        schemaVersion: "openpond.policyOptimization.v1",
        policyModel,
        referenceModel: { ...policyModel },
        dataset: {
          tasksetId: input.taskset.id,
          tasksetHash: input.taskset.contentHash,
          split: "train",
          selectionStrategy: "stable_hash_top_n",
          selectionSeed: 17,
          maxExamples: input.trainingExamples,
        },
        sampler: {
          temperature: 0.8,
          topP: 0.95,
          maxOutputTokens: maximumOutputPerRollout,
          maxTurns: 1,
          concurrency: 1,
        },
        environment: {
          id: input.taskset.environment.entrypoint.slice(0, 240),
          version: input.taskset.environment.protocolVersion,
          toolContractHash,
        },
        reward: {
          graderId: "openpond.deterministic_token_match.v1",
          graderHash: "server-authoritative-grader-hash",
        },
        kl: {
          coefficient: 0.05,
          referenceConstraint: "fixed_reference",
        },
        budgets: {
          maxRollouts,
          maxEnvironmentExecutions: maxRollouts,
          maxInputTokens: maxRollouts * Math.max(16, input.sequenceLength),
          maxOutputTokens: maxRollouts * maximumOutputPerRollout,
          maxOptimizerSteps: input.maxSteps,
          wallTimeMs: input.model ? 900_000 : 120_000,
          maximumCostUsd: 0,
        },
        checkpointEverySteps: 1,
        seed: 17,
        evaluationSplit: "frozen_eval",
        optimizer: {
          method: "ppo",
          valueModel,
          gamma: 1,
          gaeLambda: 0.95,
          policyClip: 0.2,
          valueClip: 0.2,
          valueLossCoefficient: 0.5,
          ppoEpochs: 2,
          minibatchSize: 1,
        },
      },
      lora: lora(input),
      valueHead: {
        initialization: "policy_hidden_state_linear",
        optimizerLearningRate: input.learningRate,
        artifactName: "value_head.safetensors",
      },
      policyLearningRate: input.learningRate,
      resume: {
        checkpointId: null,
        policyHash: "server-authoritative-policy-hash",
        referenceHash: "server-authoritative-reference-hash",
        valueModelHash: "server-authoritative-value-hash",
        optimizerStateHash: null,
      },
      resourceLimits: localResourceLimits(input.model),
    };
  }
  if (input.method === "dpo" && input.destinationId === "local_cpu_fixture") {
    const policyModel = localPolicyModel(input.model);
    return {
      schemaVersion: "openpond.dpoRecipe.v1",
      method: "dpo",
      parameterization: "lora",
      policyModel,
      referenceModel: { ...policyModel },
      dataset: {
        trainSplit: "train",
        validationSplit: "frozen_eval",
        maxPairs: input.trainingExamples,
        maxPromptTokens: Math.max(16, Math.floor(input.sequenceLength / 2)),
        maxCompletionTokens: Math.max(16, Math.ceil(input.sequenceLength / 2)),
        selectionStrategy: "stable_hash_top_n",
        selectionSeed: 17,
      },
      lora: lora(input),
      loss: {
        variant: "sigmoid",
        beta: 0.1,
        labelSmoothing: 0,
      },
      optimizer: optimizer(input),
      referenceLogprobs: {
        cacheSchemaVersion: "openpond.dpoReferenceLogprobs.v1",
        cacheKey: "server-authoritative-cache-key",
        invalidationHash: "server-authoritative-invalidation-hash",
      },
      resourceLimits: localResourceLimits(input.model),
    };
  }
  if (input.executionMode === "provider_native") {
    return {
      schemaVersion: "openpond.sftRecipe.v1",
      method: "sft",
      parameterization: "lora",
      baseModel: providerNativeModelRef(input),
      dataset: sftDataset(input),
      lora: {
        rank: input.rank,
        alpha: input.rank * 2,
        dropout: 0.05,
        targetModules: SMOLLM2_LORA_TARGET_MODULES,
      },
      optimizer: optimizer(input),
      resourceLimits: {
        cpuThreads: 1,
        memoryBytes: 1_000_000_000,
        wallTimeMs: 3_600_000,
      },
    };
  }
  if (
    !input.model?.modelId ||
    !input.model.revision ||
    !input.model.tokenizerRevision ||
    !input.model.chatTemplateHash
  ) {
    return {
      schemaVersion: "openpond.sftRecipe.v1",
      method: "sft",
      parameterization: "lora",
      baseModel: localPolicyModel(null),
      dataset: sftDataset(input),
      lora: {
        rank: input.rank,
        alpha: input.rank * 2,
        dropout: 0,
        targetModules: ["c_attn"],
      },
      optimizer: optimizer(input),
      resourceLimits: localResourceLimits(null),
    };
  }
  return {
    schemaVersion: "openpond.sftRecipe.v1",
    method: "sft",
    parameterization: "lora",
    baseModel: localPolicyModel(input.model),
    dataset: sftDataset(input),
    lora: lora(input),
    optimizer: optimizer(input),
    resourceLimits: localResourceLimits(input.model),
  };
}

export function defaultRftLossMethod(taskset: Taskset): RftLossMethod {
  const dapoSource = taskset.sourceRefs.some((source) => {
    const metadata = source.metadata as Record<string, unknown>;
    const repositoryId =
      "repositoryId" in source ? String(source.repositoryId) : "";
    return (
      repositoryId.toLowerCase().includes("dapo-math") ||
      source.title.toLowerCase().includes("dapo-math") ||
      String(metadata.datasetName ?? "")
        .toLowerCase()
        .includes("dapo-math")
    );
  });
  return dapoSource ? "dapo" : "grpo";
}

export function preserveBaseModelSelection(
  candidates: BaseModelCandidate[],
  currentSelectionKey: string,
  destinationId: TrainingDestinationId,
  method: "sft" | "dpo" | "grpo" | "ppo"
): string {
  const current = candidates.find(
    (candidate) => candidate.selectionKey === currentSelectionKey
  );
  return current?.executionOptions.some(
    (option) =>
      option.destinationId === destinationId && option.methods.includes(method)
  )
    ? currentSelectionKey
    : "";
}

function providerNativeModelRef(input: {
  baseModelId: string;
  catalogModel?: TrainingCatalog["models"][number] | null;
}) {
  return {
    id: input.baseModelId,
    revision:
      input.catalogModel?.revision ?? "provider-managed-model-resource-v1",
    tokenizerRevision:
      input.catalogModel?.tokenizerRevision ?? "provider-managed-tokenizer-v1",
    chatTemplateHash:
      input.catalogModel?.chatTemplateHash ??
      "provider-managed-chat-template-v1",
  };
}

function localPolicyModel(model: ModelAsset | null) {
  return model?.modelId &&
    model.revision &&
    model.tokenizerRevision &&
    model.chatTemplateHash
    ? {
        id: model.modelId,
        revision: model.revision,
        tokenizerRevision: model.tokenizerRevision,
        chatTemplateHash: model.chatTemplateHash,
      }
    : {
        id: "openpond/tiny-cpu-gpt2-fixture",
        revision: "architecture-v2-seed-17-context-512",
        tokenizerRevision: "wordlevel-v1",
        chatTemplateHash: "fixture00000000",
      };
}

function sftDataset(input: {
  sequenceLength: number;
  trainingExamples: number;
}) {
  return {
    trainSplit: "train" as const,
    validationSplit: "frozen_eval" as const,
    completionOnly: true,
    maxSequenceLength: input.sequenceLength,
    maxExamples: input.trainingExamples,
    selectionStrategy: "stable_hash_top_n" as const,
    selectionSeed: 17,
  };
}

function lora(input: { rank: number; model: ModelAsset | null }) {
  return {
    rank: input.rank,
    alpha: input.rank * 2,
    dropout: input.model ? 0.05 : 0,
    targetModules: input.model ? SMOLLM2_LORA_TARGET_MODULES : ["c_attn"],
  };
}

function optimizer(input: { learningRate: number; maxSteps: number }) {
  return {
    learningRate: input.learningRate,
    epochs: 1,
    maxSteps: input.maxSteps,
    batchSize: 1,
    gradientAccumulationSteps: 1,
    seed: 17,
  };
}

function localResourceLimits(model: ModelAsset | null) {
  return {
    cpuThreads: 4,
    memoryBytes: model ? 8_000_000_000 : 2_000_000_000,
    wallTimeMs: model ? 900_000 : 120_000,
  };
}
