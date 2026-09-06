import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { contentHash } from "@openpond/harness";

import { assertBoundedTaskJson, assertTaskSchema, type TaskSchemaResult } from "./task-schema-validation.js";

const validators = new Map<string, ValidateFunction>();

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
  assertTaskSchema(schema);
  const hash = contentHash(schema);
  const cached = validators.get(hash);
  if (cached) return cached;
  // The precompiled meta-schema and bounded keyword profile are authoritative
  // for schema validity. Ajv compiles values only on the execution owner.
  const ajv = new Ajv2020({ allErrors: false, ownProperties: true, strict: true, strictSchema: false, strictTypes: false, strictTuples: false, strictRequired: false, validateFormats: false, validateSchema: false, inlineRefs: false, loopRequired: 32, loopEnum: 32 });
  const compiled = ajv.compile(schema as Record<string, unknown>);
  if (validators.size >= 64) validators.delete(validators.keys().next().value!);
  validators.set(hash, compiled);
  return compiled;
}
