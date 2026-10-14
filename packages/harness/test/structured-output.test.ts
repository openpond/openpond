import { expect, test } from "vitest";
import { sha256, resolveStructuredOutput, structuredOutputTools, serializeStructuredOutput, validateOutputBytes, assertStructuredOutputSchema, assertStructuredOutputContract } from "../src/index.js";

// Durable boundary: invalid correction must never become an accepted artifact,
// across unrelated output shapes; schema refs cannot reach private/external data.
test("generic structured contracts reject invalid bytes and admit corrected data without coercion", () => {
  const shapes = [
    { schema: { type: "object", properties: { currency: { type: "string", enum: ["USD"] }, lineItems: { type: "array", minItems: 1, items: { type: "object", properties: { price: { type: "number", minimum: 0 } }, required: ["price"], additionalProperties: false } } }, required: ["currency", "lineItems"], additionalProperties: false }, invalid: { currency: "USD", lineItems: [{ price: "12" }] }, valid: { currency: "USD", lineItems: [{ price: 12 }] } },
    { schema: { type: "object", properties: { observations: { type: "array", items: { type: "boolean" }, minItems: 2 } }, required: ["observations"], additionalProperties: false }, invalid: { observations: [true] }, valid: { observations: [true, false] } },
  ];
  const outputs = shapes.map(({ schema }, index) => {
    const bytes = new TextEncoder().encode(JSON.stringify(schema));
    return { path: `${index}.json`, mediaType: "application/json", maxBytes: 1000, submissionMode: "structured_json" as const, structuredOutput: resolveStructuredOutput(bytes, sha256(bytes)) };
  });
  expect(structuredOutputTools([...outputs, { path: "report.txt", mediaType: "text/plain" }]).map(tool => tool.function.name)).toEqual(["work_submit_output_1", "work_submit_output_2"]);
  for (const [index, shape] of shapes.entries()) {
    // PostgreSQL JSONB changes object-key order while preserving the schema.
    // Its roundtrip must preserve admission; modified values still fail.
    const contract = outputs[index]!.structuredOutput;
    const reordered = JSON.parse(JSON.stringify(contract.schema, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
    expect(() => assertStructuredOutputContract({ ...contract, schema: reordered })).not.toThrow();
    expect(() => assertStructuredOutputContract({ ...contract, schema: { ...reordered, title: "changed" } })).toThrow("structured_schema_contract_changed");
    expect(() => serializeStructuredOutput(outputs[index]!, shape.invalid)).toThrow("structured_output_invalid");
    const bytes = serializeStructuredOutput(outputs[index]!, shape.valid);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(shape.valid);
    expect(validateOutputBytes(outputs[index]!, bytes)?.artifactHash).toBe(sha256(bytes));
    expect(() => validateOutputBytes({ ...outputs[index]!, structuredOutput: { ...contract, schema: { ...contract.schema, additionalProperties: true } } }, bytes)).toThrow("structured_schema_contract_changed");
    expect(() => validateOutputBytes(outputs[index]!, new TextEncoder().encode(JSON.stringify(shape.invalid)))).toThrow("structured_output_invalid");
  }
  expect(validateOutputBytes({ path: "report.txt", mediaType: "text/plain" }, new TextEncoder().encode("ordinary file"))).toBeUndefined();
  expect(() => assertStructuredOutputSchema({ type: "object", properties: { secret: { $ref: "https://private.invalid/labels" } } })).toThrow();
  expect(() => assertStructuredOutputSchema({ type: "object", $defs: { recursive: { $ref: "#/$defs/recursive" } }, properties: {} })).toThrow();
  expect(() => assertStructuredOutputSchema({ type: "object", unevaluatedProperties: false })).toThrow("unsupported");
  expect(() => assertStructuredOutputSchema({ type: "object", properties: { value: { type: "string", pattern: "^a+a+a+a+b$" } } })).toThrow("structured_schema_pattern_unsupported");
  expect(() => assertStructuredOutputSchema({ type: "object", properties: { value: { type: "string", pattern: "a+b" } } })).toThrow("structured_schema_pattern_unsupported");
  expect(() => assertStructuredOutputSchema({ type: "object", properties: { value: { type: "string", pattern: "^[a-z]+$" } } })).not.toThrow();
});
