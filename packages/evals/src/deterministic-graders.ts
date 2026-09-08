import { contentHash } from "@openpond/harness";
import type { DeterministicGraderSpec, TaskRecord } from "./tasksets.js";
import { validateTaskSchema, validateTaskValue } from "./task-schema.js";

export type DeterministicGrade = { score: number | null; passed: boolean; feedback: string };

/** Local and portable execution interpret the same declared checks. Missing or
 * unsupported checks are unscorable; an empty check cannot earn a reward. */
export function evaluateDeterministicGrader(input: {
  grader: Pick<DeterministicGraderSpec, "kind" | "config">;
  task: Pick<TaskRecord, "expectedOutput">;
  evidence: { output: Record<string, unknown>; artifactRefs: string[]; runtimeEventRefs: string[] };
}): DeterministicGrade {
  const { grader, task, evidence } = input;
  const config = grader.config;
  if (grader.kind === "content") {
    const outputField = text(config.outputField) ?? "text";
    const actual = text(evidence.output[outputField]);
    if (config.operator === "exact_equals") {
      const expected = text(config.expectedValue);
      if (expected === null) return unavailable("Exact content grading requires an expected value.");
      const normalize = (value: string) => {
        const unicode = config.normalizeUnicode === true ? value.normalize("NFC") : value;
        return config.trimWhitespace === true ? unicode.trim() : unicode;
      };
      return outcome(actual !== null && normalize(actual) === normalize(expected));
    }
    if (config.operator !== undefined && config.operator !== "final_answer_equals_expected") return unavailable("Unsupported content grader operator.");
    if (config.operator === undefined && (config.includes !== undefined || config.excludes !== undefined)) {
      const includes = strings(config.includes), excludes = strings(config.excludes);
      if (!includes.length && !excludes.length) return unavailable("Content grading requires a nonempty check.");
      const value = typeof evidence.output.text === "string" ? evidence.output.text : JSON.stringify(evidence.output);
      return outcome(includes.every(item => value.includes(item)) && excludes.every(item => !value.includes(item)));
    }
    const expected = text(config.expectedValue) ?? text(task.expectedOutput?.[text(config.expectedField) ?? "text"]);
    const normalize = config.operator === "final_answer_equals_expected" ? normalizeFinalAnswer : normalizeContent;
    if (expected === null || !normalize(expected)) return unavailable("Content grading requires a nonempty expected value.");
    return outcome(actual !== null && normalize(actual) === normalize(expected));
  }
  if (grader.kind === "schema") {
    if (config.operator !== undefined && config.operator !== "json_schema_subset") return unavailable("Unsupported schema grader operator.");
    const schema = config.operator === "json_schema_subset" ? config.schema : config.jsonSchema;
    if (schema !== undefined) {
      const checked = validateTaskSchema(schema);
      if (!checked.valid) return unavailable(checked.issues[0]!.message);
      let value: unknown = evidence.output;
      if (config.operator === "json_schema_subset") {
        const encoded = evidence.output[text(config.jsonField) ?? "text"];
        if (typeof encoded === "string") {
          try { value = JSON.parse(encoded.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
          catch { return outcome(false, "The model output was not valid JSON."); }
        }
      }
      const checkedValue = validateTaskValue(schema, value);
      return outcome(checkedValue.valid, checkedValue.valid ? undefined : checkedValue.issues.map(issue => issue.message).join(" "));
    }
    const required = strings(config.requiredKeys);
    if (!required.length) return unavailable("Schema grading requires a JSON Schema or explicit required keys.");
    return outcome(required.every(key => Object.hasOwn(evidence.output, key)));
  }
  if (grader.kind === "artifact") {
    const contains = text(config.refIncludes);
    if (!contains) return unavailable("Artifact grading requires a declared artifact reference.");
    return outcome(evidence.artifactRefs.some(ref => ref.includes(contains)));
  }
  if (grader.kind === "runtime_event") {
    const required = strings(config.requiredEvents);
    if (!required.length) return unavailable("Runtime event grading requires declared events.");
    return outcome(required.every(event => evidence.runtimeEventRefs.some(ref => ref.includes(event))));
  }
  if (config.operator === "output_field_equals") {
    const field = text(config.outputField);
    if (!field || !Object.hasOwn(config, "expectedValue")) return unavailable("Output comparison requires a field and expected value.");
    return outcome(Object.hasOwn(evidence.output, field) && contentHash(evidence.output[field]) === contentHash(config.expectedValue));
  }
  if (config.operator !== undefined) return unavailable("Unsupported state grader operator.");
  const fields = strings(config.fields);
  const compared = fields.length ? fields : Object.keys(task.expectedOutput ?? {});
  if (!compared.length || compared.some(field => !task.expectedOutput || !Object.hasOwn(task.expectedOutput, field))) return unavailable("State grading requires expected values for every compared field.");
  return outcome(compared.every(field => Object.hasOwn(evidence.output, field) && contentHash(evidence.output[field]) === contentHash(task.expectedOutput![field])));
}

/** Encode native artifact/test checks without changing their meaning in transit. */
export function portableDeterministicCheck(grader: { kind: DeterministicGraderSpec["kind"] | "file" | "diff" | "test"; config: Record<string, unknown> }): Pick<DeterministicGraderSpec, "kind" | "config"> {
  if (grader.kind === "file") {
    const { pathIncludes, ...config } = grader.config;
    return { kind: "artifact", config: { ...config, ...(pathIncludes === undefined ? {} : { refIncludes: pathIncludes }) } };
  }
  if (grader.kind === "diff" || grader.kind === "test") return { kind: "state", config: { operator: "output_field_equals", outputField: grader.kind === "test" ? "testsPassed" : "diffAccepted", expectedValue: true } };
  return { kind: grader.kind, config: grader.config };
}

function outcome(passed: boolean, feedback?: string): DeterministicGrade { return { score: Number(passed), passed, feedback: feedback ?? (passed ? "Deterministic grader passed." : "Deterministic grader failed.") }; }
function unavailable(feedback: string): DeterministicGrade { return { score: null, passed: false, feedback }; }
function text(value: unknown): string | null { return typeof value === "string" ? value : null; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []; }
function normalizeContent(value: string): string { return value.normalize("NFKC").trim().replace(/[,，]/g, "").replace(/[.\s]+$/g, "").replace(/\s+/g, " "); }
function normalizeFinalAnswer(value: string): string {
  const boxed = [...value.matchAll(/\\boxed\{([^{}]+)\}/g)].at(-1)?.[1];
  const hashAnswer = value.match(/####\s*([^\n\r]+)/)?.[1];
  const label = value.match(/(?:final\s+answer|answer)\s*(?::|is|=)\s*([^\n\r]+)/i)?.[1];
  return normalizeContent((boxed ?? hashAnswer ?? label ?? value).normalize("NFKC").trim().replace(/^\$+|\$+$/g, "").replace(/^\\\(|\\\)$/g, ""));
}
