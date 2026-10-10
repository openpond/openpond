import { z } from "zod";
import { DatasetPreparationTaskClassSchema, PreparedTaskEvidenceSpanSchema } from "./dataset-preparation-contracts.js";

const Id = z.string().trim().min(1).max(240);
const Text = z.string().trim().min(1).max(5_000);
export const DatasetPreparationResearchCandidateSchema = z.object({
  taskClass: DatasetPreparationTaskClassSchema,
  objective: z.string().trim().min(1).max(20_000),
  sourceSpans: z.array(PreparedTaskEvidenceSpanSchema).min(1).max(200),
  firstAvailableAt: z.iso.datetime(),
  reconstruction: z.object({
    kind: z.enum(["text_only", "pinned_repository", "pinned_artifact", "unsupported"]),
    requiredAssets: z.array(z.object({ reference: Text, evidence: PreparedTaskEvidenceSpanSchema }).strict()).max(100),
    missingEvidence: z.array(Text).max(20),
  }).strict(),
  assessment: z.object({
    kind: z.enum(["executable", "calibrated_judge", "unsupported"]),
    requirements: z.array(z.object({ criterion: Text, evidence: PreparedTaskEvidenceSpanSchema }).strict()).min(1).max(20),
    limitations: z.array(Text).max(20),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (!value.sourceSpans.some((span) => span.role === "requirement"))
    ctx.addIssue({ code: "custom", message: "A research candidate requires independently retained user requirements." });
  if (value.assessment.requirements.some((item) => item.evidence.role !== "requirement"))
    ctx.addIssue({ code: "custom", message: "Assessment criteria must cite user requirements, not historical answers." });
});

/** Each chunk replaces the coherent accumulated decision for that exact
 * conversation revision. It is a proposal, never qualification evidence. */
export const DatasetPreparationResearchDecisionSchema = z.object({
  schemaVersion: z.literal("openpond.datasetPreparationResearchDecision.v1"),
  sourceId: Id,
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  candidates: z.array(DatasetPreparationResearchCandidateSchema).max(100),
  exclusions: z.array(z.object({ code: Id, reason: Text, sourceSpans: z.array(PreparedTaskEvidenceSpanSchema).max(200) }).strict()).max(100),
  contextSummary: z.string().max(20_000),
}).strict();
export type DatasetPreparationResearchCandidate = z.infer<typeof DatasetPreparationResearchCandidateSchema>;
export type DatasetPreparationResearchDecision = z.infer<typeof DatasetPreparationResearchDecisionSchema>;
