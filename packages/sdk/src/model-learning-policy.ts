import { LearningDomainError, LearningPolicyContentSchema, type LearningPolicy, type LearningRevisionRef } from "@openpond/evals/learning";
import { contentHash } from "@openpond/harness";

import type { HostedModelProjectSummary } from "./model-projects.js";

/** Shared starting values for both Model clients. Existing policies retain
 * their exact limits; opening settings must never silently increase spending. */
export function hostedLearningPolicyDefaults(project: HostedModelProjectSummary, policy: LearningPolicy | null) {
  const maximumSpend = policy?.limits.maxIterationSpendUsd ?? project.trainingSetup.preferredMaximumSpendUsd ?? 1;
  return {
    enabled: policy?.enabled ?? false,
    scheduled: policy?.trigger.kind === "schedule",
    intervalSeconds: policy?.trigger.kind === "schedule" ? policy.trigger.intervalSeconds : 86_400,
    humanReviewRequired: policy?.admission.mode !== "qualified_automatic",
    minimumApprovedExamples: policy?.admission.minimumApprovedExamples ?? 8,
    maxBatchExamples: policy?.limits.maxBatchExamples ?? 8,
    maxIterationSpendUsd: maximumSpend,
    maxDailySpendUsd: policy?.limits.maxDailySpendUsd ?? maximumSpend,
    cooldownSeconds: policy?.limits.cooldownSeconds ?? 3_600,
    maxRetries: policy?.limits.maxRetries ?? 0,
    maxBacklogExamples: policy?.limits.maxBacklogExamples ?? 1_000,
  };
}

export interface HostedLearningPolicySettings {
  enabled: boolean;
  scheduled: boolean;
  intervalSeconds: number;
  humanReviewRequired: boolean;
  minimumApprovedExamples: number;
  maxBatchExamples: number;
  maxIterationSpendUsd: number;
  maxDailySpendUsd: number;
  cooldownSeconds: number;
  maxRetries: number;
  maxBacklogExamples: number;
}

/** Compile reviewed settings without following mutable Model configuration
 * unless the caller explicitly chooses to apply it. Publication still owns
 * authorization, revision comparison and source/qualification validation. */
export function createHostedLearningPolicyContent(input: {
  project: HostedModelProjectSummary;
  previous: LearningPolicy | null;
  policyId: string;
  applyModelConfiguration: boolean;
  sources: LearningRevisionRef[];
  taskDefinition: LearningRevisionRef;
  settings: HostedLearningPolicySettings;
}) {
  const { project, previous, settings } = input;
  if (previous && (previous.id !== input.policyId || previous.modelProjectId !== project.portableProjectId || previous.executionOwner !== "hosted")) {
    throw new LearningDomainError("learning_policy_model_mismatch", 422, "Learning settings must belong to this hosted Model.");
  }
  const applyModel = input.applyModelConfiguration || !previous;
  const refs = applyModel ? hostedLearningPolicyReferences(project) : null;
  const method = applyModel ? project.trainingSetup.recipe?.method : previous?.training.method;
  if (settings.enabled && !["sft", "grpo", "ppo"].includes(String(method))) {
    throw new LearningDomainError("learning_training_method_unsupported", 422, "Hosted continual learning currently supports SFT, GRPO and PPO.");
  }
  return LearningPolicyContentSchema.parse({
    schemaVersion: "openpond.learningPolicy.v1", id: input.policyId, revision: (previous?.revision ?? 0) + 1,
    modelProjectId: project.portableProjectId, executionOwner: "hosted", enabled: settings.enabled,
    sources: input.sources, taskDefinition: input.taskDefinition,
    rewardBinding: applyModel ? project.trainingSetup.rewardBindingRef : previous?.rewardBinding,
    admission: { mode: settings.humanReviewRequired ? "human" : "qualified_automatic",
      qualification: settings.humanReviewRequired ? null : previous?.admission.qualification ?? null,
      minimumApprovedExamples: settings.minimumApprovedExamples },
    trigger: settings.scheduled ? { kind: "schedule", intervalSeconds: settings.intervalSeconds } : { kind: "manual" },
    trainingParent: refs?.trainingParent ?? previous?.trainingParent,
    teacher: previous?.teacher ?? null,
    training: { method, recipe: refs?.recipe ?? previous?.training.recipe,
      retentionEvaluation: refs?.retentionEvaluation ?? previous?.training.retentionEvaluation,
      replayBatches: previous?.training.replayBatches ?? [] },
    limits: { maxIterationSpendUsd: settings.maxIterationSpendUsd, maxDailySpendUsd: settings.maxDailySpendUsd,
      cooldownSeconds: settings.cooldownSeconds, maxRetries: settings.maxRetries,
      maxBatchExamples: settings.maxBatchExamples, maxBacklogExamples: settings.maxBacklogExamples },
    automation: { collect: false, train: settings.scheduled, accept: false, serve: false },
    acceptance: previous?.acceptance ?? { minimumScore: 0, maximumRetentionRegression: 0, requireImprovement: true, rollbackVersion: null },
  });
}

/** Bind a reviewed hosted Model configuration before asynchronous preparation.
 * Keep the established recipe identity: its id binds the whole Model revision,
 * including Harness and retention selections, while its hash binds the recipe.
 * Callers must obtain the summary from the authenticated Model API. */
export function hostedLearningPolicyReferences(project: HostedModelProjectSummary) {
  const setup = project.trainingSetup;
  const base = setup.baseModel ?? project.defaultBaseModel;
  if (!setup.recipe || !base || !setup.evaluationTasksetRef) {
    throw new LearningDomainError("learning_model_configuration_incomplete", 422,
      "Select a training recipe, starting model and retained evaluation before enabling hosted learning.");
  }
  return {
    recipe: { id: `model-recipe-${project.etag}`, contentHash: contentHash(setup.recipe) },
    trainingParent: { id: base.modelId, contentHash: contentHash(base) },
    retentionEvaluation: { id: setup.evaluationTasksetRef.id, contentHash: setup.evaluationTasksetRef.contentHash },
  };
}
