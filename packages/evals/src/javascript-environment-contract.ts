import { z } from "zod";
import { ImmutableAssetRefSchema, ToolDeclarationSchema, contentHash } from "@openpond/harness";
import { assertBoundedTaskJson, validateTaskSchema } from "./task-schema-validation.js";

export const JavaScriptEnvironmentDefinitionContentSchema = z.object({
  schemaVersion: z.literal("openpond.javascriptEnvironment.v1"),
  id: z.string().trim().min(1).max(500),
  revision: z.number().int().positive(),
  module: ImmutableAssetRefSchema.refine(reference => reference.visibility === "host_private", "Environment code belongs to the execution owner."),
  tools: z.array(ToolDeclarationSchema).min(1).max(200),
  maxSteps: z.number().int().min(1).max(1_000),
  maxStateBytes: z.number().int().min(1).max(1_048_576),
  maxObservationBytes: z.number().int().min(1).max(262_144),
  operationTimeoutMs: z.number().int().min(1).max(30_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.tools.map(tool => tool.name)).size !== value.tools.length) context.addIssue({ code: "custom", path: ["tools"], message: "Environment tool names must be unique." });
  value.tools.forEach((tool, index) => {
    if (!validateTaskSchema(tool.inputSchema).valid) context.addIssue({ code: "custom", path: ["tools", index, "inputSchema"], message: "Environment tools require a supported JSON schema." });
    if (tool.inputSchemaHash !== contentHash(tool.inputSchema)) context.addIssue({ code: "custom", path: ["tools", index, "inputSchemaHash"], message: "Tool schema identity differs from its declared schema." });
  });
});
export const JavaScriptEnvironmentDefinitionSchema = JavaScriptEnvironmentDefinitionContentSchema.safeExtend({ contentHash: z.string().regex(/^[a-f0-9]{64}$/) });
export type JavaScriptEnvironmentDefinition = z.infer<typeof JavaScriptEnvironmentDefinitionSchema>;

export const JavaScriptEnvironmentOperationSchema = z.enum(["create", "reset", "step", "collect", "destroy"]);
export const JavaScriptEnvironmentResultSchema = z.object({
  state: z.record(z.string(), z.unknown()),
  observation: z.record(z.string(), z.unknown()),
}).strict();
export type JavaScriptEnvironmentResult = z.infer<typeof JavaScriptEnvironmentResultSchema>;
export type JavaScriptEnvironmentOperation = z.infer<typeof JavaScriptEnvironmentOperationSchema>;

export function assertJavaScriptEnvironmentDefinition(value: unknown): JavaScriptEnvironmentDefinition {
  assertBoundedTaskJson(value, 4_194_304);
  const parsed = JavaScriptEnvironmentDefinitionSchema.parse(value);
  const { contentHash: hash, ...content } = parsed;
  if (contentHash(content) !== hash) throw new Error("environment_definition_hash_mismatch");
  return structuredClone(parsed);
}
