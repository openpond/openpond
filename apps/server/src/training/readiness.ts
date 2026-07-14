import {
  TasksetReadinessReportSchema,
  type BaselineReport,
  type GraderAuditReport,
  type Taskset,
  type TasksetReadinessReport,
} from "@openpond/contracts";
import { contentHash, validateTaskset } from "@openpond/taskset-sdk";

export function buildTasksetReadiness(input: {
  taskset: Taskset;
  baseline: BaselineReport | null;
  graderAudit?: GraderAuditReport | null;
  generatedAt?: string;
}): TasksetReadinessReport {
  const validation = validateTaskset(input.taskset);
  const blockers = validation.issues.filter((issue) => issue.severity === "error").map((issue) => ({ code: issue.code, message: issue.message, path: issue.path }));
  const approvedDemonstrationTaskIds = new Set(input.taskset.learningSignals.demonstrations.filter((signal) => signal.approved && signal.taskId).map((signal) => signal.taskId!));
  const trainTasks = input.taskset.tasks.filter((task) => task.split === "train" && task.expectedOutput && approvedDemonstrationTaskIds.has(task.id));
  const unapprovedTrainTasks = input.taskset.tasks.filter((task) => task.split === "train" && task.expectedOutput && !approvedDemonstrationTaskIds.has(task.id));
  const frozenTasks = input.taskset.tasks.filter((task) => task.split === "frozen_eval" && task.expectedOutput);
  if (trainTasks.length === 0) blockers.push({ code: "sft_demonstrations_missing", message: "At least one explicitly approved training demonstration is required.", path: "learningSignals.demonstrations" });
  if (unapprovedTrainTasks.length) blockers.push({ code: "sft_demonstrations_unapproved", message: `${unapprovedTrainTasks.length} training example${unapprovedTrainTasks.length === 1 ? " is" : "s are"} not explicitly approved.`, path: "learningSignals.demonstrations" });
  if (frozenTasks.length === 0) blockers.push({ code: "frozen_eval_missing", message: "At least one independent evaluation example is required.", path: "tasks" });
  const trainClusters = new Set(trainTasks.map((task) => task.clusterKey));
  const frozenClusters = new Set(frozenTasks.map((task) => task.clusterKey));
  if (trainClusters.size === 0 || frozenClusters.size === 0 || [...trainClusters].some((cluster) => frozenClusters.has(cluster))) blockers.push({ code: "independent_evaluation_missing", message: "Training and evaluation must use independent source-conversation clusters.", path: "tasks" });
  if (input.taskset.tasks.some((task) => typeof task.metadata.exampleOrigin !== "string")) blockers.push({ code: "example_provenance_missing", message: "Every training and evaluation example must record whether it was extracted, corrected, synthetic, or expert-authored.", path: "tasks.metadata.exampleOrigin" });
  const diagnosis = metadataRecord(input.taskset.metadata.diagnosis);
  if (!diagnosis || typeof diagnosis.summary !== "string" || !Array.isArray(diagnosis.stableBehavior)) blockers.push({ code: "capability_diagnosis_missing", message: "The Taskset must separate stable behavior from changing knowledge before training.", path: "metadata.diagnosis" });
  if (diagnosis?.trainingEligible === false) blockers.push({ code: "training_not_recommended", message: "The capability diagnosis does not recommend storing this behavior in model weights.", path: "metadata.diagnosis.trainingEligible" });
  if (!input.graderAudit) blockers.push({ code: "grader_audit_missing", message: "Run the positive, negative, boundary, adversarial, prompt-injection, and infrastructure grader fixtures.", path: "graderFixtures" });
  if (input.graderAudit && input.graderAudit.tasksetHash !== input.taskset.contentHash) blockers.push({ code: "grader_audit_stale", message: "The Taskset changed after this grader audit. Run it again.", path: "graderFixtures" });
  if (input.graderAudit && !input.graderAudit.passed) blockers.push({ code: "grader_audit_failed", message: "The evaluation grader did not pass all calibration fixtures.", path: "graderFixtures" });
  if (input.graderAudit && !input.graderAudit.hackingChecksPassed) blockers.push({ code: "grader_hacking", message: "Grader hacking or prompt-injection checks failed.", path: "graders" });
  if (input.graderAudit && !input.graderAudit.leakageChecksPassed) blockers.push({ code: "environment_leakage", message: "Environment or privileged-state leakage checks failed.", path: "environment" });
  if (input.graderAudit && !input.graderAudit.infrastructureSafetyPassed) blockers.push({ code: "infrastructure_reward", message: "An infrastructure failure produced a score or eligible reward.", path: "graderFixtures" });
  const currentBaseline = input.baseline?.tasksetHash === input.taskset.contentHash ? input.baseline : null;
  const baselineReward = currentBaseline?.reward;
  const hasRewardVariance = Boolean(baselineReward && (baselineReward.variance ?? 0) > 0 && (baselineReward.mean ?? 0) > 0.05 && (baselineReward.mean ?? 0) < 0.95);
  const hasRewardEligibleGrader = input.taskset.graders.some((grader) => grader.rewardEligible && (grader.kind !== "model_judge" || grader.calibrationStatus === "passed"));
  const authoredMethod = typeof input.taskset.metadata.trainingMethod === "string" ? input.taskset.metadata.trainingMethod : null;
  const authoredTrainingMethod = trainingPathMethod(authoredMethod);
  const recommendedMethod = authoredTrainingMethod
    ?? (hasRewardVariance && hasRewardEligibleGrader && input.taskset.capabilities.compatibleMethods.includes("grpo") ? "grpo" : trainTasks.length > 0 && input.taskset.capabilities.compatibleMethods.includes("sft") ? "sft" : "none");
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
  return TasksetReadinessReportSchema.parse({
    schemaVersion: "openpond.tasksetReadiness.v1",
    tasksetId: input.taskset.id,
    tasksetHash: input.taskset.contentHash,
    ready,
    recommendedMethod,
    trainingPath,
    compatibleDestinationClasses: ready ? recommendedMethod === "grpo" ? ["export", "custom", "openpond_managed", "hosted_byok"] : ["export", "local_cpu_fixture", "custom", "openpond_managed"] : ["export"],
    blockers,
    warnings: [
      ...validation.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
      ...(input.baseline && input.baseline.tasksetHash !== input.taskset.contentHash ? ["The saved baseline is stale and will not be used for method selection or comparison."] : []),
      ...(currentBaseline && (!currentBaseline.hackingChecksPassed || !currentBaseline.leakageChecksPassed) ? ["The optional baseline reported a safety failure; review it before using baseline results for method selection."] : []),
      ...(recommendedMethod === "grpo" ? ["GRPO is readiness-compatible but not executable in the local CPU fixture."] : []),
      ...(recommendedMethod === "grpo" && !hasRewardVariance ? ["A frozen baseline with reward variance is still required before a GRPO execution claim."] : []),
      ...metadataStrings(input.taskset.metadata.warnings),
    ],
    baselineReportId: currentBaseline?.id ?? null,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    metadata: { reportHash: contentHash([input.taskset.contentHash, currentBaseline?.id ?? null, blockers]) },
  });
}

function trainingPathMethod(value: string | null): "sft" | "dpo" | "grpo" | "sdft" | "opsd" | "sdpo" | null {
  return value === "sft" || value === "dpo" || value === "grpo" || value === "sdft" || value === "opsd" || value === "sdpo" ? value : null;
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function metadataStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}
