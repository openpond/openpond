import {
  TasksetSchema,
  type Taskset,
  type TasksetCapabilityManifest,
} from "@openpond/contracts";
import { contentHash } from "./hashing.js";

export type TasksetValidationIssue = {
  code: string;
  severity: "warning" | "error";
  message: string;
  path: string | null;
};

export type TasksetValidationReport = {
  valid: boolean;
  taskset: Taskset | null;
  computedHash: string | null;
  issues: TasksetValidationIssue[];
};

export function validateTaskset(input: unknown): TasksetValidationReport {
  const parsed = TasksetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      taskset: null,
      computedHash: null,
      issues: parsed.error.issues.map((issue) => ({
        code: "schema_invalid",
        severity: "error",
        message: issue.message,
        path: issue.path.join("."),
      })),
    };
  }

  const taskset = parsed.data;
  const issues: TasksetValidationIssue[] = [];
  validateSourceConsent(taskset, issues);
  validateSplitIsolation(taskset, issues);
  validatePolicyBoundary(taskset, issues);
  validateGraders(taskset, issues);
  validateGraderFixtures(taskset, issues);
  validateCapabilities(taskset.capabilities, issues);

  const computedHash = tasksetContentHash(taskset);
  if (taskset.contentHash !== computedHash) {
    issues.push({
      code: "content_hash_mismatch",
      severity: "error",
      message: `Taskset contentHash is ${taskset.contentHash}, expected ${computedHash}.`,
      path: "contentHash",
    });
  }

  return {
    valid: !issues.some((issue) => issue.severity === "error"),
    taskset,
    computedHash,
    issues,
  };
}

function validateGraderFixtures(taskset: Taskset, issues: TasksetValidationIssue[]): void {
  const taskIds = new Set(taskset.tasks.map((task) => task.id));
  const required = new Set(["positive", "negative", "boundary", "adversarial", "prompt_injection", "infrastructure_failure"]);
  for (const fixture of taskset.graderFixtures) {
    if (!taskIds.has(fixture.taskId)) issues.push({ code: "grader_fixture_task_missing", severity: "error", message: `Fixture ${fixture.id} references missing task ${fixture.taskId}.`, path: `graderFixtures.${fixture.id}.taskId` });
    required.delete(fixture.label);
    if (fixture.label === "infrastructure_failure" && !fixture.infrastructureError) issues.push({ code: "infrastructure_fixture_error_missing", severity: "error", message: `Infrastructure fixture ${fixture.id} must declare an infrastructure error.`, path: `graderFixtures.${fixture.id}.infrastructureError` });
  }
  for (const label of required) issues.push({ code: "grader_fixture_missing", severity: "error", message: `Taskset requires a ${label} grader fixture.`, path: "graderFixtures" });
}

export function computeTasksetHash(taskset: Omit<Taskset, "contentHash"> | Taskset): string {
  return tasksetContentHash(taskset);
}

function tasksetContentHash(taskset: Omit<Taskset, "contentHash"> | Taskset): string {
  const { contentHash: _contentHash, status: _status, readiness: _readiness, updatedAt: _updatedAt, ...source } = taskset as Taskset;
  return contentHash(source);
}

export function validatePortability(capabilities: TasksetCapabilityManifest): TasksetValidationIssue[] {
  const issues: TasksetValidationIssue[] = [];
  validateCapabilities(capabilities, issues);
  return issues;
}

function validateSourceConsent(taskset: Taskset, issues: TasksetValidationIssue[]): void {
  for (const [index, source] of taskset.sourceRefs.entries()) {
    if (source.consent.status !== "granted") {
      issues.push({ code: "source_consent_missing", severity: "error", message: `Source ${source.id} is not consented.`, path: `sourceRefs.${index}.consent.status` });
    }
    if (source.secretScanStatus !== "passed") {
      issues.push({ code: "source_secret_scan", severity: "error", message: `Source ${source.id} did not pass secret scanning.`, path: `sourceRefs.${index}.secretScanStatus` });
    }
    if (source.piiScanStatus !== "passed") {
      issues.push({ code: "source_pii_scan", severity: "error", message: `Source ${source.id} has unresolved PII policy.`, path: `sourceRefs.${index}.piiScanStatus` });
    }
    if (source.licensingStatus !== "approved") {
      issues.push({ code: "source_license", severity: "error", message: `Source ${source.id} has unresolved licensing policy.`, path: `sourceRefs.${index}.licensingStatus` });
    }
  }
}

