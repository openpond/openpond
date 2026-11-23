import { expect, test } from "vitest";
import { validateTaskValue } from "@openpond/evals/task-schema";
import { codexOutputSchema, claudeOutputSchema } from "./native-output-schema.js";

// Failure story: native providers rejected a valid currency const and a newer
// dialect declaration before inference. Wire adaptation must preserve answers,
// leave literal example data alone, and reject untranslatable constraints.
test("native output encoding preserves constraints and refuses dialect weakening", () => {
  const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
    required: ["currency", "amount", "flag", "nothing", "count"], properties: {
      currency: { const: "USD" }, amount: { type: "number", minimum: 0 }, flag: { const: false }, nothing: { const: null }, count: { const: 2 },
    }, examples: [{ $schema: "literal data", const: "literal data" }] };
  const original = structuredClone(schema);
  for (const encode of [codexOutputSchema, claudeOutputSchema]) {
    const wire = encode(schema);
    expect((wire.properties as Record<string, unknown>).currency).toEqual({ const: "USD", type: "string" });
    const valid = { currency: "USD", amount: 12, flag: false, nothing: null, count: 2 };
    for (const value of [valid, { ...valid, currency: "EUR" }, { ...valid, flag: true }, { ...valid, amount: -1 }, { ...valid, count: "2" }, { ...valid, extra: 1 }]) {
      expect(validateTaskValue(wire, value).valid).toBe(validateTaskValue(schema, value).valid);
    }
    expect(wire.examples).toEqual(original.examples); expect(schema).toEqual(original);
  }
  expect(claudeOutputSchema(schema).$schema).toBeUndefined();
  expect(() => claudeOutputSchema({ $schema: schema.$schema, type: "array", prefixItems: [{ type: "number" }], items: false })).toThrow("prefixItems");
});
