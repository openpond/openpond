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
  const trainTasks = input.taskset.tasks.filter((task) => task.split === "train" && task.expectedOutput).length;
  const frozenTasks = input.taskset.tasks.filter((task) => task.split === "frozen_eval").length;
  if (trainTasks === 0) blockers.push({ code: "sft_demonstrations_missing", message: "At least one approved training demonstration from an independent source cluster is required.", path: "tasks" });
  if (frozenTasks === 0) blockers.push({ code: "frozen_eval_missing", message: "At least one frozen evaluation task is required.", path: "tasks" });
  if (!input.graderAudit) blockers.push({ code: "grader_audit_missing", message: "Run the positive, negative, boundary, adversarial, prompt-injection, and infrastructure grader fixtures.", path: "graderFixtures" });
  if (input.graderAudit && input.graderAudit.tasksetHash !== input.taskset.contentHash) blockers.push({ code: "grader_audit_stale", message: "The Taskset changed after this grader audit. Run it again.", path: "graderFixtures" });
  if (input.graderAudit && !input.graderAudit.hackingChecksPassed) blockers.push({ code: "grader_hacking", message: "Grader hacking or prompt-injection checks failed.", path: "graders" });
  if (input.graderAudit && !input.graderAudit.leakageChecksPassed) blockers.push({ code: "environment_leakage", message: "Environment or privileged-state leakage checks failed.", path: "environment" });
  if (input.graderAudit && !input.graderAudit.infrastructureSafetyPassed) blockers.push({ code: "infrastructure_reward", message: "An infrastructure failure produced a score or eligible reward.", path: "graderFixtures" });
  const currentBaseline = input.baseline?.tasksetHash === input.taskset.contentHash ? input.baseline : null;
  const baselineReward = currentBaseline?.reward;
  const hasRewardVariance = Boolean(baselineReward && (baselineReward.variance ?? 0) > 0 && (baselineReward.mean ?? 0) > 0.05 && (baselineReward.mean ?? 0) < 0.95);
  const hasRewardEligibleGrader = input.taskset.graders.some((grader) => grader.rewardEligible && (grader.kind !== "model_judge" || grader.calibrationStatus === "passed"));
  const recommendedMethod = hasRewardVariance && hasRewardEligibleGrader && input.taskset.capabilities.compatibleMethods.includes("grpo") ? "grpo" : trainTasks > 0 ? "sft" : "none";
  const ready = blockers.length === 0;
  return TasksetReadinessReportSchema.parse({
    schemaVersion: "openpond.tasksetReadiness.v1",
    tasksetId: input.taskset.id,
    tasksetHash: input.taskset.contentHash,
    ready,
    recommendedMethod,
    compatibleDestinationClasses: ready ? ["export", "local_cpu_fixture", "custom", "openpond_managed"] : ["export"],
    blockers,
    warnings: [
      ...validation.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
      ...(input.baseline && input.baseline.tasksetHash !== input.taskset.contentHash ? ["The saved baseline is stale and will not be used for method selection or comparison."] : []),
      ...(currentBaseline && (!currentBaseline.hackingChecksPassed || !currentBaseline.leakageChecksPassed) ? ["The optional baseline reported a safety failure; review it before using baseline results for method selection."] : []),
      ...(recommendedMethod === "grpo" ? ["GRPO is readiness-compatible but not executable in the local CPU fixture."] : []),
    ],
    baselineReportId: currentBaseline?.id ?? null,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    metadata: { reportHash: contentHash([input.taskset.contentHash, currentBaseline?.id ?? null, blockers]) },
  });
}
