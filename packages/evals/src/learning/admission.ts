import { LearningDomainError } from "./errors.js";
import { z } from "zod";
import { contentHash } from "@openpond/harness";

import { compileBoundGraders, resolveBoundRewards, RewardBindingSchema, RewardReleaseSchema, type RewardBinding, type RewardComposition, type RewardRelease } from "../rewards.js";
import { TaskRecordSchema, TasksetReleaseContentSchema, TasksetReleaseSchema, type TaskRecord, type TasksetRelease } from "../tasksets.js";
import { assertBoundedTaskJson, validateTaskValue, type TaskSchemaIssue } from "../task-schema.js";
import { assertLearningContentHash, LearningJsonObjectSchema, learningRef, LearningRevisionRefSchema, LearningSourceSchema, sameLearningRef, sealLearningContent, TaskAdmissionDecisionSchema, TaskBatchContentSchema, TaskBatchSchema, TaskDefinitionSchema, TaskEvidenceSchema, TaskExampleSubmissionSchema, type LearningSource, type TaskAdmissionDecision, type TaskBatch, type TaskDefinition, type TaskEvidence, type TaskExampleSubmission } from "./contracts.js";

export type TaskEvidenceInspection = {
  evidenceValidity: "valid" | "invalid";
  taskReady: boolean;
  observedOutputValid: boolean | null;
  issues: TaskSchemaIssue[];
};
export type TaskFamilySplit = { namespace: string; key: string; kind: "family" | "input"; split: TaskExampleSubmission["split"] };

export function inspectTaskEvidence(evidence: TaskEvidence, definition: TaskDefinition): TaskEvidenceInspection {
  assertLearningContentHash(TaskEvidenceSchema.parse(evidence));
  assertLearningContentHash(TaskDefinitionSchema.parse(definition));
  const example = evidence.submission;
  const issues: TaskSchemaIssue[] = [];
  if (!sameLearningRef(example.taskDefinition, learningRef(definition))) issues.push({ path: "/taskDefinition", code: "definition_mismatch", message: "Evidence must pin this exact task definition." });
  const input = validateTaskValue(definition.inputSchema, example.input);
  issues.push(...input.issues.map((issue) => ({ ...issue, path: `/input${issue.path}` })));
  if (example.expected !== null) {
    const expected = validateTaskValue(definition.outputSchema, example.expected);
    issues.push(...expected.issues.map((issue) => ({ ...issue, path: `/expected${issue.path}` })));
  }
  const evidenceValidity = issues.length ? "invalid" : "valid";
  if (!example.familyKey) issues.push({ path: "/familyKey", code: "family_unresolved", message: "Resolve the source family before admitting this task." });
  return { evidenceValidity, taskReady: issues.length === 0, observedOutputValid: example.observedOutput === null ? null : validateTaskValue(definition.outputSchema, example.observedOutput).valid, issues };
}

export function validateSourceSubmission(sourceInput: LearningSource, submissionInput: TaskExampleSubmission): TaskExampleSubmission {
  const source = LearningSourceSchema.parse(sourceInput);
  assertLearningContentHash(source);
  assertBoundedTaskJson(submissionInput);
  const submission = TaskExampleSubmissionSchema.parse(submissionInput);
  if (!source.enabled) throw new LearningDomainError("learning_source_disabled", 409);
  if (source.id !== submission.sourceId || !sameLearningRef(source.taskDefinition, submission.taskDefinition)) throw new LearningDomainError("learning_source_definition_mismatch", 422);
  if (!source.allowedSplits.includes(submission.split)) throw new LearningDomainError("learning_source_split_not_allowed", 422);
  const mappingHash = source.mapping ? contentHash(source.mapping) : null;
  if (mappingHash !== submission.provenance.mappingHash) throw new LearningDomainError("learning_source_mapping_mismatch", 422);
  return submission;
}

