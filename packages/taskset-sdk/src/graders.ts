import {
  type GradeComponent,
  type GradeResult,
  type GraderSpec,
  type TaskAttemptResult,
  type TaskDataRecord,
} from "@openpond/contracts";
import { contentHash } from "./hashing.js";

export type ModelJudgeRunner = (input: {
  grader: Extract<GraderSpec, { kind: "model_judge" }>;
  task: TaskDataRecord;
  attempt: TaskAttemptResult;
}) => Promise<{ score: number; passed: boolean; feedback: string; evidenceRefs?: string[] }>;

export type CustomVerifierRunner = (input: {
  grader: Extract<GraderSpec, { kind: "custom_verifier" }>;
  task: TaskDataRecord;
  attempt: TaskAttemptResult;
}) => Promise<{ score: number; passed: boolean; feedback: string; evidenceRefs?: string[] }>;

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
      components: input.graders.map((grader) => component(grader, 0, false, "Infrastructure failure; no reward was produced.", [])),
      failureClass: "infrastructure_failure",
      feedback: [input.attempt.infrastructureError],
      rewardEligible: false,
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
  return {
    schemaVersion: "openpond.gradeResult.v1",
    id: `grade_${contentHash([input.attempt.id, graderSetHash, components]).slice(0, 24)}`,
    attemptId: input.attempt.id,
    graderSetHash,
    score,
    passed: !hardGateFailed && components.every((item) => item.passed),
    components,
    failureClass: hardGateFailed || components.some((item) => !item.passed) ? "policy_failure" : null,
    feedback: components.flatMap((item) => item.feedback ? [item.feedback] : []),
    rewardEligible: !hardGateFailed && components.some((item) => item.rewardEligible),
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
    if (!modelJudge) return component(grader, 0, false, "Model judge runner is unavailable.", []);
    if (grader.calibrationStatus !== "passed") return component(grader, 0, false, "Model judge calibration has not passed.", []);
    const result = await modelJudge({ grader, task, attempt });
    return component(grader, clamp(result.score), result.passed, result.feedback, result.evidenceRefs ?? []);
  }
  if (grader.kind === "human") return component(grader, 0, false, "Human review is pending.", []);
  if (grader.kind === "custom_verifier") {
    if (!customVerifier) return component(grader, 0, false, "Sandboxed verifier runner is unavailable.", []);
    const result = await customVerifier({ grader, task, attempt });
    return component(grader, clamp(result.score), result.passed, result.feedback, result.evidenceRefs ?? []);
  }
  return runDeterministic(grader, task, attempt);
}

function runDeterministic(grader: Extract<GraderSpec, { kind: "content" | "schema" | "file" | "diff" | "test" | "runtime_event" | "state" }>, task: TaskDataRecord, attempt: TaskAttemptResult): GradeComponent {
  const config = grader.config;
  if (grader.kind === "content") {
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

function component(grader: GraderSpec, score: number, passed: boolean, feedback: string, evidenceRefs: string[]): GradeComponent {
  return {
    graderId: grader.id,
    graderVersion: grader.version,
    score,
    passed,
    hardGate: grader.hardGate,
    rewardEligible: grader.rewardEligible && passed,
    feedback,
    evidenceRefs,
    judge: grader.kind === "model_judge" ? grader.judge : null,
    calibrationStatus: grader.kind === "model_judge" ? grader.calibrationStatus : "not_applicable",
  };
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function stringOutput(output: Record<string, unknown>): string { return typeof output.text === "string" ? output.text : JSON.stringify(output); }
