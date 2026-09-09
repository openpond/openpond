import { useState } from "react";
import {
  RftRecipeSchema,
  type BaseModelCandidate,
  type BaseModelPreference,
  type ModelRunPreset,
  type RftLossMethod,
  type Taskset,
  type TrainingDestinationCapabilities,
  type TrainingDestinationId,
  type TrainingPreparedStart,
} from "@openpond/contracts";
import type { TrainingStartDialogProps } from "./training-start-types";
import { recommendedSequenceLength } from "./training-start-defaults";
import { defaultRftLossMethod } from "./training-start-recipe";
import {
  candidateForPreference,
  defaultCandidateForDestination,
  defaultLearningRate,
  selectableMethods,
  tasksetMethod,
  trainingSplitCount,
} from "./training-start-view-helpers";

const DEFAULT_ROLLOUT_OUTPUT_TOKENS = 64;

export function useTrainingStartForm(input: {
  baseModelCandidates: BaseModelCandidate[];
  preferredBaseModel: BaseModelPreference | null;
  destinations: TrainingDestinationCapabilities[];
  taskset: Taskset;
  initialMethod?: "sft" | "dpo" | "grpo" | "ppo";
  runPreset: ModelRunPreset;
  initialRecipe?: TrainingStartDialogProps["initialRecipe"];
  initialApproval?: TrainingStartDialogProps["initialApproval"];
}) {
  const [saved] = useState(() => {
    if (!input.initialRecipe || input.initialMethod !== "grpo") return { recipe: null, error: null };
    const parsed = RftRecipeSchema.safeParse(input.initialRecipe);
    return parsed.success ? { recipe: parsed.data, error: null }
      : { recipe: null, error: "The saved training recipe is invalid. Review its configuration before running." };
  });
  const savedRecipe = saved.recipe;
  const trainingPath = input.taskset.readiness?.trainingPath ?? null;
  const primaryMethod =
    trainingPath?.primaryMethod ?? tasksetMethod(input.taskset);
  const bootstrap = trainingPath?.bootstrap ?? null;
  const methodOptions = selectableMethods(input.taskset);
  const requestedInitialMethod =
    input.initialMethod && methodOptions.includes(input.initialMethod)
      ? input.initialMethod
      : primaryMethod === "grpo"
        ? "grpo"
        : primaryMethod === "dpo"
          ? "dpo"
          : primaryMethod === "ppo"
            ? "ppo"
            : "sft";
  const quickTest =
    input.runPreset === "small"
    || input.runPreset === "small_experiment";
  const preferredCandidate = candidateForPreference(
    input.baseModelCandidates,
    input.preferredBaseModel,
  );
  const preferredOption =
    preferredCandidate?.executionOptions.find(
      (option) =>
        option.available
        && option.methods.includes(requestedInitialMethod),
    ) ?? null;
  const initialDestination =
    preferredOption?.destinationId
    ?? input.destinations.find(
      (destination) =>
        destination.available,
    )?.destinationId
    ?? "openpond_managed";
  const initialCandidate = preferredOption
    ? preferredCandidate
    : defaultCandidateForDestination(
        input.baseModelCandidates,
        initialDestination,
        requestedInitialMethod,
      );
  const availableTrainExamples = trainingSplitCount(
    input.taskset,
    "train",
  );
  const [destinationId, setDestinationId] =
    useState<TrainingDestinationId>(initialDestination);
  const [baseModelKey, setBaseModelKey] = useState(
    initialCandidate?.selectionKey ?? "",
  );
  const [maxSteps, setMaxSteps] = useState(() =>
    savedRecipe?.optimizer.maxSteps ?? (quickTest && requestedInitialMethod !== "grpo"
      ? 1
      : requestedInitialMethod === "grpo"
        ? input.runPreset === "standard" ? 50 : 8
        : requestedInitialMethod === "dpo"
          ? input.runPreset === "standard" ? 100 : 4
          : requestedInitialMethod === "ppo"
            ? input.runPreset === "standard" ? 20 : 2
            : input.runPreset === "standard" ? 100 : 2)
  );
  const [trainingExamples, setTrainingExamples] = useState(() =>
    savedRecipe?.dataset.maxExamples ?? Math.max(
      1,
      Math.min(
        availableTrainExamples,
        requestedInitialMethod === "dpo"
          ? quickTest
            ? 2
            : input.taskset.learningSignals.preferences.filter(
                (pair) => pair.approved,
              ).length
          : requestedInitialMethod === "ppo"
            ? quickTest
              ? 2
              : input.runPreset === "standard" ? 16 : 4
            : requestedInitialMethod === "grpo"
                && input.taskset.datasetArtifact
              ? input.runPreset === "standard" ? 32 : 16
              : quickTest ? 4 : 1_000,
      ),
    )
  );
  const [sequenceLength, setSequenceLength] = useState(() =>
    savedRecipe?.dataset.maxPromptTokens ?? recommendedSequenceLength(input.taskset)
  );
  const [rank, setRank] = useState(savedRecipe?.lora.rank ?? 2);
  const [learningRate, setLearningRate] = useState(() =>
    savedRecipe?.optimizer.learningRate ?? defaultLearningRate(initialCandidate?.preference.modelId ?? "")
  );
  const [klBeta, setKlBeta] = useState<number | null>(savedRecipe ? savedRecipe.loss.klBeta : 0.01);
  const [exportApproved, setExportApproved] = useState(false);
  const [maximumCostUsd, setMaximumCostUsd] =
    useState<number | null>(input.initialApproval?.maximumCostUsd ?? null);
  const [retentionDays, setRetentionDays] = useState(input.initialApproval?.retentionDays ?? 7);
  const [rolloutGroupSize, setRolloutGroupSize] = useState(savedRecipe?.rollout.groupSize ?? 8);
  const [rolloutConcurrency, setRolloutConcurrency] = useState(savedRecipe?.rollout.concurrency ?? 4);
  const [rolloutMaxOutputTokens, setRolloutMaxOutputTokens] = useState(
    savedRecipe?.rollout.maxOutputTokens ?? DEFAULT_ROLLOUT_OUTPUT_TOKENS,
  );
  const [rftLossMethod, setRftLossMethod] = useState<RftLossMethod>(() =>
    savedRecipe?.loss.method ?? defaultRftLossMethod(input.taskset)
  );
  const [method, setMethod] = useState<
    "sft" | "dpo" | "grpo" | "ppo"
  >(requestedInitialMethod);
  const [prepared, setPrepared] = useState<{
    configurationKey: string;
    value: TrainingPreparedStart;
  } | null>(null);
  const [providerApprovalOpen, setProviderApprovalOpen] = useState(false);

  return {
    savedRecipe,
    savedRecipeError: saved.error,
    primaryMethod,
    bootstrap,
    methodOptions,
    quickTest,
    initialDestination,
    availableTrainExamples,
    destinationId,
    setDestinationId,
    baseModelKey,
    setBaseModelKey,
    maxSteps,
    setMaxSteps,
    trainingExamples,
    setTrainingExamples,
    sequenceLength,
    setSequenceLength,
    rank,
    setRank,
    learningRate,
    setLearningRate,
    klBeta,
    setKlBeta,
    exportApproved,
    setExportApproved,
    maximumCostUsd,
    setMaximumCostUsd,
    retentionDays,
    setRetentionDays,
    rolloutGroupSize,
    setRolloutGroupSize,
    rolloutConcurrency,
    setRolloutConcurrency,
    rolloutMaxOutputTokens,
    setRolloutMaxOutputTokens,
    rftLossMethod,
    setRftLossMethod,
    method,
    setMethod,
    prepared,
    setPrepared,
    providerApprovalOpen,
    setProviderApprovalOpen,
  };
}
