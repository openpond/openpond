// Keep schema authoring separate from the execution owner's runtime compiler so
// browsers importing portable contracts can omit compiler code entirely.
export {
  TASK_JSON_SCHEMA_DIALECT,
  TASK_VALUE_MAX_BYTES,
  TASK_SCHEMA_MAX_BYTES,
  assertBoundedTaskJson,
  validateTaskSchema,
  type TaskSchemaIssue,
  type TaskSchemaResult,
} from "./task-schema-validation.js";
export { validateTaskValue } from "./task-value-validator.js";