function validateSplitIsolation(taskset: Taskset, issues: TasksetValidationIssue[]): void {
  const clusterSplits = new Map<string, Set<string>>();
  for (const task of taskset.tasks) {
    const splits = clusterSplits.get(task.clusterKey) ?? new Set<string>();
    splits.add(task.split);
    clusterSplits.set(task.clusterKey, splits);
  }
  for (const [cluster, splits] of clusterSplits) {
    if (splits.size > 1) {
      issues.push({ code: "split_cluster_contamination", severity: "error", message: `Source cluster ${cluster} appears in multiple splits: ${[...splits].join(", ")}.`, path: "tasks" });
    }
  }
  const frozenCount = taskset.tasks.filter((task) => task.split === "frozen_eval").length;
  if (frozenCount === 0) issues.push({ code: "frozen_eval_missing", severity: "warning", message: "Add an independent test example before training.", path: "tasks" });
}

function validatePolicyBoundary(taskset: Taskset, issues: TasksetValidationIssue[]): void {
  const visible = new Set(taskset.policy.policyVisibleFields);
  for (const field of taskset.policy.privilegedFields) {
    if (visible.has(field)) issues.push({ code: "privileged_field_visible", severity: "error", message: `Field ${field} is both policy-visible and privileged.`, path: "policy" });
  }
  for (const task of taskset.tasks) {
    if (task.privilegedContextRef && Object.keys(task.policyVisibleContext).includes(task.privilegedContextRef)) {
      issues.push({ code: "privileged_context_leak", severity: "error", message: `Task ${task.id} exposes its privileged context reference.`, path: `tasks.${task.id}.policyVisibleContext` });
    }
  }
}

function validateGraders(taskset: Taskset, issues: TasksetValidationIssue[]): void {
  const ids = new Set<string>();
  for (const grader of taskset.graders) {
    if (ids.has(grader.id)) issues.push({ code: "grader_duplicate", severity: "error", message: `Duplicate grader id ${grader.id}.`, path: "graders" });
    ids.add(grader.id);
    if (grader.kind === "model_judge" && grader.rewardEligible && grader.calibrationStatus !== "passed") {
      issues.push({ code: "judge_not_calibrated", severity: "error", message: `Model judge ${grader.id} cannot contribute reward before calibration passes.`, path: `graders.${grader.id}` });
    }
    if (grader.kind === "model_judge" && grader.calibrationStatus === "passed" && typeof grader.metadata.calibrationEvidenceHash !== "string") {
      issues.push({ code: "judge_calibration_evidence_missing", severity: "error", message: `Model judge ${grader.id} declares calibration without an OpenPond fixture evidence hash.`, path: `graders.${grader.id}.metadata.calibrationEvidenceHash` });
    }
    if (grader.kind === "human" && grader.rewardEligible) {
      issues.push({ code: "human_online_reward", severity: "error", message: `Human grader ${grader.id} cannot be an online optimizer reward.`, path: `graders.${grader.id}` });
    }
  }
}

function validateCapabilities(capabilities: TasksetCapabilityManifest, issues: TasksetValidationIssue[]): void {
  if (!capabilities.exportable && capabilities.portabilityBlockers.length === 0) {
    issues.push({ code: "portability_reason_missing", severity: "error", message: "Non-exportable Tasksets must declare a portability blocker.", path: "capabilities.portabilityBlockers" });
  }
  if (capabilities.compatibleMethods.includes("grpo") && !capabilities.rewardKinds.some((kind) => kind === "exact" || kind === "deterministic" || kind === "model_judge")) {
    issues.push({ code: "grpo_reward_missing", severity: "error", message: "GRPO compatibility requires a scalar reward kind.", path: "capabilities.rewardKinds" });
  }
}
