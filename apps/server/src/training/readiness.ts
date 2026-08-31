import {
  TasksetReadinessReportSchema,
  type GraderAuditReport,
  type Taskset,
  type TasksetReadinessReport,
} from "@openpond/contracts";
import { contentHash, validateTaskset } from "@openpond/taskset-sdk";

export function buildTasksetReadiness(input: {
  taskset: Taskset;
  graderAudit?: GraderAuditReport | null;
  generatedAt?: string;
}): TasksetReadinessReport {
  const validation = validateTaskset(input.taskset);
  const blockers = validation.issues.filter((issue) => issue.severity === "error").map((issue) => ({ code: issue.code, message: issue.message, path: issue.path }));
  const advisories: TasksetReadinessReport["advisories"] = [];
  const authoredMethod = typeof input.taskset.metadata.trainingMethod === "string"
    ? input.taskset.metadata.trainingMethod
    : null;
  const authoredTrainingMethod = trainingPathMethod(authoredMethod);
  const requiresApprovedDemonstrations = authoredTrainingMethod === "sft";
  const requiresPreferencePairs = authoredTrainingMethod === "dpo";
  const requiresOnlineReward = authoredTrainingMethod === "grpo" || authoredTrainingMethod === "ppo";
  const approvedDemonstrationTaskIds = new Set(input.taskset.learningSignals.demonstrations.filter((signal) => signal.approved && signal.taskId).map((signal) => signal.taskId!));
  const artifact = input.taskset.datasetArtifact;
  const approvedArtifactSignals = new Set(
    metadataStrings(input.taskset.metadata.approvedArtifactSignals),
  );
  const artifactHasExpectedOutput = Boolean(
    artifact?.schema.fields.some((field) =>
      field.semanticRole === "demonstration"
      || field.semanticRole === "expected_output"
      || field.semanticRole === "chosen"),
  );
  const allTrainTasks = input.taskset.tasks.filter((task) => task.split === "train" && (task.expectedOutput || requiresOnlineReward));
  const trainTasks = requiresApprovedDemonstrations
    ? allTrainTasks.filter((task) => approvedDemonstrationTaskIds.has(task.id))
    : allTrainTasks;
  const unapprovedTrainTasks = input.taskset.tasks.filter((task) => task.split === "train" && task.expectedOutput && !approvedDemonstrationTaskIds.has(task.id));
  const frozenTasks = input.taskset.tasks.filter(
    (task) =>
      task.split === "frozen_eval" &&
      (task.expectedOutput || requiresOnlineReward),
  );
  const artifactTrainCount = artifact && artifactHasExpectedOutput
    ? artifact.splitCounts.train ?? 0
    : 0;
  const artifactFrozenCount = artifact && artifactHasExpectedOutput
    ? artifact.splitCounts.frozen_eval ?? 0
    : 0;
  const artifactSignalApproved = artifact
    ? approvedArtifactSignals.has(authoredTrainingMethod ?? "")
    : false;
  const baseTrainTaskCount = artifact
    ? artifactSignalApproved ? artifactTrainCount : 0
    : trainTasks.length;
  const approvedPreferenceCount = input.taskset.learningSignals.preferences.filter((signal) => signal.approved).length;
  const executableRewardCount = input.taskset.learningSignals.rewards.filter((signal) => signal.approved && signal.executable).length;
  const trainTaskCount = requiresPreferencePairs
    ? approvedPreferenceCount
    : requiresOnlineReward
      ? executableRewardCount ? baseTrainTaskCount : 0
      : baseTrainTaskCount;
  const frozenTaskCount = artifact ? artifactFrozenCount : frozenTasks.length;
  if (trainTaskCount === 0) {
    blockers.push(
      requiresApprovedDemonstrations
        ? { code: "sft_demonstrations_missing", message: "At least one explicitly approved training demonstration is required.", path: "learningSignals.demonstrations" }
        : requiresPreferencePairs
          ? { code: "dpo_preferences_missing", message: "At least one approved chosen/rejected response pair is required for DPO.", path: "learningSignals.preferences" }
          : { code: "online_reward_missing", message: `${authoredTrainingMethod?.toUpperCase() ?? "Online training"} requires an executable reward-bearing task.`, path: "learningSignals.rewards" },
    );
  }
  const unapprovedTrainCount = artifact
    ? requiresApprovedDemonstrations && !artifactSignalApproved
      ? artifactTrainCount
      : 0
    : unapprovedTrainTasks.length;
  if (requiresApprovedDemonstrations && unapprovedTrainCount) blockers.push({ code: "sft_demonstrations_unapproved", message: `${unapprovedTrainCount} training example${unapprovedTrainCount === 1 ? " is" : "s are"} not explicitly approved.`, path: artifact ? "metadata.approvedArtifactSignals" : "learningSignals.demonstrations" });
  if (frozenTaskCount === 0) advisories.push({ code: "frozen_eval_missing", message: "At least one independent evaluation example is recommended before making quality claims.", path: artifact ? "datasetArtifact.splitCounts.frozen_eval" : "tasks" });
  const trainClusters = new Set(trainTasks.map((task) => task.clusterKey));
  const frozenClusters = new Set(frozenTasks.map((task) => task.clusterKey));
  const artifactSplitIsolation =
    artifact && input.taskset.metadata.splitIsolationVerified === true;
  if (
    artifact
      ? !artifactSplitIsolation || trainTaskCount === 0 || frozenTaskCount === 0
      : trainClusters.size === 0 || frozenClusters.size === 0 || [...trainClusters].some((cluster) => frozenClusters.has(cluster))
  ) advisories.push({ code: "independent_evaluation_missing", message: "Independent source clusters are recommended before using evaluation results for quality claims.", path: artifact ? "metadata.splitIsolationVerified" : "tasks" });
  if (
    artifact
      ? input.taskset.metadata.artifactRowsVerified !== true
      : input.taskset.tasks.some((task) => typeof task.metadata.exampleOrigin !== "string")
  ) blockers.push({ code: "example_provenance_missing", message: "Every training and evaluation example must record whether it was extracted, corrected, synthetic, or expert-authored.", path: artifact ? "metadata.artifactRowsVerified" : "tasks.metadata.exampleOrigin" });
  const diagnosis = metadataRecord(input.taskset.metadata.diagnosis);
  if (!diagnosis || typeof diagnosis.summary !== "string" || !Array.isArray(diagnosis.stableBehavior)) advisories.push({ code: "capability_diagnosis_missing", message: "A capability diagnosis is recommended to separate stable behavior from changing knowledge.", path: "metadata.diagnosis" });
  if (diagnosis?.trainingEligible === false) advisories.push({ code: "training_not_recommended", message: "The capability diagnosis does not recommend storing this behavior in model weights.", path: "metadata.diagnosis.trainingEligible" });
  const graderAuditRequired = input.taskset.graders.some((grader) =>
    grader.rewardEligible
    && (
      grader.kind !== "model_judge"
      || grader.metadata.calibrationIsAdvisory !== true
    ),
  );
  if (graderAuditRequired && !input.graderAudit) advisories.push({ code: "grader_audit_missing", message: "Optional grader calibration evidence has not been recorded.", path: "graderFixtures" });
  if (graderAuditRequired && input.graderAudit && input.graderAudit.tasksetHash !== input.taskset.contentHash) advisories.push({ code: "grader_audit_stale", message: "Optional grader calibration evidence predates this immutable Taskset revision.", path: "graderFixtures" });
  if (graderAuditRequired && input.graderAudit && !input.graderAudit.passed) advisories.push({ code: "grader_audit_failed", message: "The grader did not match every optional calibration fixture's expected outcome.", path: "graderFixtures" });
  if (graderAuditRequired && input.graderAudit && !input.graderAudit.hackingChecksPassed) advisories.push({ code: "grader_adversarial_calibration_failed", message: "Adversarial or prompt-injection calibration fixtures did not match their expected grader outcomes.", path: "graders" });
  if (graderAuditRequired && input.graderAudit && !input.graderAudit.leakageChecksPassed) blockers.push({ code: "environment_leakage", message: "Environment or privileged-state leakage checks failed.", path: "environment" });
  if (graderAuditRequired && input.graderAudit && !input.graderAudit.infrastructureSafetyPassed) blockers.push({ code: "infrastructure_reward", message: "An infrastructure failure produced a score or eligible reward.", path: "graderFixtures" });
  const hasRewardEligibleGrader = input.taskset.graders.some(
    (grader) => grader.rewardEligible,
  );
  if (requiresOnlineReward && !hasRewardEligibleGrader) blockers.push({ code: "online_reward_grader_missing", message: `${authoredTrainingMethod?.toUpperCase()} requires a user-selected reward-eligible grader.`, path: "graders" });
  const recommendedMethod = authoredTrainingMethod
    ?? (trainTaskCount > 0 && input.taskset.capabilities.compatibleMethods.includes("sft") ? "sft" : "none");
  const demonstrationRefs = input.taskset.learningSignals.demonstrations.filter((signal) => signal.approved).map((signal) => signal.id);
  const trainingPath = recommendedMethod === "none" ? null : {
    primaryMethod: recommendedMethod,
    bootstrap: recommendedMethod === "grpo" && demonstrationRefs.length ? {
      method: "sft" as const,
      purpose: "trajectory_bootstrap" as const,
      demonstrationRefs,
      limitations: [
        "The SFT bootstrap imitates approved trajectories; it does not optimize verifier reward.",
        "Completing the bootstrap does not satisfy the primary GRPO recommendation.",
      ],
    } : null,
  };
  const ready = blockers.length === 0;
  const globalMethodReason = blockers.length > 0;
  const methodReadiness = (["sft", "dpo", "grpo", "ppo"] as const).map((method) => {
    const reasonCodes: Array<
      "taskset_not_ready"
      | "demonstrations_missing"
      | "preference_pairs_missing"
      | "executable_reward_missing"
      | "value_model_required"
      | "frozen_eval_missing"
    > = [];
    const reasons: string[] = [];
    if (method === "sft" && demonstrationRefs.length === 0) {
      reasonCodes.push("demonstrations_missing");
      reasons.push("Add at least one approved prompt/response demonstration.");
    }
    if (method === "dpo" && approvedPreferenceCount === 0) {
      reasonCodes.push("preference_pairs_missing");
      reasons.push("Add at least one approved chosen/rejected response pair.");
    }
    if ((method === "grpo" || method === "ppo") && executableRewardCount === 0) {
      reasonCodes.push("executable_reward_missing");
      reasons.push("Implement and validate an executable scalar reward.");
    }
    if (method === "ppo") {
      reasonCodes.push("value_model_required");
      reasons.push("Choose and bind a value/critic model before PPO can execute.");
    }
    if (frozenTaskCount === 0) {
      reasonCodes.push("frozen_eval_missing");
      reasons.push("Add an independent frozen-evaluation split.");
    }
    if (globalMethodReason && reasonCodes.length === 0) {
      reasonCodes.push("taskset_not_ready");
      reasons.push("Resolve the Dataset validation and grader-audit blockers.");
    }
    const datasetBlockingReasons = reasonCodes.filter((code) =>
      code !== "value_model_required");
    return {
      method,
      status: datasetBlockingReasons.length
        ? "needs_dataset_work" as const
        : method === recommendedMethod
          ? "recommended" as const
          : "compatible" as const,
      reasonCodes,
      reasons,
    };
  });
  return TasksetReadinessReportSchema.parse({
    schemaVersion: "openpond.tasksetReadiness.v1",
    tasksetId: input.taskset.id,
    tasksetHash: input.taskset.contentHash,
    ready,
    recommendedMethod,
    trainingPath,
    methodReadiness,
    compatibleDestinationClasses: ready
      ? recommendedMethod === "grpo"
        ? ["export", "custom", "hosted_managed"]
        : ["export", "custom"]
      : ["export"],
    blockers,
    advisories,
    warnings: [
      ...validation.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
      ...(recommendedMethod === "grpo" ? ["GRPO is readiness-compatible but not executable in the local CPU fixture."] : []),
      ...metadataStrings(input.taskset.metadata.warnings),
    ],
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    metadata: { reportHash: contentHash([input.taskset.contentHash, blockers]) },
  });
}

function trainingPathMethod(value: string | null): "sft" | "dpo" | "grpo" | "ppo" | "sdft" | "opsd" | "sdpo" | null {
  return value === "sft" || value === "dpo" || value === "grpo" || value === "ppo" || value === "sdft" || value === "opsd" || value === "sdpo" ? value : null;
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function metadataStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}
