import { expect, test } from "vitest";
import { assertBoundedTaskJson, TASK_JSON_SCHEMA_DIALECT, validateTaskSchema, validateTaskValue } from "../src/task-schema.js";
import { gradeEvidence } from "../src/graders.js";
import { TaskRecordSchema } from "../src/tasksets.js";

// Regression: required-key checks previously accepted incorrectly typed or out-of-range nested values.
test("JSON Schema validates nested constraints without coercion, mutation or remote resolution", () => {
  const schema = {
    $schema: TASK_JSON_SCHEMA_DIALECT, type: "object", required: ["items", "currency"], additionalProperties: false,
    properties: { currency: { enum: ["USD", "EUR"] }, items: { type: "array", minItems: 1, maxItems: 5, items: { $ref: "#/$defs/line" } } },
    $defs: { line: { type: "object", required: ["amount"], additionalProperties: false, properties: { amount: { type: "number", minimum: 0, maximum: 10_000 }, tax: { type: "number", default: 0 } } } },
  };
  const value = { items: [{ amount: 42 }], currency: "USD" };
  expect(validateTaskValue(schema, value).valid).toBe(true);
  expect(value).toEqual({ items: [{ amount: 42 }], currency: "USD" });
  for (const value of [{ items: [{ amount: "42" }], currency: "USD" }, { items: [{ amount: -1 }], currency: "USD" }, { items: [], currency: "USD" }, { items: [{ amount: 42, injected: true }], currency: "USD" }, { items: [{ amount: 42 }], currency: "CAD" }]) expect(validateTaskValue(schema, value).valid).toBe(false);
  for (const schema of [{ $ref: "https://example.org/schema" }, { type: "string", pattern: "(a+)+$" }, { $defs: { loop: { $ref: "#/$defs/loop" } }, $ref: "#/$defs/loop" }, { $schema: "http://json-schema.org/draft-07/schema#" }]) expect(validateTaskSchema(schema).valid).toBe(false);
});

// Regression: serialization must never execute producer code or silently hash a different payload.
test("bounds cyclic, sparse, accessor and serializer inputs while allowing repeated ordinary JSON objects", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => assertBoundedTaskJson(cycle)).toThrow("task_json_cycle");
  expect(() => assertBoundedTaskJson(new Array(5))).toThrow("task_json_array_invalid");
  expect(() => assertBoundedTaskJson({ get value() { throw new Error("must not execute"); } })).toThrow("task_json_accessor_invalid");
  expect(() => assertBoundedTaskJson(Object.defineProperty({}, "toJSON", { value() { throw new Error("must not execute"); } }))).toThrow("task_json_serializer_invalid");
  expect(() => assertBoundedTaskJson({ value: Infinity })).toThrow("task_json_value_invalid");
  const item = { value: 1 };
  expect(() => assertBoundedTaskJson([item, item])).not.toThrow();
});

// Regression: empty checks and malformed schema must remain unscorable, never successful training reward.
test("portable graders reject vacuous checks and compare nested expected state by content", async () => {
  const task = TaskRecordSchema.parse({ id: "task", clusterKey: "family", split: "train", input: {}, expectedOutput: { nested: { answer: 42 } }, privilegedContextRef: null });
  const grade = (kind: "state" | "schema" | "runtime_event" | "content", config: Record<string, unknown>, output: Record<string, unknown> = {}) => gradeEvidence({ task, evidence: { output, runtimeEventRefs: [], artifactRefs: [] }, graders: [{ id: "grader", version: "1", kind, config, weight: 1, hardGate: false, rewardEligible: true, privileged: false }] });
  expect((await grade("state", { fields: ["nested"] }, { nested: { answer: 42 } }))[0]).toMatchObject({ score: 1, rewardEligible: true });
  for (const [kind, config] of [["schema", {}], ["schema", { jsonSchema: { type: "string", pattern: ".*" } }], ["runtime_event", { requiredEvents: [] }], ["content", { expectedValue: "" }], ["state", { fields: ["missing"] }]] as const) expect((await grade(kind, config))[0]).toMatchObject({ score: null, rewardEligible: false });
});
