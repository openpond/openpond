import { useState } from "react";
import {
  type BaseModelCandidate,
  type BaseModelPreference,
  type ModelRunPreset,
  type RftLossMethod,
  type Taskset,
  type TrainingDestinationCapabilities,
  type TrainingDestinationId,
  type TrainingPreparedStart,
} from "@openpond/contracts";
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
}) {
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
        destination.destinationId === "local_cpu_fixture"
        && destination.available,
    )?.destinationId
    ?? input.destinations.find(
      (destination) =>
        destination.available,
    )?.destinationId
    ?? "local_cpu_fixture";
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
    quickTest && requestedInitialMethod !== "grpo"
      ? 1
      : requestedInitialMethod === "grpo"
        ? input.runPreset === "standard" ? 50 : 8
        : requestedInitialMethod === "dpo"
          ? input.runPreset === "standard" ? 100 : 4
          : requestedInitialMethod === "ppo"
            ? input.runPreset === "standard" ? 20 : 2
            : input.runPreset === "standard" ? 100 : 2
  );
  const [trainingExamples, setTrainingExamples] = useState(() =>
    Math.max(
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
    recommendedSequenceLength(input.taskset)
  );
  const [rank, setRank] = useState(2);
  const [learningRate, setLearningRate] = useState(() =>
    defaultLearningRate(initialCandidate?.preference.modelId ?? "")
  );
  const [exportApproved, setExportApproved] = useState(false);
  const [maximumCostUsd, setMaximumCostUsd] =
    useState<number | null>(null);
  const [retentionDays, setRetentionDays] = useState(7);
  const [rolloutGroupSize, setRolloutGroupSize] = useState(8);
  const [rolloutConcurrency, setRolloutConcurrency] = useState(4);
  const [rolloutMaxOutputTokens, setRolloutMaxOutputTokens] = useState(
    DEFAULT_ROLLOUT_OUTPUT_TOKENS,
  );
  const [rftLossMethod, setRftLossMethod] = useState<RftLossMethod>(() =>
    defaultRftLossMethod(input.taskset)
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
