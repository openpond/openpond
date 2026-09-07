import { z } from "zod";
import { SqlExecutionRequestSchema } from "./sql-execution-contract.js";

/** Explicit owner-side paths; resolution never evaluates code or traverses prototypes. */
export const EnvironmentValueReferenceSchema = z.object({
  scope: z.enum(["input", "initialState", "state", "arguments"]),
  path: z.array(z.string().min(1).max(256)).max(16),
}).strict();
const common = {
  id: z.string().min(1).max(128),
  operation: z.enum(["step", "collect"]),
  toolName: z.string().min(1).max(500).optional(),
  timeoutMs: z.number().int().min(1).max(20_000),
};
export const EnvironmentExecutionServiceSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("sqlite.v1"), sql: EnvironmentValueReferenceSchema, snapshot: EnvironmentValueReferenceSchema,
    maxRows: SqlExecutionRequestSchema.shape.maxRows, maxResultBytes: SqlExecutionRequestSchema.shape.maxResultBytes }).strict(),
  z.object({ ...common, kind: z.literal("javascript.v1"), source: EnvironmentValueReferenceSchema, cases: EnvironmentValueReferenceSchema,
    exportName: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/).max(128), maxCases: z.number().int().min(1).max(32), maxResultBytes: z.number().int().min(256).max(262_144) }).strict(),
]).superRefine((service, context) => {
  if ((service.operation === "step") !== (service.toolName !== undefined)) context.addIssue({ code: "custom", path: ["toolName"], message: "Only step services require a declared tool name." });
  if (service.operation === "collect") {
    const references = service.kind === "sqlite.v1" ? [service.sql, service.snapshot] : [service.source, service.cases];
    if (references.some(reference => reference.scope === "arguments")) context.addIssue({ code: "custom", message: "Collection has no tool arguments." });
  }
});
export type EnvironmentExecutionService = z.infer<typeof EnvironmentExecutionServiceSchema>;
export type EnvironmentValueReference = z.infer<typeof EnvironmentValueReferenceSchema>;
