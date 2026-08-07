import type {
  HarnessImprovementProposal,
  HarnessRefinerOutcome,
  HarnessTargetedValidationReceipt,
  RefinementTriggerDecision,
} from "@openpond/harness";
import { stableId } from "@openpond/harness/refiner-support";

import type { SqliteStore } from "../store/store.js";

export {
  boundedObservationEvidence,
  boundedTriggerEvidence,
  expectedMemoryRevision,
  memoryKeyFromTarget,
  overlayRef,
  proposalEvidence,
  sameOverlayRef,
  sameWorkspaceRevision,
  stableId,
  uniqueEventRefs,
} from "@openpond/harness/refiner-support";

export async function findRefinerOutcome(
  store: SqliteStore,
  workspaceId: string,
  trigger: RefinementTriggerDecision,
): Promise<HarnessRefinerOutcome | null> {
  const outcomes = await store.listHarnessImprovementArtifacts(
    workspaceId,
    "refiner_outcome",
    1_000,
  );
  return (outcomes as HarnessRefinerOutcome[]).find(
    (outcome) => outcome.trigger.id === trigger.id &&
      outcome.trigger.contentHash === trigger.contentHash,
  ) ?? null;
}

export async function findProposal(
  store: SqliteStore,
  workspaceId: string,
  proposalId: string,
): Promise<HarnessImprovementProposal | null> {
  const proposals = await store.listHarnessImprovementArtifacts(
    workspaceId,
    "proposal",
    1_000,
  );
  return (proposals as HarnessImprovementProposal[]).find(
    (proposal) => proposal.id === proposalId,
  ) ?? null;
}

export async function findProposalByTrigger(
  store: SqliteStore,
  workspaceId: string,
  trigger: RefinementTriggerDecision,
): Promise<HarnessImprovementProposal | null> {
  const proposal = await findProposal(
    store,
    workspaceId,
    stableId("proposal", trigger.contentHash),
  );
  const metadataTrigger = proposal?.metadata.trigger as
    | { id?: unknown; contentHash?: unknown }
    | undefined;
  return metadataTrigger?.id === trigger.id &&
    metadataTrigger.contentHash === trigger.contentHash
    ? proposal
    : null;
}

export async function findProposalValidations(
  store: SqliteStore,
  workspaceId: string,
  proposal: HarnessImprovementProposal,
): Promise<HarnessTargetedValidationReceipt[]> {
  const validations = await store.listHarnessImprovementArtifacts(
    workspaceId,
    "targeted_validation",
    1_000,
  );
  return (validations as HarnessTargetedValidationReceipt[]).filter(
    (validation) => validation.proposal.id === proposal.id &&
      validation.proposal.contentHash === proposal.contentHash,
  );
}
