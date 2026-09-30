import { contentHash } from "@openpond/harness";
import { FeedbackKeySchema } from "@openpond/evals/rewards";
import { ModelTasksetRunRequestSchema } from "./model-taskset-runs-contracts.js";
import { z } from "zod";
import { ExperimentFieldMappingsSchema } from "./experiment-field-mappings.js";

const Id = z.string().trim().min(1).max(200);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ExperimentDefinitionRefSchema = z.object({
  id: Id, revision: z.number().int().positive(), contentHash: Hash,
}).strict();
export const ExperimentGraderPinSchema = z.object({
  id: Id, version: z.string().min(1).max(200), contentHash: Hash,
  feedbackKey: FeedbackKeySchema,
  release: ExperimentDefinitionRefSchema.nullable(),
  mappings: ExperimentFieldMappingsSchema.optional(),
}).strict();
export const ExperimentGraderSelectionSchema = z.object({ id: Id, version: z.string().min(1).max(200), contentHash: Hash, mappings: ExperimentFieldMappingsSchema }).strict();
export const SaveExperimentSchema = z.object({
  operationId: Id,
  id: Id.optional(), expectedRevision: z.number().int().nonnegative(),
  request: ModelTasksetRunRequestSchema,
  maximumCostUsd: z.number().finite().positive().max(10_000),
  graders: z.array(ExperimentGraderSelectionSchema).min(1).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.request.name) ctx.addIssue({ code: "custom", path: ["request", "name"], message: "Name this Experiment before saving it." });
  if (Boolean(value.id) !== (value.expectedRevision > 0)) ctx.addIssue({ code: "custom", path: ["expectedRevision"], message: "An update requires its saved definition revision." });
  if (Math.round(value.maximumCostUsd * 1_000_000) < 1) ctx.addIssue({ code: "custom", path: ["maximumCostUsd"], message: "The budget must be at least $0.000001." });
  if (value.graders && new Set(value.graders.map(grader => grader.id)).size !== value.graders.length) ctx.addIssue({ code: "custom", path: ["graders"], message: "Select each grader once." });
});
const DefinitionContent = z.object({
  schemaVersion: z.literal("openpond.experimentDefinition.v1"),
  id: Id, teamId: Id, revision: z.number().int().positive(),
  request: ModelTasksetRunRequestSchema,
  maximumCostUsd: z.number().finite().positive().max(10_000),
  graders: z.array(ExperimentGraderPinSchema).min(1).max(100),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export const ExperimentDefinitionSchema = DefinitionContent.extend({ contentHash: Hash });
export type ExperimentDefinition = z.infer<typeof ExperimentDefinitionSchema>;
export type ExperimentDefinitionRef = z.infer<typeof ExperimentDefinitionRefSchema>;
export const StartExperimentSchema = z.object({ operationId: Id, definition: ExperimentDefinitionRefSchema }).strict();
export const ExperimentListQuerySchema = z.object({
  projectId: Id.optional(), datasetHash: Hash.optional(), search: z.string().trim().max(200).optional(),
  afterId: Id.optional(), limit: z.number().int().min(1).max(100).default(30),
}).strict();
export const ExperimentExecutionContextSchema = z.object({
  definition: ExperimentDefinitionRefSchema, maximumCostUsd: z.number().finite().positive().max(10_000),
  graders: z.array(ExperimentGraderPinSchema).min(1).max(100),
}).strict();
export type ExperimentExecutionContext = z.infer<typeof ExperimentExecutionContextSchema>;

export function verifyExperimentDefinition(value: unknown): ExperimentDefinition {
  const parsed = ExperimentDefinitionSchema.parse(value);
  const { contentHash: actual, ...content } = parsed;
  if (actual !== contentHash(content) || parsed.request.teamId !== parsed.teamId || !parsed.request.name)
    throw new Error("Experiment definition differs from its immutable content.");
  if (new Set(parsed.graders.map(item => item.feedbackKey)).size !== parsed.graders.length)
    throw new Error("Experiment feedback keys must be distinct.");
  return parsed;
}

export const experimentDefinitionRef = (value: ExperimentDefinition): ExperimentDefinitionRef => ({
  id: value.id, revision: value.revision, contentHash: value.contentHash,
});
