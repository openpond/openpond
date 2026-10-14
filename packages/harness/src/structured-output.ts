import Ajv2020 from "ajv/dist/2020.js";
import { sha256Hex as sha256 } from "./sha256.js";
import { canonicalJson } from "./common.js";

export const STRUCTURED_OUTPUT_CAPABILITY = "work.structured-output.v1";
export type StructuredOutputContract = { schema: Record<string, unknown>; schemaHash: string; schemaSource: string };
export type WorkRequiredOutput = { path: string; mediaType: string; maxBytes?: number | null; submissionMode?: "structured_json"; structuredOutput?: StructuredOutputContract };
export type ValidationIssue = { path: string; message: string };
const keywords = new Set(["$schema", "$id", "$defs", "$ref", "title", "description", "type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "enum", "const", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "uniqueItems", "pattern", "multipleOf", "exclusiveMinimum", "exclusiveMaximum", "minProperties", "maxProperties"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validators = new Map<string, ReturnType<Ajv2020["compile"]>>();
function compiled(schema: Record<string, unknown>) {
  const key = sha256(JSON.stringify(schema));
  let validator = validators.get(key);
  if (!validator) {
    validator = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: false, validateFormats: true, ownProperties: true }).compile(schema);
    if (validators.size >= 64) validators.delete(validators.keys().next().value!);
    validators.set(key, validator);
  }
  return validator;
}
/** JSON Schema 2020-12 subset with local, acyclic refs and bounded compilation. */
export function assertStructuredOutputSchema(schema: unknown): asserts schema is Record<string, unknown> {
  if (!object(schema) || schema.type !== "object" || JSON.stringify(schema).length > 128000) throw new Error("structured_schema_tool_root_or_size_invalid");
  const root = schema;
  let nodes = 0;
  function visit(value: unknown, depth: number, ancestors: Set<unknown>) {
    if (typeof value === "boolean") return;
    if (!object(value) || depth > 20 || ++nodes > 2000 || ancestors.has(value)) throw new Error("structured_schema_complexity_or_shape");
    const next = new Set(ancestors).add(value);
    for (const key of Object.keys(value)) if (!keywords.has(key)) throw new Error(`structured_schema_keyword_unsupported:${key}`);
    if (value.$schema !== undefined && value.$schema !== "https://json-schema.org/draft/2020-12/schema") throw new Error("structured_schema_dialect_unsupported");
    if (typeof value.$ref === "string") {
      if (!value.$ref.startsWith("#/$defs/")) throw new Error("structured_schema_external_or_recursive_ref");
      let target: unknown = root;
      for (const part of value.$ref.slice(2).split("/")) target = object(target) && Object.hasOwn(target, part.replaceAll("~1", "/").replaceAll("~0", "~")) ? target[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
      visit(target, depth + 1, next);
    }
    // Reject constructs that can make backtracking exponential. Patterns are a
    // deliberately small linear subset; sophisticated regexes fail preparation.
    if (value.pattern !== undefined) {
      if (typeof value.pattern !== "string" || value.pattern.length > 200 || /[()|\\]/.test(value.pattern)) throw new Error("structured_schema_pattern_unsupported");
      const repetitions = value.pattern.match(/[+*?{]/g)?.length ?? 0;
      if (repetitions > 1 || repetitions === 1 && (!value.pattern.startsWith("^") || !value.pattern.endsWith("$"))) throw new Error("structured_schema_pattern_unsupported");
    }
    for (const key of ["properties", "$defs"]) if (value[key] !== undefined) {
      if (!object(value[key])) throw new Error("structured_schema_map_invalid");
      for (const child of Object.values(value[key])) visit(child, depth + 1, next);
    }
    for (const key of ["items", "additionalProperties", "not", "if", "then", "else"]) if (value[key] !== undefined) visit(value[key], depth + 1, next);
    for (const key of ["allOf", "anyOf", "oneOf"]) if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || !value[key].length) throw new Error("structured_schema_union_invalid");
      for (const child of value[key]) visit(child, depth + 1, next);
    }
  }
  visit(schema, 0, new Set());
  compiled(schema);
}

