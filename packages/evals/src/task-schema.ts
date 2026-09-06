import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

import { contentHash } from "@openpond/harness";

export const TASK_JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
export const TASK_VALUE_MAX_BYTES = 1_048_576;
export const TASK_SCHEMA_MAX_BYTES = 32_768;

export type TaskSchemaIssue = { path: string; code: string; message: string };
export type TaskSchemaResult = { valid: boolean; issues: TaskSchemaIssue[] };

const validators = new Map<string, ValidateFunction>();
const schemaMaps = new Set(["properties", "$defs", "dependentSchemas"]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaChildren = new Set(["items", "additionalProperties", "not", "if", "then", "else", "contains", "unevaluatedProperties", "unevaluatedItems", "propertyNames"]);
const unsupported = new Set(["pattern", "patternProperties", "format", "$id", "$anchor", "$dynamicAnchor", "$dynamicRef", "$recursiveRef", "$recursiveAnchor", "$async", "$data", "contentSchema"]);

/** Bound producer-controlled JSON before hashing, schema compilation or validation. */
export function assertBoundedTaskJson(value: unknown, maxBytes = TASK_VALUE_MAX_BYTES): void {
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (item.exit) { seen.delete(item.value as object); continue; }
    if (++nodes > 100_000 || item.depth > 48) throw new Error("task_json_complexity_exceeded");
    if (item.value === null || typeof item.value === "string" || typeof item.value === "boolean") continue;
    if (typeof item.value === "number" && Number.isFinite(item.value)) continue;
    if (typeof item.value !== "object") throw new Error("task_json_value_invalid");
    if (seen.has(item.value)) throw new Error("task_json_cycle");
    seen.add(item.value);
    pending.push({ ...item, exit: true });
    const prototype = Object.getPrototypeOf(item.value);
    if (!Array.isArray(item.value) && prototype !== Object.prototype && prototype !== null) throw new Error("task_json_object_invalid");
    if (Object.getOwnPropertySymbols(item.value).length) throw new Error("task_json_symbol_invalid");
    if (Object.hasOwn(item.value, "toJSON")) throw new Error("task_json_serializer_invalid");
    if (Array.isArray(item.value) && (item.value.length > 10_000 || Object.keys(item.value).length !== item.value.length)) throw new Error("task_json_array_invalid");
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item.value))) {
      if (descriptor.get || descriptor.set) throw new Error("task_json_accessor_invalid");
      if (Array.isArray(item.value) && key !== "length" && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= item.value.length)) throw new Error("task_json_array_invalid");
      if (descriptor.enumerable) pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) throw new Error("task_json_size_exceeded");
}

/** No remote resolution, custom code, data mutation, regex or format plugins. */
export function validateTaskSchema(schema: unknown): TaskSchemaResult {
  try {
    validator(schema);
    return { valid: true, issues: [] };
  } catch (error) {
    return { valid: false, issues: [{ path: "", code: "task_schema_invalid", message: error instanceof Error ? error.message : "Task schema is invalid." }] };
  }
}

export function validateTaskValue(schema: unknown, value: unknown): TaskSchemaResult {
  try {
    assertBoundedTaskJson(value);
    const validate = validator(schema);
    const valid = validate(value) as boolean;
    return {
      valid,
      issues: valid ? [] : (validate.errors ?? []).slice(0, 20).map((error) => ({
        path: error.instancePath,
        code: error.keyword,
        message: error.message ?? "Value does not match the task schema.",
      })),
    };
  } catch (error) {
    return { valid: false, issues: [{ path: "", code: "task_validation_unavailable", message: error instanceof Error ? error.message : "Task validation failed." }] };
  }
}

function validator(schema: unknown): ValidateFunction {
  assertBoundedTaskJson(schema, TASK_SCHEMA_MAX_BYTES);
  inspectSchema(schema, schema, new Set(), 0, { remaining: 2_048 });
  const hash = contentHash(schema);
  const cached = validators.get(hash);
  if (cached) return cached;
  const ajv = new Ajv2020({ allErrors: false, ownProperties: true, strict: true, strictTypes: false, strictTuples: false, strictRequired: false, validateFormats: false, inlineRefs: false, loopRequired: 32, loopEnum: 32 });
  const compiled = ajv.compile(schema as Record<string, unknown>);
  if (validators.size >= 64) validators.delete(validators.keys().next().value!);
  validators.set(hash, compiled);
  return compiled;
}

function inspectSchema(value: unknown, root: unknown, ancestors: Set<unknown>, depth: number, budget: { remaining: number }): void {
  if (--budget.remaining < 0) throw new Error("Task schema reference expansion exceeds the validation budget.");
  if (typeof value === "boolean") return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A task schema must be an object or boolean.");
  if (depth > 24 || ancestors.has(value)) throw new Error("Recursive or deeply nested task schemas are not supported.");
  const next = new Set(ancestors).add(value);
  const schema = value as Record<string, unknown>;
  if (schema.$schema !== undefined && schema.$schema !== TASK_JSON_SCHEMA_DIALECT) throw new Error(`Task schemas must use ${TASK_JSON_SCHEMA_DIALECT}.`);
  for (const [key, child] of Object.entries(schema)) {
    if (unsupported.has(key)) throw new Error(`Task schema keyword ${key} is not supported by the bounded validator.`);
    if (key === "$ref") {
      if (typeof child !== "string" || !child.startsWith("#/$defs/")) throw new Error("Task schema references must be local JSON pointers into $defs.");
      let target = root;
      for (const segment of child.slice(2).split("/")) {
        if (/~(?![01])/u.test(segment)) throw new Error("Invalid task schema JSON pointer.");
        const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
        if (!target || typeof target !== "object" || !Object.hasOwn(target, decoded)) throw new Error(`Task schema reference ${child} is missing.`);
        target = (target as Record<string, unknown>)[decoded];
      }
      inspectSchema(target, root, next, depth + 1, budget);
    } else if (schemaMaps.has(key)) {
      if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error(`Invalid schema map ${key}.`);
      for (const entry of Object.values(child)) inspectSchema(entry, root, next, depth + 1, budget);
    } else if (schemaArrays.has(key)) {
      if (!Array.isArray(child) || child.length > 32) throw new Error(`Schema ${key} must contain at most 32 alternatives.`);
      for (const entry of child) inspectSchema(entry, root, next, depth + 1, budget);
    } else if (schemaChildren.has(key)) inspectSchema(child, root, next, depth + 1, budget);
  }
}