export function mapTaskSourceRecord(input: { source: LearningSource; record: unknown; idempotencyKey: string }): { status: "mapped"; example: TaskExampleSubmission } | { status: "pending"; missing: string[] } {
  assertBoundedTaskJson(input.record);
  const source = LearningSourceSchema.parse(input.source);
  assertLearningContentHash(source);
  if (!source.mapping) throw new LearningDomainError("learning_source_mapping_required", 422);
  const mapping = source.mapping;
  const fields = ["exampleId", "attemptId", "occurredAt", "input", "familyKey"] as const;
  const values = Object.fromEntries(fields.map((field) => [field, readTaskJsonPointer(input.record, mapping[field])]));
  const missing = fields.filter((field) => values[field] === undefined || values[field] === null).map(String);
  if (missing.length) return { status: "pending", missing };
  const example = TaskExampleSubmissionSchema.parse({
    schemaVersion: "openpond.taskExample.v1", sourceId: source.id, idempotencyKey: input.idempotencyKey,
    taskDefinition: source.taskDefinition, ...values, split: mapping.split,
    observedOutput: mapping.observedOutput === null ? null : readTaskJsonPointer(input.record, mapping.observedOutput) ?? null,
    expected: mapping.expected === null ? null : readTaskJsonPointer(input.record, mapping.expected) ?? null,
    evaluatorContext: mapping.evaluatorContext === null ? null : readTaskJsonPointer(input.record, mapping.evaluatorContext) ?? null,
    assets: [], provenance: { sourceRecordRef: null, mappingHash: contentHash(mapping) },
  });
  return { status: "mapped", example: validateSourceSubmission(source, example) };
}

