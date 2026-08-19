import {
  type AttemptDiagnosis,
  type CriterionScore,
  type GradeComponent,
  type GradeResult,
  type GraderSpec,
  type TaskAttemptResult,
  type TaskDataRecord,
} from "@openpond/contracts";
import { contentHash } from "./hashing.js";

export class ModelJudgeExecutionError extends Error {
  readonly usage: unknown;
  readonly costUsd?: number;

  constructor(
    message: string,
    accounting: { usage?: unknown; costUsd?: number } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelJudgeExecutionError";
    this.usage = accounting.usage;
    this.costUsd = accounting.costUsd;
  }
}

export function isModelJudgeExecutionError(
  value: unknown,
): value is ModelJudgeExecutionError {
  if (value instanceof ModelJudgeExecutionError) return true;
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.name === "ModelJudgeExecutionError"
    && "usage" in record
    && (
      record.costUsd === undefined
      || (
        typeof record.costUsd === "number"
        && Number.isFinite(record.costUsd)
        && record.costUsd >= 0
      )
    );
}

export type ModelJudgeRunner = (input: {
  grader: Extract<GraderSpec, { kind: "model_judge" }>;
  task: TaskDataRecord;
  attempt: TaskAttemptResult;
}) => Promise<{
  score: number;
  passed: boolean;
  feedback: string;
  evidenceRefs?: string[];
  criterionScores?: CriterionScore[];
  usage?: unknown;
  costUsd?: number;
}>;

export type CustomVerifierRunner = (input: {
  grader: Extract<GraderSpec, { kind: "custom_verifier" }>;
  task: TaskDataRecord;
  attempt: TaskAttemptResult;
}) => Promise<{
  score: number;
  passed: boolean;
  feedback: string;
  evidenceRefs?: string[];
  criterionScores?: CriterionScore[];
}>;

export async function gradeAttempt(input: {
  task: TaskDataRecord;
  attempt: TaskAttemptResult;
  graders: GraderSpec[];
  modelJudge?: ModelJudgeRunner;
  customVerifier?: CustomVerifierRunner;
  now?: () => string;
}): Promise<GradeResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const graderSetHash = contentHash(input.graders);
  if (input.attempt.infrastructureError) {
    return {
      schemaVersion: "openpond.gradeResult.v1",
      id: `grade_${contentHash([input.attempt.id, graderSetHash]).slice(0, 24)}`,
      attemptId: input.attempt.id,
      graderSetHash,
      score: null,
      passed: false,
      components: input.graders.map((grader) => component(
        grader,
        0,
        false,
        "Infrastructure failure; no reward was produced.",
        [],
        false,
      )),
      failureClass: "infrastructure_failure",
      feedback: [input.attempt.infrastructureError],
      rewardEligible: false,
      diagnosis: diagnosis({
        attemptId: input.attempt.id,
        terminalClass: "infrastructure_failure",
        causes: [{
          code: "tool_failure",
          owner: "runtime",
          criterionIds: [],
          evidenceRefs: input.attempt.artifactRefs,
          scoreImpact: 1,
          confidence: 1,
        }],
        rewardEligible: false,
      }),
      createdAt: now(),
    };
  }

  const components: GradeComponent[] = [];
  for (const grader of input.graders) {
    components.push(await runGrader(grader, input.task, input.attempt, input.modelJudge, input.customVerifier));
  }
  const hardGateFailed = components.some((item) => item.hardGate && !item.passed);
  const weighted = components.reduce((sum, item, index) => sum + item.score * (input.graders[index]?.weight ?? 1), 0);
  const totalWeight = input.graders.reduce((sum, grader) => sum + grader.weight, 0);
  const score = hardGateFailed ? 0 : totalWeight > 0 ? weighted / totalWeight : 0;
  const resultDiagnosis = diagnosisFor({
    attemptId: input.attempt.id,
    components,
    graders: input.graders,
    task: input.task,
    passed: !hardGateFailed && components.every((item) => item.passed),
    rewardEligible: components.some((item) => item.rewardEligible),
  });
  return {
    schemaVersion: "openpond.gradeResult.v1",
    id: `grade_${contentHash([input.attempt.id, graderSetHash, components]).slice(0, 24)}`,
    attemptId: input.attempt.id,
    graderSetHash,
    score,
    passed: !hardGateFailed && components.every((item) => item.passed),
    components,
    failureClass: resultDiagnosis.terminalClass === "grader_failure"
      ? "grader_failure"
      : hardGateFailed ? "policy_failure" : null,
    feedback: components.flatMap((item) => item.feedback ? [item.feedback] : []),
    rewardEligible: components.some((item) => item.rewardEligible),
    diagnosis: resultDiagnosis,
    createdAt: now(),
  };
}

