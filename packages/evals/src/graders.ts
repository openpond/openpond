import { z } from "zod";

import { FailureClassSchema, ReleaseHashSchema, ReleaseIdSchema, contentHash } from "./common.js";
import type { DeterministicGraderSpec, GraderSpec, TaskRecord } from "./tasksets.js";

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
  let passed = false;
  const config = grader.config;
  if (grader.kind === "content") {
    const outputField = string(config.outputField) ?? "text";
    const actual = string(attempt.output[outputField]);
    const expected = string(config.expectedValue) ?? string(task.expectedOutput?.[string(config.expectedField) ?? "text"]);
    passed = actual !== null && expected !== null && normalize(actual) === normalize(expected);
  } else if (grader.kind === "schema") {
    passed = strings(config.requiredKeys).every((key) => Object.hasOwn(attempt.output, key));
  } else if (grader.kind === "artifact") {
    const contains = string(config.refIncludes) ?? "";
    passed = attempt.artifactRefs.some((ref) => ref.includes(contains));
  } else if (grader.kind === "runtime_event") {
    passed = strings(config.requiredEvents).every((required) => attempt.runtimeEventRefs.some((ref) => ref.includes(required)));
  } else {
    const fields = strings(config.fields);
    const compared = fields.length ? fields : Object.keys(task.expectedOutput ?? {});
    passed = compared.every((field) => Object.is(attempt.output[field], task.expectedOutput?.[field]));
  }
  return {
    score: passed ? 1 : 0,
    passed,
    rewardEligible: grader.rewardEligible && passed,
    failureClass: passed ? null : "policy_failure",
    feedback: [passed ? "Deterministic grader passed." : "Deterministic grader failed."],
    visibleEvidenceRefs: [...attempt.runtimeEventRefs, ...attempt.artifactRefs],
    privilegedEvidenceRefs: grader.privileged ? [task.privilegedContextRef].filter((ref): ref is string => ref !== null) : [],
  };
}

function evidence(grader: GraderSpec, result: Omit<GraderEvidence, "schemaVersion" | "graderId" | "graderVersion" | "contentHash">): GraderEvidence {
  const content = GraderEvidenceContentSchema.parse({ schemaVersion: "openpond.graderEvidence.v1", graderId: grader.id, graderVersion: grader.version, ...result });
  return GraderEvidenceSchema.parse({ ...content, contentHash: contentHash(content) });
}
function unavailable(message: string): Omit<GraderEvidence, "schemaVersion" | "graderId" | "graderVersion" | "contentHash"> {
  return { score: null, passed: false, rewardEligible: false, failureClass: "grader_failure", feedback: [message], visibleEvidenceRefs: [], privilegedEvidenceRefs: [] };
}
function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function normalize(value: string): string { return value.normalize("NFKC").trim().replace(/[,，]/g, "").replace(/[.\s]+$/g, "").replace(/\s+/g, " "); }

export type GraderEvidence = z.infer<typeof GraderEvidenceSchema>;
