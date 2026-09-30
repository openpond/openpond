import { z } from "zod";
import { contentHash, ImmutableReleaseRefSchema } from "@openpond/harness";
import { RewardReleaseRefSchema } from "@openpond/evals/rewards";
import { ExperimentGraderPinSchema } from "./experiment-contracts.js";
import { ExperimentFieldMappingsSchema } from "./experiment-field-mappings.js";

const Id = z.string().trim().min(1).max(200);
export const ExperimentScoringRequestSchema = z.object({
  operationId: Id,
  execution: ImmutableReleaseRefSchema,
  graders: z.array(RewardReleaseRefSchema).min(1).max(100),
  maximumCostUsd: z.number().finite().min(0.000001).max(10_000),
  mappings: z.array(z.object({ graderId: Id, fields: ExperimentFieldMappingsSchema }).strict()).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.graders.map(grader => grader.id)).size !== value.graders.length)
    context.addIssue({ code: "custom", path: ["graders"], message: "Select each grader once." });
  if (value.mappings && (new Set(value.mappings.map(mapping => mapping.graderId)).size !== value.mappings.length
    || value.mappings.some(mapping => !value.graders.some(grader => grader.id === mapping.graderId))))
    context.addIssue({ code: "custom", path: ["mappings"], message: "Map each selected grader at most once." });
});
export type ExperimentScoringRequest = z.infer<typeof ExperimentScoringRequestSchema>;

const ScoringPassContent = z.object({
  schemaVersion: z.literal("openpond.experimentScoringPass.v1"),
  id: Id, teamId: Id, revision: z.number().int().positive(),
  request: ExperimentScoringRequestSchema,
  graders: z.array(ExperimentGraderPinSchema).min(1).max(100),
  status: z.enum(["queued", "running", "cancelling", "completed", "failed", "cancelled"]),
  totalCount: z.number().int().min(1).max(10_000),
  counts: z.object({ pending: z.number().int().nonnegative(), running: z.number().int().nonnegative(),
    scored: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative() }).strict(),
  resultAvailable: z.boolean(), createdAt: z.iso.datetime(), startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  error: z.object({ code: Id, message: z.string().max(2_000) }).strict().nullable(),
}).strict();
export const ExperimentScoringPassSchema = ScoringPassContent.extend({ contentHash: z.string().regex(/^[a-f0-9]{64}$/) });
export type ExperimentScoringPass = z.infer<typeof ExperimentScoringPassSchema>;

/** A pass grades owned output and carries no model-execution authority. */
export function verifyExperimentScoringPass(value: unknown) {
  const pass = ExperimentScoringPassSchema.parse(value);
  const { contentHash: actual, ...content } = pass;
  if (contentHash(content) !== actual || Object.values(pass.counts).reduce((sum, count) => sum + count, 0) !== pass.totalCount)
    throw new Error("Scoring pass integrity or population accounting failed.");
  const terminal = ["completed", "failed", "cancelled"].includes(pass.status);
  if (terminal && (!pass.completedAt || pass.counts.pending || pass.counts.running)
    || !terminal && (pass.completedAt !== null || pass.resultAvailable)
    || pass.status === "completed" && !pass.resultAvailable)
    throw new Error("Scoring pass lifecycle differs from its retained result.");
  if (pass.graders.length !== pass.request.graders.length || new Set(pass.graders.map(grader => grader.feedbackKey)).size !== pass.graders.length
    || pass.graders.some((grader, index) => contentHash(grader.release) !== contentHash(pass.request.graders[index]!)
      || contentHash(grader.mappings ?? []) !== contentHash(pass.request.mappings?.find(mapping => mapping.graderId === grader.release?.id)?.fields ?? [])))
    throw new Error("Scoring pass graders differ from their exact admission.");
  return pass;
}