async function runGrader(
  grader: GraderSpec,
  task: TaskDataRecord,
  attempt: TaskAttemptResult,
  modelJudge?: ModelJudgeRunner,
  customVerifier?: CustomVerifierRunner,
): Promise<GradeComponent> {
  if (grader.kind === "model_judge") {
    if (!modelJudge) return component(grader, 0, false, "Model judge runner is unavailable.", [], false);
    if (grader.calibrationStatus !== "passed") return component(grader, 0, false, "Model judge calibration has not passed.", [], false);
    const result = await modelJudge({ grader, task, attempt });
    const criterionError = criterionScoreError({ grader, task, criterionScores: result.criterionScores ?? [] });
    if (criterionError) return component(grader, 0, false, criterionError, result.evidenceRefs ?? [], false, result.criterionScores ?? []);
    return component(grader, clamp(result.score), result.passed, result.feedback, result.evidenceRefs ?? [], grader.rewardEligible, result.criterionScores ?? []);
  }
  if (grader.kind === "human") return component(grader, 0, false, "Human review is pending.", [], false);
  if (grader.kind === "custom_verifier") {
    if (!customVerifier) return component(grader, 0, false, "Sandboxed verifier runner is unavailable.", [], false);
    const result = await customVerifier({ grader, task, attempt });
    const criterionError = criterionScoreError({ grader, task, criterionScores: result.criterionScores ?? [] });
    if (criterionError) return component(grader, 0, false, criterionError, result.evidenceRefs ?? [], false, result.criterionScores ?? []);
    return component(grader, clamp(result.score), result.passed, result.feedback, result.evidenceRefs ?? [], grader.rewardEligible, result.criterionScores ?? []);
  }
  return runDeterministic(grader, task, attempt);
}

