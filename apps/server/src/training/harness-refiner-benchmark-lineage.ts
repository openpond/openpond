import {
  type HarnessImprovementProposal,
  type HarnessTargetedValidationReceipt,
} from "@openpond/contracts";
import { contentHash } from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";
import type { SequentialAdaptationStep } from
  "./harness-refiner-benchmark-protocol.js";
import type { BenchmarkAttemptEvidence } from
  "./harness-refiner-benchmark-service-support.js";

export type BenchmarkLineage = {
  adaptationEvidenceHash: string;
  refinerInputHash: string;
  refinerOutcomeHash: string;
  validationHash: string;
  applyReceiptHash: string;
  candidateRelease: { id: string; contentHash: string };
  valid: boolean;
};

export async function benchmarkLineage(input: {
  store: SqliteStore;
  workspaceId: string;
  adaptationAttempts: BenchmarkAttemptEvidence[];
  completedSteps: SequentialAdaptationStep[];
  candidateRelease: { id: string; contentHash: string };
  refinerInputHash: string;
}): Promise<BenchmarkLineage> {
  const [outcomes, rawProposals, rawValidations, applyReceipts] = await Promise.all([
    input.store.listHarnessImprovementArtifacts(
      input.workspaceId,
      "refiner_outcome",
      1_000,
    ),
    input.store.listHarnessImprovementArtifacts(
      input.workspaceId,
      "proposal",
      1_000,
    ),
    input.store.listHarnessImprovementArtifacts(
      input.workspaceId,
      "targeted_validation",
      10_000,
    ),
    input.store.listHarnessImprovementArtifacts(
      input.workspaceId,
      "apply_receipt",
      1_000,
    ),
  ]);
  const proposals = rawProposals as HarnessImprovementProposal[];
  const validations = rawValidations as HarnessTargetedValidationReceipt[];
  const adaptationEvidenceHash = contentHash(input.adaptationAttempts.map((result) => ({
    attempt: result.attempt.id,
    receipt: result.receiptContentHash,
    grade: contentHash(result.grade),
  })));
  const requiredValidationsPassed = proposals.every((proposal) =>
    proposal.validationPlan
      .filter((plan) => plan.required)
      .every((plan) => validations.some(
        (validation) => validation.validationId === plan.id && validation.status === "passed",
      ))
  );
  const proposalHashes = new Set(
    proposals.map((proposal) => proposal.contentHash),
  );
  const appliedProposalHashes = new Set(applyReceipts.flatMap((artifact) => {
    const proposal = "proposal" in artifact ? artifact.proposal : null;
    return proposal && typeof proposal === "object" && "contentHash" in proposal
      ? [String(proposal.contentHash)]
      : [];
  }));
  const everyProposalHasReceipt = [...proposalHashes].every((hash) =>
    appliedProposalHashes.has(hash)
  );
  return {
    adaptationEvidenceHash,
    refinerInputHash: input.refinerInputHash,
    refinerOutcomeHash: contentHash(outcomes),
    validationHash: contentHash(validations),
    applyReceiptHash: contentHash(applyReceipts),
    candidateRelease: {
      id: input.candidateRelease.id,
      contentHash: input.candidateRelease.contentHash,
    },
    valid:
      outcomes.length === input.completedSteps.filter((step) => step.outcome).length
      && requiredValidationsPassed
      && everyProposalHasReceipt,
  };
}
