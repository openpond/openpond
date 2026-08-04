import { z } from "zod";

import { ImmutableReleaseRefSchema, ReleaseHashSchema } from "../common.js";
import {
  EvidenceArtifactRefSchema,
  WorkEvidenceReceiptSchema,
  evidenceArtifactRef,
  type WorkEvidenceReceipt,
} from "./contracts.js";
import { WorkEvidenceEligibilitySchema, type WorkEvidenceEligibility } from "./eligibility.js";

export const WorkEvidenceAuthoringInputSchema = z.object({
  schemaVersion: z.literal("openpond.workEvidenceAuthoringInput.v1"),
  evidenceReceiptRef: EvidenceArtifactRefSchema,
  inputHash: ReleaseHashSchema,
  agentSnapshot: ImmutableReleaseRefSchema.nullable(),
  sanitizedTraceRef: EvidenceArtifactRefSchema,
  outputRefs: z.array(EvidenceArtifactRefSchema).max(10_000),
  validationEvidenceRefs: z.array(EvidenceArtifactRefSchema).max(10_000),
  incomplete: z.boolean(),
  evalCandidate: z.boolean(),
  blockerCodes: z.array(z.string().trim().min(1).max(120)).max(32),
}).strict();

export function toWorkEvidenceAuthoringInput(
  evidenceInput: WorkEvidenceReceipt,
  eligibilityInput: WorkEvidenceEligibility,
): WorkEvidenceAuthoringInput {
  const evidence = WorkEvidenceReceiptSchema.parse(evidenceInput);
  const eligibility = WorkEvidenceEligibilitySchema.parse(eligibilityInput);
  if (eligibility.evidenceReceiptHash !== evidence.contentHash) {
    throw new Error("Eligibility report belongs to a different Work evidence receipt.");
  }
  const receiptRef = evidenceArtifactRef({
    contentHash: evidence.contentHash,
    mediaType: "application/vnd.openpond.work-evidence+json",
    sizeBytes: null,
  });
  return WorkEvidenceAuthoringInputSchema.parse({
    schemaVersion: "openpond.workEvidenceAuthoringInput.v1",
    evidenceReceiptRef: receiptRef,
    inputHash: evidence.inputHash,
    agentSnapshot: evidence.agentSnapshot,
    sanitizedTraceRef: evidence.trace.sanitizedRef,
    outputRefs: evidence.outputRefs,
    validationEvidenceRefs: evidence.validationEvidenceRefs,
    incomplete: evidence.trace.incomplete,
    evalCandidate: eligibility.decisions.eval_candidate.eligible,
    blockerCodes: eligibility.decisions.eval_candidate.blockers,
  });
}

export type WorkEvidenceAuthoringInput = z.infer<typeof WorkEvidenceAuthoringInputSchema>;