function runDeterministic(grader: Extract<GraderSpec, { kind: "content" | "schema" | "file" | "diff" | "test" | "runtime_event" | "state" }>, task: TaskDataRecord, attempt: TaskAttemptResult): GradeComponent {
  const config = grader.config;
  if (grader.kind === "content") {
    if (config.operator === "final_answer_equals_expected") {
      const outputField =
        typeof config.outputField === "string" ? config.outputField : "text";
      const expectedField =
        typeof config.expectedField === "string" ? config.expectedField : "text";
      const actual = typeof attempt.output[outputField] === "string"
        ? attempt.output[outputField]
        : null;
      const expected = typeof task.expectedOutput?.[expectedField] === "string"
        ? task.expectedOutput[expectedField]
        : null;
      const normalizedActual = actual === null ? null : normalizedFinalAnswer(actual);
      const normalizedExpected = expected === null
        ? null
        : normalizedFinalAnswer(expected);
      const passed =
        normalizedActual !== null
        && normalizedExpected !== null
        && normalizedActual === normalizedExpected;
      return component(
        grader,
        passed ? 1 : 0,
        passed,
        passed
          ? "The final answer matched the privileged expected answer."
          : "The final answer did not match the privileged expected answer.",
        [],
      );
    }
    if (config.operator === "exact_equals") {
      const outputField = typeof config.outputField === "string" ? config.outputField : "text";
      const expected = typeof config.expectedValue === "string" ? config.expectedValue : null;
      const actual = typeof attempt.output[outputField] === "string" ? attempt.output[outputField] as string : null;
      const normalize = (value: string) => {
        const unicode = config.normalizeUnicode === true ? value.normalize("NFC") : value;
        return config.trimWhitespace === true ? unicode.trim() : unicode;
      };
      const passed = expected !== null && actual !== null && normalize(actual) === normalize(expected);
      return component(grader, passed ? 1 : 0, passed, passed ? "Content exactly matched the expected value." : "Content did not exactly match the expected value.", []);
    }
    const text = stringOutput(attempt.output);
    const includes = stringArray(config.includes);
    const excludes = stringArray(config.excludes);
    const passed = includes.every((item) => text.includes(item)) && excludes.every((item) => !text.includes(item));
    return component(grader, passed ? 1 : 0, passed, passed ? "Content requirements passed." : "Content requirements failed.", []);
  }
  if (grader.kind === "schema") {
    const requiredKeys = stringArray(config.requiredKeys);
    const passed = requiredKeys.every((key) => Object.hasOwn(attempt.output, key));
    return component(grader, passed ? 1 : 0, passed, passed ? "Schema requirements passed." : `Missing keys: ${requiredKeys.filter((key) => !Object.hasOwn(attempt.output, key)).join(", ")}.`, []);
  }
  if (grader.kind === "file") {
    const pattern = typeof config.pathIncludes === "string" ? config.pathIncludes : "";
    const passed = attempt.artifactRefs.some((ref) => ref.includes(pattern));
    return component(grader, passed ? 1 : 0, passed, passed ? "Required artifact exists." : "Required artifact is missing.", attempt.artifactRefs);
  }
  if (grader.kind === "runtime_event") {
    const required = stringArray(config.requiredEvents);
    const passed = required.every((event) => attempt.runtimeEventRefs.some((ref) => ref.includes(event)));
    return component(grader, passed ? 1 : 0, passed, passed ? "Runtime event requirements passed." : "Runtime event requirements failed.", attempt.runtimeEventRefs);
  }
  if (grader.kind === "state") {
    const expected = task.expectedOutput ?? {};
    const fields = stringArray(config.fields);
    const compared = fields.length > 0 ? fields : Object.keys(expected);
    const passed = compared.every((field) => Object.is(attempt.output[field], expected[field]));
    return component(grader, passed ? 1 : 0, passed, passed ? "State matched expected outcome." : "State did not match expected outcome.", []);
  }
  const evidenceKey = grader.kind === "test" ? "testsPassed" : "diffAccepted";
  const passed = attempt.output[evidenceKey] === true;
  return component(grader, passed ? 1 : 0, passed, passed ? `${grader.kind} evidence passed.` : `${grader.kind} evidence failed.`, attempt.artifactRefs);
}

function component(
  grader: GraderSpec,
  score: number,
  passed: boolean,
  feedback: string,
  evidenceRefs: string[],
  rewardEligible = grader.rewardEligible,
  criterionScores: CriterionScore[] = [],
): GradeComponent {
  return {
    graderId: grader.id,
    graderVersion: grader.version,
    score,
    passed,
    hardGate: grader.hardGate,
    rewardEligible,
    feedback,
    evidenceRefs,
    judge: grader.kind === "model_judge" ? grader.judge : null,
    calibrationStatus: grader.kind === "model_judge" ? grader.calibrationStatus : "not_applicable",
    criterionScores,
  };
}

