import { z } from "zod";

import { FailureClassSchema, ReleaseHashSchema, ReleaseIdSchema, contentHash } from "@openpond/harness";
import type { DeterministicGraderSpec, GraderSpec, TaskRecord } from "./tasksets.js";
import { evaluateDeterministicGrader } from "./deterministic-graders.js";
export { evaluateDeterministicGrader, portableDeterministicCheck } from "./deterministic-graders.js";

export const ModelJudgeReceiptSchema = z.object({
  schemaVersion: z.literal("openpond.modelJudgeReceipt.v1"),
  providerId: z.string().trim().min(1).max(200),
  modelId: z.string().trim().min(1).max(500),
  modelRevision: z.string().trim().min(1).max(500).nullable(),
  responseId: z.string().trim().min(1).max(500).nullable(),
  requestHash: ReleaseHashSchema,
  responseHash: ReleaseHashSchema,
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().finite().nonnegative().nullable(),
}).strict();

export const GraderEvidenceContentSchema = z.object({
  schemaVersion: z.literal("openpond.graderEvidence.v1"),
  graderId: ReleaseIdSchema,
  graderVersion: z.string().trim().min(1).max(100),
  score: z.number().min(0).max(1).nullable(),
  passed: z.boolean(),
  rewardEligible: z.boolean(),
  failureClass: FailureClassSchema.nullable(),
  feedback: z.array(z.string().max(20_000)).max(1_000),
  visibleEvidenceRefs: z.array(ReleaseIdSchema).max(10_000),
  privilegedEvidenceRefs: z.array(ReleaseIdSchema).max(10_000),
  modelJudgeReceipt: ModelJudgeReceiptSchema.optional(),
}).strict();
export const GraderEvidenceSchema = GraderEvidenceContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();

export type AttemptEvidence = {
  output: Record<string, unknown>;
  runtimeEventRefs: string[];
  artifactRefs: string[];
  infrastructureError?: string | null;
};
export type ModelJudgeRunner = (input: { grader: Extract<GraderSpec, { kind: "model_judge" }>; task: TaskRecord; evidence: AttemptEvidence; signal?: AbortSignal }) => Promise<Omit<GraderEvidence, "schemaVersion" | "graderId" | "graderVersion" | "contentHash">>;
export type CustomVerifierRunner = (input: { grader: Extract<GraderSpec, { kind: "custom_verifier" }>; task: TaskRecord; evidence: AttemptEvidence }) => Promise<Omit<GraderEvidence, "schemaVersion" | "graderId" | "graderVersion" | "contentHash">>;

export async function gradeEvidence(input: {
  task: TaskRecord;
  evidence: AttemptEvidence;
  graders: GraderSpec[];
  modelJudge?: ModelJudgeRunner;
  customVerifier?: CustomVerifierRunner;
  purpose?: "grading" | "fixture_calibration";
  signal?: AbortSignal;
}): Promise<GraderEvidence[]> {
  if (input.evidence.infrastructureError) {
    return input.graders.map((grader) => evidence(grader, {
      score: null,
      passed: false,
      rewardEligible: false,
      failureClass: "infrastructure_failure",
      feedback: [input.evidence.infrastructureError!],
      visibleEvidenceRefs: [],
      privilegedEvidenceRefs: [],
    }));
  }
  return Promise.all(input.graders.map(async (grader) => {
    if (grader.kind === "model_judge") {
      if (!input.modelJudge || (grader.calibrationStatus !== "passed" && input.purpose !== "fixture_calibration")) return evidence(grader, unavailable("Model judge is unavailable or uncalibrated."));
      input.signal?.throwIfAborted();
      const result = await input.modelJudge({ grader, task: input.task, evidence: input.evidence, signal: input.signal });
      return evidence(grader, { ...result, rewardEligible: input.purpose === "fixture_calibration" ? false : result.rewardEligible });
    }
    if (grader.kind === "custom_verifier") {
      if (!input.customVerifier) return evidence(grader, unavailable("Custom verifier is unavailable."));
      return evidence(grader, await input.customVerifier({ grader, task: input.task, evidence: input.evidence }));
    }
    if (grader.kind === "human") return evidence(grader, unavailable("Human review is pending."));
    return evidence(grader, gradeDeterministic(grader, input.task, input.evidence));
  }));
}

function gradeDeterministic(grader: DeterministicGraderSpec, task: TaskRecord, attempt: AttemptEvidence): Omit<GraderEvidence, "schemaVersion" | "graderId" | "graderVersion" | "contentHash"> {
  const result = evaluateDeterministicGrader({ grader, task, evidence: attempt });
  if (result.score === null) return unavailable(result.feedback);
  return {
    score: result.score,
    passed: result.passed,
    rewardEligible: grader.rewardEligible,
    failureClass: result.passed ? null : "policy_failure",
    feedback: [result.feedback],
    visibleEvidenceRefs: [...attempt.runtimeEventRefs, ...attempt.artifactRefs],
    privilegedEvidenceRefs: grader.privileged ? [task.privilegedContextRef].filter((ref): ref is string => ref !== null) : [],
  };
}

function evidence(grader: GraderSpec, result: Omit<GraderEvidence, "schemaVersion" | "graderId" | "graderVersion" | "contentHash">): GraderEvidence {
  const content = GraderEvidenceContentSchema.parse({
    schemaVersion: "openpond.graderEvidence.v1",
    graderId: grader.id,
    graderVersion: grader.version,
    ...result,
    rewardEligible: grader.rewardEligible && result.rewardEligible && result.score !== null,
  });
  return GraderEvidenceSchema.parse({ ...content, contentHash: contentHash(content) });
}
function unavailable(message: string): Omit<GraderEvidence, "schemaVersion" | "graderId" | "graderVersion" | "contentHash"> {
  return { score: null, passed: false, rewardEligible: false, failureClass: "grader_failure", feedback: [message], visibleEvidenceRefs: [], privilegedEvidenceRefs: [] };
}

