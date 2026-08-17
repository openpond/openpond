import {
  HarnessImprovementProposalSchema,
  HarnessEvaluationReviewReceiptSchema,
  HarnessCrossRunRefinementRequestSchema,
  HarnessRefinementCandidateLifecycleReceiptSchema,
  HarnessRefinementCandidateSchema,
  HarnessOverlayMergeReceiptSchema,
  HarnessRefinerOutcomeSchema,
  HarnessRunOverlaySchema,
  HarnessTargetedValidationReceiptSchema,
  ImprovementApplyReceiptSchema,
  ImprovementObservationSchema,
  ImprovementRouteDecisionSchema,
  RefinementTriggerDecisionSchema,
  type HarnessImprovementProposal,
  type HarnessEvaluationReviewReceipt,
  type HarnessCrossRunRefinementRequest,
  type HarnessRefinementCandidate,
  type HarnessRefinementCandidateLifecycleReceipt,
  type HarnessOverlayMergeReceipt,
  type HarnessRefinerOutcome,
  type HarnessRunOverlay,
  type HarnessTargetedValidationReceipt,
  type HarnessWorkspace,
  type ImprovementApplyReceipt,
  type ImprovementObservation,
  type ImprovementRouteDecision,
  type RefinementTriggerDecision,
} from "@openpond/contracts";
import {
  ModelImprovementQualificationReceiptSchema,
  type ModelImprovementQualificationReceipt,
} from "@openpond/evals";

import type { LocalHarnessReleaseRecord } from "./store-harness-release-record.js";

export type HarnessImprovementArtifact =
  | HarnessRunOverlay
  | HarnessEvaluationReviewReceipt
  | HarnessRefinementCandidate
  | HarnessRefinementCandidateLifecycleReceipt
  | HarnessCrossRunRefinementRequest
  | ModelImprovementQualificationReceipt
  | HarnessImprovementProposal
  | HarnessTargetedValidationReceipt
  | HarnessOverlayMergeReceipt
  | ImprovementObservation
  | RefinementTriggerDecision
  | ImprovementRouteDecision
  | ImprovementApplyReceipt
  | HarnessRefinerOutcome;

export type HarnessImprovementArtifactKind =
  | "run_overlay"
  | "evaluation_review"
  | "refinement_candidate"
  | "refinement_candidate_lifecycle"
  | "cross_run_refinement_request"
  | "training_qualification"
  | "proposal"
  | "targeted_validation"
  | "merge_receipt"
  | "observation"
  | "trigger_decision"
  | "route_decision"
  | "apply_receipt"
  | "refiner_outcome";

export const HARNESS_IMPROVEMENT_ARTIFACT_SCHEMAS = {
  run_overlay: HarnessRunOverlaySchema,
  evaluation_review: HarnessEvaluationReviewReceiptSchema,
  refinement_candidate: HarnessRefinementCandidateSchema,
  refinement_candidate_lifecycle: HarnessRefinementCandidateLifecycleReceiptSchema,
  cross_run_refinement_request: HarnessCrossRunRefinementRequestSchema,
  training_qualification: ModelImprovementQualificationReceiptSchema,
  proposal: HarnessImprovementProposalSchema,
  targeted_validation: HarnessTargetedValidationReceiptSchema,
  merge_receipt: HarnessOverlayMergeReceiptSchema,
  observation: ImprovementObservationSchema,
  trigger_decision: RefinementTriggerDecisionSchema,
  route_decision: ImprovementRouteDecisionSchema,
  apply_receipt: ImprovementApplyReceiptSchema,
  refiner_outcome: HarnessRefinerOutcomeSchema,
} as const;

export function harnessWorkspaceParams(workspace: HarnessWorkspace): unknown[] {
  return [
    workspace.id,
    workspace.ownerScope.kind,
    workspace.ownerScope.id,
    workspace.location,
    workspace.revision,
    workspace.sourceRevision,
    workspace.currentChannel.revision,
    workspace.currentChannel.release?.contentHash ?? null,
    JSON.stringify(workspace),
    workspace.createdAt,
    workspace.updatedAt,
  ];
}

export function immutableHarnessReleaseRecord(
  record: LocalHarnessReleaseRecord,
): Omit<LocalHarnessReleaseRecord, "createdAt"> {
  const { createdAt: _createdAt, ...immutable } = record;
  return immutable;
}
