import { z } from "zod";
import { ReleaseIdSchema } from "@openpond/harness";
import { LearningCommandSchema } from "./operations.js";
import { LearningResourceKindSchema, learningResourceSchemas } from "./repository.js";
import { assertBoundedTaskJson } from "../task-schema.js";
import { LearningDomainError } from "./errors.js";

/** Run before recursive schema parsing, including for non-TypeScript producers. */
export function assertLearningRequestJson(raw: unknown): void {
  try { assertBoundedTaskJson(raw, 16_777_216); }
  catch (error) { throw new LearningDomainError("learning_json_invalid", 400, error instanceof Error ? error.message : "Expected bounded JSON."); }
}

/** Scope selection is never authorization; each host resolves its authenticated owner. */
export const LearningCommandRequestSchema = z.object({ scope: ReleaseIdSchema, command: LearningCommandSchema }).strict();
export const LearningReadRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("get"), scope: ReleaseIdSchema, kind: LearningResourceKindSchema, id: ReleaseIdSchema, revision: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal("list"), scope: ReleaseIdSchema, kind: LearningResourceKindSchema, parentId: ReleaseIdSchema.optional(), status: z.string().min(1).max(200).optional(), afterId: ReleaseIdSchema.optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
]);
export const LearningOperationResultSchema = z.object({
  operationId: ReleaseIdSchema,
  resources: z.array(z.union(Object.values(learningResourceSchemas))).max(100),
}).strict();