export type GraderEvidence = z.infer<typeof GraderEvidenceSchema>;

const GradeSummarySchema = z.object({
  score: z.number().min(0).max(1).nullable(), passed: z.boolean(),
  rewardEligible: z.boolean(), failureClass: FailureClassSchema.nullable(),
  gradingStatus: z.enum(["scored", "unscorable", "not_configured"]),
}).strict();

/** Shared ordinary grading policy. Results must match the declared population;
 * missing checks cannot disappear from the denominator or the hard gates. */
export function aggregateGraderScores(input: {
  graders: ReadonlyArray<Pick<GraderSpec, "id" | "version" | "weight" | "hardGate" | "rewardEligible">>;
  components: ReadonlyArray<Pick<GraderEvidence, "graderId" | "graderVersion" | "score" | "passed" | "rewardEligible" | "failureClass">>;
  infrastructureError?: string | null;
}): z.infer<typeof GradeSummarySchema> {
  const ids = new Set(input.graders.map(grader => grader.id));
  if (ids.size !== input.graders.length || input.components.length !== input.graders.length) throw new Error("Grade population differs from its declared graders.");
  const components = new Map(input.components.map(item => [item.graderId, item]));
  if (components.size !== input.components.length) throw new Error("Grade population contains duplicate graders.");
  let weighted = 0; let totalWeight = 0; let hardGateFailed = false; let passed = true; let eligible = false; let unavailable = false;
  let infrastructure = !!input.infrastructureError;
  for (const grader of input.graders) {
    const item = components.get(grader.id);
    if (!item || item.graderVersion !== grader.version) throw new Error("Grade identity differs from its declared grader.");
    if (!Number.isFinite(grader.weight) || grader.weight < 0 || (item.score !== null && (!Number.isFinite(item.score) || item.score < 0 || item.score > 1))) throw new Error("Grade scores and weights must be finite and within their declared range.");
    infrastructure ||= item.failureClass === "infrastructure_failure";
    unavailable ||= item.score === null || (item.failureClass !== null && item.failureClass !== "policy_failure");
    hardGateFailed ||= grader.hardGate && !item.passed;
    passed &&= item.passed;
    eligible ||= grader.rewardEligible && item.rewardEligible;
    totalWeight += grader.weight;
    weighted += (item.score ?? 0) * grader.weight;
  }
  const score = infrastructure || unavailable || totalWeight <= 0 ? null : hardGateFailed ? 0 : weighted / totalWeight;
  passed = score !== null && !hardGateFailed && passed;
  return GradeSummarySchema.parse({ score, passed, rewardEligible: score !== null && eligible,
    failureClass: infrastructure ? "infrastructure_failure" : score === null ? "grader_failure" : passed ? null : "policy_failure",
    gradingStatus: !input.graders.length && !infrastructure ? "not_configured" : score === null ? "unscorable" : "scored" });
}

export const TaskGradeSchema = /* @__PURE__ */ (() => GradeSummarySchema.extend({
  schemaVersion: z.literal("openpond.taskGrade.v1"),
  taskHash: ReleaseHashSchema, evidenceHash: ReleaseHashSchema, graderSetHash: ReleaseHashSchema,
  components: z.array(GraderEvidenceSchema).max(1_000), contentHash: ReleaseHashSchema,
}).strict())();
export type TaskGrade = z.infer<typeof TaskGradeSchema>;

export async function gradeTaskEvidence(input: Parameters<typeof gradeEvidence>[0]): Promise<TaskGrade> {
  const components = await gradeEvidence(input);
  const content = { schemaVersion: "openpond.taskGrade.v1" as const,
    taskHash: contentHash(input.task), evidenceHash: contentHash(input.evidence), graderSetHash: contentHash(input.graders), components,
    ...aggregateGraderScores({ graders: input.graders, components, infrastructureError: input.evidence.infrastructureError }) };
  return TaskGradeSchema.parse({ ...content, contentHash: contentHash(content) });
}

/** Verify retained results against the exact admitted inputs without rerunning
 * graders. The storage owner supplies the trusted artifact, not the caller. */
export function verifyTaskGrade(value: unknown, input: Pick<Parameters<typeof gradeEvidence>[0], "task" | "evidence" | "graders">): TaskGrade {
  const result = TaskGradeSchema.parse(value);
  const { contentHash: hash, ...content } = result;
  if (hash !== contentHash(content) || result.taskHash !== contentHash(input.task) || result.evidenceHash !== contentHash(input.evidence) || result.graderSetHash !== contentHash(input.graders)) throw new Error("Task grade differs from its admitted task, evidence or graders.");
  for (const component of result.components) {
    const { contentHash: componentHash, ...body } = component;
    if (componentHash !== contentHash(body)) throw new Error("Grader evidence integrity failed.");
  }
  const summary = aggregateGraderScores({ graders: input.graders, components: result.components, infrastructureError: input.evidence.infrastructureError });
  if (contentHash(GradeSummarySchema.parse({ score: result.score, passed: result.passed, rewardEligible: result.rewardEligible, failureClass: result.failureClass, gradingStatus: result.gradingStatus })) !== contentHash(summary)) throw new Error("Task grade summary differs from its grader evidence.");
  return result;
}
