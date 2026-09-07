import { z } from "zod";
import { assertBoundedTaskJson } from "./task-schema.js";

const integer = z.string().regex(/^(0|-?[1-9][0-9]*)$/).max(20).refine(value => {
  if (value.length > 20 || !/^(0|-?[1-9][0-9]*)$/.test(value)) return false;
  const parsed = BigInt(value);
  return parsed >= -(1n << 63n) && parsed < (1n << 63n);
}, "SQL integers must fit signed 64-bit storage.");
export const SqlValueSchema = z.union([
  z.null(), z.string().max(262_144),
  z.number().finite(),
  z.object({ integer }).strict(),
  z.object({ blobBase64: z.string().max(349_528).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
]);
const identifier = z.string().min(1).max(128).refine(value => !value.includes("\0"));
export const SqlSnapshotSchema = z.object({
  tables: z.array(z.object({
    name: identifier,
    columns: z.array(z.object({ name: identifier, type: z.enum(["INTEGER", "REAL", "TEXT", "BLOB"]) }).strict()).min(1).max(128),
    rows: z.array(z.array(SqlValueSchema).max(128)).max(4_096),
  }).strict()).max(64),
}).strict().superRefine((snapshot, context) => {
  const names = new Set<string>();
  for (const [index, table] of snapshot.tables.entries()) {
    const name = table.name.toLowerCase();
    if (names.has(name) || name.startsWith("sqlite_")) context.addIssue({ code: "custom", path: ["tables", index, "name"], message: "Table names must be unique and outside SQLite's reserved namespace." });
    names.add(name);
    if (new Set(table.columns.map(column => column.name.toLowerCase())).size !== table.columns.length) context.addIssue({ code: "custom", path: ["tables", index, "columns"], message: "Column names must be unique." });
    if (table.rows.some(row => row.length !== table.columns.length)) context.addIssue({ code: "custom", path: ["tables", index, "rows"], message: "Each row must match the declared columns." });
  }
});
export const SqlExecutionRequestSchema = z.object({
  schemaVersion: z.literal("openpond.sqlExecution.v1"),
  snapshot: SqlSnapshotSchema,
  sql: z.string().min(1).max(65_536).refine(value => !value.includes("\0")),
  maxRows: z.number().int().min(1).max(4_096),
  maxResultBytes: z.number().int().min(256).max(262_144),
}).strict();
export const SqlExecutionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), columns: z.array(z.string()).max(128), rows: z.array(z.array(SqlValueSchema).max(128)).max(4_096) }).strict(),
  z.object({ status: z.literal("rejected"), code: z.enum(["invalid_query", "multiple_statements", "result_too_large", "memory_limit"]) }).strict(),
]);
export type SqlValue = z.infer<typeof SqlValueSchema>;
export type SqlExecutionRequest = z.infer<typeof SqlExecutionRequestSchema>;
export type SqlExecutionResult = z.infer<typeof SqlExecutionResultSchema>;
export function assertSqlExecutionRequest(value: unknown): SqlExecutionRequest {
  assertBoundedTaskJson(value, 1_048_576);
  const parsed = SqlExecutionRequestSchema.parse(value);
  if (new TextEncoder().encode(parsed.sql).byteLength > 65_536) throw new Error("sql_source_too_large");
  return parsed;
}