export function resolveStructuredOutput(schemaBytes: Uint8Array, expectedHash: string): StructuredOutputContract {
  if (schemaBytes.byteLength > 128000 || sha256(schemaBytes) !== expectedHash) throw new Error("structured_schema_asset_mismatch");
  const schema: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(schemaBytes));
  assertStructuredOutputSchema(schema);
  return { schema, schemaHash: expectedHash, schemaSource: new TextDecoder("utf-8", { fatal: true }).decode(schemaBytes) };
}
export function assertStructuredOutputContract(contract: StructuredOutputContract) {
  assertStructuredOutputSchema(contract.schema);
  if (sha256(new TextEncoder().encode(contract.schemaSource)) !== contract.schemaHash || canonicalJson(JSON.parse(contract.schemaSource)) !== canonicalJson(contract.schema)) throw new Error("structured_schema_contract_changed");
  if (!/^[a-f0-9]{64}$/.test(contract.schemaHash)) throw new Error("structured_schema_hash_invalid");
}
export function structuredOutputTools(outputs: WorkRequiredOutput[]) {
  const paths = new Set<string>();
  return outputs.flatMap((output, index) => {
    if (paths.has(output.path) || !output.path || output.path.startsWith("/") || output.path.replaceAll("\\", "/").split("/").some(part => !part || part === "." || part === "..")) throw new Error("structured_output_path_invalid_or_duplicate");
    paths.add(output.path);
    if (output.submissionMode !== "structured_json") { if (output.structuredOutput) throw new Error("structured_output_opt_in_missing"); return []; }
    if (output.mediaType !== "application/json" || !output.structuredOutput) throw new Error("structured_output_contract_missing");
    assertStructuredOutputContract(output.structuredOutput);
    return [{ type: "function" as const, function: { name: `work_submit_output_${index + 1}`, description: `Validate and save ${output.path}. Supply the output fields directly; validation errors can be corrected and resubmitted.`, parameters: output.structuredOutput.schema } }];
  });
}
export function structuredToolOutput(outputs: WorkRequiredOutput[], name: string) {
  return outputs.find((output, index) => output.submissionMode === "structured_json" && name === `work_submit_output_${index + 1}`);
}
export function validateStructuredOutput(schema: Record<string, unknown>, data: unknown): ValidationIssue[] {
  let nodes = 0;
  function bound(value: unknown, depth: number) {
    if (depth > 30 || ++nodes > 10000 || (Array.isArray(value) && value.length > 1000)) throw new Error("structured_output_payload_complexity");
    if (object(value) || Array.isArray(value)) for (const child of Object.values(value)) bound(child, depth + 1);
  }
  bound(data, 0);
  const validator = compiled(schema);
  if (validator(data)) return [];
  return (validator.errors ?? []).slice(0, 20).map(error => ({ path: error.instancePath + (error.keyword === "required" ? "/" + String(error.params.missingProperty).replaceAll("~", "~0").replaceAll("/", "~1") : ""), message: error.message ?? "Schema assertion failed" }));
}
export function validateOutputBytes(output: WorkRequiredOutput, bytes: Uint8Array) {
  if (bytes.byteLength > (output.maxBytes ?? 10000000)) throw new Error("work_output_too_large");
  if (output.submissionMode !== "structured_json") return undefined;
  if (!output.structuredOutput) throw new Error("structured_output_contract_missing");
  assertStructuredOutputContract(output.structuredOutput);
  let data: unknown;
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("structured_output_invalid_json"); }
  const errors = validateStructuredOutput(output.structuredOutput.schema, data);
  if (errors.length) throw new Error("structured_output_invalid:" + JSON.stringify(errors));
  return { status: "passed" as const, schemaHash: output.structuredOutput.schemaHash, artifactHash: sha256(bytes), capability: STRUCTURED_OUTPUT_CAPABILITY };
}
export function serializeStructuredOutput(output: WorkRequiredOutput, data: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + "\n");
  validateOutputBytes(output, bytes);
  return bytes;
}
