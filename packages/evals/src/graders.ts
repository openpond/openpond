import { z } from "zod";

import { FailureClassSchema, ReleaseHashSchema, ReleaseIdSchema, contentHash } from "@openpond/harness";
import type { DeterministicGraderSpec, GraderSpec, TaskRecord } from "./tasksets.js";
import { evaluateDeterministicGrader } from "./deterministic-graders.js";
export { evaluateDeterministicGrader, portableDeterministicCheck } from "./deterministic-graders.js";

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
}).strict();
export const GraderEvidenceSchema = GraderEvidenceContentSchema.extend({ contentHash: ReleaseHashSchema }).strict();

export type AttemptEvidence = {
  output: Record<string, unknown>;
  runtimeEventRefs: string[];
  artifactRefs: string[];
  infrastructureError?: string | null;
};
export type ModelJudgeRunner = (input: { grader: Extract<GraderSpec, { kind: "model_judge" }>; task: TaskRecord; evidence: AttemptEvidence }) => Promise<Omit<GraderEvidence, "schemaVersion" | "graderId" | "graderVersion" | "contentHash">>;
export type CustomVerifierRunner = (input: { grader: Extract<GraderSpec, { kind: "custom_verifier" }>; task: TaskRecord; evidence: AttemptEvidence }) => Promise<Omit<GraderEvidence, "schemaVersion" | "graderId" | "graderVersion" | "contentHash">>;

export async function gradeEvidence(input: {
  task: TaskRecord;
  evidence: AttemptEvidence;
  graders: GraderSpec[];
  modelJudge?: ModelJudgeRunner;
  customVerifier?: CustomVerifierRunner;
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
      if (!input.modelJudge || grader.calibrationStatus !== "passed") return evidence(grader, unavailable("Model judge is unavailable or uncalibrated."));
      return evidence(grader, await input.modelJudge({ grader, task: input.task, evidence: input.evidence }));
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