export function readTaskJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) throw new LearningDomainError("task_json_pointer_invalid", 422);
  let current = value;
  for (const part of pointer.slice(1).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function taskRecordFromEvidence(evidence: TaskEvidence, definition: TaskDefinition): TaskRecord {
  const inspection = inspectTaskEvidence(evidence, definition);
  if (!inspection.taskReady) throw new LearningDomainError("task_evidence_not_ready", 422, inspection.issues[0]!.code);
  return TaskRecordSchema.parse({
    id: evidence.id, clusterKey: evidence.submission.familyKey!, split: evidence.submission.split,
    input: evidence.submission.input, expectedOutput: evidence.submission.expected,
    policyVisibleContext: { instructions: definition.instructions },
    privilegedContextRef: evidence.submission.evaluatorContext === null ? null : `task-evidence:${evidence.contentHash}`,
    artifactRefs: evidence.submission.assets, tags: [definition.category],
  });
}

export function taskAttemptEvidence(evidence: TaskEvidence, output: Record<string, unknown>) {
  return { output, runtimeEventRefs: [] as string[], artifactRefs: evidence.submission.assets.map((asset) => asset.id) };
}

export function assertAdmissionDecision(input: { decision: TaskAdmissionDecision; evidence: TaskEvidence; definition: TaskDefinition; purpose: TaskBatch["purpose"] }): void {
  const decision = TaskAdmissionDecisionSchema.parse(input.decision);
  assertLearningContentHash(decision);
  if (!sameLearningRef(decision.evidence, learningRef(input.evidence))) throw new LearningDomainError("task_admission_evidence_mismatch", 422);
  const inspection = inspectTaskEvidence(input.evidence, input.definition);
  if (!inspection.taskReady || decision.evidenceValidity !== "valid" || decision.taskAdmissibility !== "approved") throw new LearningDomainError("task_admission_not_approved", 422);
  if (input.purpose === "supervised_training") {
    if (decision.targetApproval !== "approved" || decision.approvedTarget === null) throw new LearningDomainError("supervised_target_not_approved", 422);
    if (!validateTaskValue(input.definition.outputSchema, decision.approvedTarget).valid) throw new LearningDomainError("supervised_target_schema_invalid", 422);
    if (!decision.targetGrade) throw new LearningDomainError("supervised_target_grade_required", 422);
    assertGradeIdentity(decision.targetGrade, input.evidence, input.definition, decision.approvedTarget);
    const scores = [decision.targetGrade.training, decision.targetGrade.evaluation].filter((score) => score.status !== "not_configured");
    if (!scores.length || scores.some((score) => score.status !== "scored" || score.passed !== true)) throw new LearningDomainError("supervised_target_checks_not_passed", 422);
  }
  if (decision.grade) {
    if (!input.evidence.submission.observedOutput) throw new LearningDomainError("observed_grade_without_output", 422);
    assertGradeIdentity(decision.grade, input.evidence, input.definition, input.evidence.submission.observedOutput);
  }
}

export function assertGradeIdentity(grade: RewardComposition, evidence: TaskEvidence, definition: TaskDefinition, output: Record<string, unknown>): void {
  assertLearningContentHash(grade);
  if (!sameLearningRef(grade.binding, definition.rewardBinding) || grade.taskHash !== contentHash(taskRecordFromEvidence(evidence, definition)) || grade.outputHash !== contentHash(taskAttemptEvidence(evidence, output))) throw new LearningDomainError("task_grade_identity_mismatch", 422);
}

export function taskFamilyReservations(evidence: TaskEvidence, definition: TaskDefinition): TaskFamilySplit[] {
  if (!evidence.submission.familyKey) throw new LearningDomainError("task_family_unresolved", 422);
  return [
    { namespace: definition.familyNamespace, kind: "family", key: evidence.submission.familyKey, split: evidence.submission.split },
    { namespace: definition.familyNamespace, kind: "input", key: contentHash(evidence.submission.input), split: evidence.submission.split },
  ];
}

export function sealTaskBatch(input: { id: string; definition: TaskDefinition; binding: RewardBinding; rewards: RewardRelease[]; purpose: TaskBatch["purpose"]; evidence: TaskEvidence[]; decisions: TaskAdmissionDecision[]; priorSplits: TaskFamilySplit[]; actorId: string; now: string }): TaskBatch {
  const definition = TaskDefinitionSchema.parse(input.definition);
  assertLearningContentHash(definition);
  if (!sameLearningRef(definition.rewardBinding, learningRef(input.binding))) throw new LearningDomainError("task_definition_reward_binding_mismatch", 422);
  resolveBoundRewards(input.binding, input.rewards);
  if (input.purpose === "reward_training" && !input.binding.sources.some((source) => source.role === "training" && source.weight > 0)) throw new LearningDomainError("training_reward_not_configured", 422);
  if (!input.evidence.length || new Set(input.evidence.map((evidence) => evidence.id)).size !== input.evidence.length) throw new LearningDomainError("task_batch_evidence_set_invalid", 422);
  const splits = new Map(input.priorSplits.map((reservation) => [contentHash([reservation.namespace, reservation.kind, reservation.key]), reservation.split]));
  const examples = input.evidence.map((evidence) => {
    const decision = input.decisions.find((candidate) => sameLearningRef(candidate.evidence, learningRef(evidence)));
    if (!decision) throw new LearningDomainError("task_admission_missing", 422, evidence.id);
    assertAdmissionDecision({ decision, evidence, definition, purpose: input.purpose });
    if ((input.purpose === "evaluation") === (evidence.submission.split === "train")) throw new LearningDomainError("task_batch_split_not_allowed", 422);
    for (const reservation of taskFamilyReservations(evidence, definition)) {
      const key = contentHash([reservation.namespace, reservation.kind, reservation.key]);
      const prior = splits.get(key);
      if (prior !== undefined && prior !== reservation.split) throw new LearningDomainError("task_family_split_contamination", 409);
      splits.set(key, reservation.split);
    }
    return { evidence: learningRef(evidence), decision: learningRef(decision), familyKey: evidence.submission.familyKey!, inputHash: contentHash(evidence.submission.input), split: evidence.submission.split };
  });
  const content = TaskBatchContentSchema.parse({ schemaVersion: "openpond.taskBatch.v1", id: input.id, revision: 1, taskDefinition: learningRef(definition), rewardBinding: learningRef(input.binding), purpose: input.purpose, examples, sealedAt: input.now, sealedBy: input.actorId });
  return TaskBatchSchema.parse(sealLearningContent(content));
}

export const TaskBatchPackageMetadataSchema = z.object({
  schemaVersion: z.literal("openpond.taskBatchPackage.v1"),
  batch: LearningRevisionRefSchema,
  definition: TaskDefinitionSchema,
  binding: RewardBindingSchema,
  rewards: z.array(RewardReleaseSchema).min(1).max(100),
  admissions: z.array(z.object({ taskId: z.string(), evidence: LearningRevisionRefSchema, decision: LearningRevisionRefSchema, supervisedTarget: LearningJsonObjectSchema.nullable() }).strict()).min(1).max(10_000),
}).strict();

export function compileTaskBatch(input: { batch: TaskBatch; definition: TaskDefinition; binding: RewardBinding; rewards: RewardRelease[]; evidence: TaskEvidence[]; decisions: TaskAdmissionDecision[] }): TasksetRelease {
  assertLearningContentHash(TaskBatchSchema.parse(input.batch));
  assertLearningContentHash(TaskDefinitionSchema.parse(input.definition));
  if (!sameLearningRef(input.definition.rewardBinding, learningRef(input.binding))) throw new LearningDomainError("task_definition_reward_binding_mismatch", 422);
  if (!sameLearningRef(input.batch.taskDefinition, learningRef(input.definition)) || !sameLearningRef(input.batch.rewardBinding, learningRef(input.binding))) throw new LearningDomainError("task_batch_release_mismatch", 422);
  const tasks: TaskRecord[] = [];
  const admissions: z.infer<typeof TaskBatchPackageMetadataSchema>["admissions"] = [];
  for (const entry of input.batch.examples) {
    const evidence = input.evidence.find((candidate) => sameLearningRef(learningRef(candidate), entry.evidence));
    const decision = input.decisions.find((candidate) => sameLearningRef(learningRef(candidate), entry.decision));
    if (!evidence || !decision) throw new LearningDomainError("task_batch_admission_revision_missing", 422);
    assertAdmissionDecision({ decision, evidence, definition: input.definition, purpose: input.batch.purpose });
    if (entry.familyKey !== evidence.submission.familyKey || entry.inputHash !== contentHash(evidence.submission.input) || entry.split !== evidence.submission.split) throw new LearningDomainError("task_batch_evidence_snapshot_mismatch", 422);
    tasks.push(taskRecordFromEvidence(evidence, input.definition));
    admissions.push({ taskId: evidence.id, evidence: entry.evidence, decision: entry.decision, supervisedTarget: input.batch.purpose === "supervised_training" ? decision.approvedTarget : null });
  }
  const learning = TaskBatchPackageMetadataSchema.parse({ schemaVersion: "openpond.taskBatchPackage.v1", batch: learningRef(input.batch), definition: input.definition, binding: input.binding, rewards: input.rewards, admissions });
  const content = TasksetReleaseContentSchema.parse({
    schemaVersion: "openpond.tasksetRelease.v2", id: `task-batch-${input.batch.id}`, revision: 1,
    ...input.definition.execution, tasks, graders: compileBoundGraders(input.binding, input.rewards),
    metadata: { learning },
  });
  return TasksetReleaseSchema.parse(sealLearningContent(content));
}

export function taskBatchPackageMetadata(release: TasksetRelease): z.infer<typeof TaskBatchPackageMetadataSchema> {
  assertLearningContentHash(TasksetReleaseSchema.parse(release));
  const metadata = TaskBatchPackageMetadataSchema.parse(release.metadata.learning);
  assertLearningContentHash(metadata.definition);
  if (!sameLearningRef(metadata.definition.rewardBinding, learningRef(metadata.binding))) throw new LearningDomainError("task_definition_reward_binding_mismatch", 422);
  if (contentHash(release.graders) !== contentHash(compileBoundGraders(metadata.binding, metadata.rewards))) throw new LearningDomainError("taskset_reward_snapshot_mismatch", 422);
  if (metadata.admissions.length !== release.tasks.length || new Set(metadata.admissions.map((entry) => entry.taskId)).size !== release.tasks.length || metadata.admissions.some((entry) => !release.tasks.some((task) => task.id === entry.taskId))) throw new LearningDomainError("taskset_admission_inventory_mismatch", 422);
  return metadata;
}