function diagnosisFor(input: {
  attemptId: string;
  components: GradeComponent[];
  graders: GraderSpec[];
  task: TaskDataRecord;
  passed: boolean;
  rewardEligible: boolean;
}): AttemptDiagnosis {
  const unavailable = input.components.some((component) =>
    /(?:runner is unavailable|calibration has not passed|human review is pending)/i.test(component.feedback ?? "")
  );
  if (unavailable) {
    return diagnosis({
      attemptId: input.attemptId,
      terminalClass: "grader_failure",
      causes: [{
        code: "insufficient_evidence",
        owner: "grader",
        criterionIds: [],
        evidenceRefs: [],
        scoreImpact: 1,
        confidence: 1,
      }],
      rewardEligible: false,
    });
  }
  const criteriaById = new Map((input.task.evaluationCriteria ?? []).map((criterion) => [
    criterion.id,
    { kind: criterion.kind, critical: criterion.critical },
  ]));
  // Criteria are intentionally carried by the scored component, not inferred
  // from a hidden expected answer. A score can be diagnostic even when the
  // task-level threshold has not been met.
  const failedScores = input.components.flatMap((component) =>
    component.criterionScores.filter((criterion) => !criterion.passed)
  );
  const causes: AttemptDiagnosis["causes"] = failedScores.map((criterion) => ({
    code: causeForCriterion(criteriaById.get(criterion.criterionId)?.kind),
    owner: "model" as const,
    criterionIds: [criterion.criterionId],
    evidenceRefs: criterion.evidenceRefs,
    scoreImpact: 1 - criterion.score,
    confidence: 0.8,
  }));
  if (!input.passed && causes.length === 0) {
    causes.push({
      code: input.components.some((component) => component.hardGate && !component.passed)
        ? "visible_constraint_failure"
        : "insufficient_evidence",
      owner: "unknown" as const,
      criterionIds: [],
      evidenceRefs: [],
      scoreImpact: 1,
      confidence: 0.5,
    });
  }
  return diagnosis({
    attemptId: input.attemptId,
    terminalClass: "completed",
    causes,
    rewardEligible: input.rewardEligible,
  });
}

function causeForCriterion(kind: string | undefined):
  | "artifact_invalid"
  | "visible_constraint_failure"
  | "semantic_completeness_failure"
  | "factual_grounding_failure" {
  if (kind === "artifact_structure") return "artifact_invalid";
  if (kind === "hard_constraint") return "visible_constraint_failure";
  if (kind === "factual_grounding") return "factual_grounding_failure";
  return "semantic_completeness_failure";
}

function diagnosis(input: Omit<AttemptDiagnosis, "schemaVersion" | "primaryCauseCode" | "contentHash">): AttemptDiagnosis {
  const content = {
    schemaVersion: "openpond.attemptDiagnosis.v1" as const,
    attemptId: input.attemptId,
    terminalClass: input.terminalClass,
    causes: input.causes,
    primaryCauseCode: input.causes[0]?.code ?? null,
    rewardEligible: input.rewardEligible,
  };
  return { ...content, contentHash: contentHash(content) };
}

function criterionScoreError(input: {
  grader: GraderSpec;
  task: TaskDataRecord;
  criterionScores: CriterionScore[];
}): string | null {
  const assigned = (input.task.evaluationCriteria ?? []).filter((criterion) =>
    criterion.scorerIds.includes(input.grader.id)
  );
  if (!assigned.length) return null;
  const expected = new Set(assigned.map((criterion) => criterion.id));
  const received = new Set(input.criterionScores.map((criterion) => criterion.criterionId));
  const unknown = [...received].filter((id) => !expected.has(id));
  const missing = [...expected].filter((id) => !received.has(id));
  if (unknown.length) return `Grader returned scores for unassigned criteria: ${unknown.join(", ")}.`;
  if (missing.length) return `Grader omitted scores for assigned criteria: ${missing.join(", ")}.`;
  return null;
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function stringOutput(output: Record<string, unknown>): string { return typeof output.text === "string" ? output.text : JSON.stringify(output); }

function normalizedFinalAnswer(value: string): string {
  const boxed = [...value.matchAll(/\\boxed\{([^{}]+)\}/g)].at(-1)?.[1];
  const hashAnswer = value.match(/####\s*([^\n\r]+)/)?.[1];
  const answerLabel = value.match(
    /(?:final\s+answer|answer)\s*(?::|is|=)\s*([^\n\r]+)/i,
  )?.[1];
  const selected = boxed ?? hashAnswer ?? answerLabel ?? value;
  return selected
    .normalize("NFKC")
    .trim()
    .replace(/^\$+|\$+$/g, "")
    .replace(/^\\\(|\\\)$/g, "")
    .replace(/[,，]/g, "")
    .replace(/[.\s]+$/g, "")
    .replace(/\s+/g, " ");
}
