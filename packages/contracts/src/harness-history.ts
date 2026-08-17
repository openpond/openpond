import type {
  HarnessAdvanceReceipt,
  HarnessImprovementProposal,
  HarnessTargetedValidationReceipt,
  HarnessWorkspace,
} from "./harness-workspaces.js";
import type {
  HarnessRefinerOutcome,
  ImprovementApplyReceipt,
  ImprovementRouteDecision,
  RefinementTriggerDecision,
} from "./harness-improvements.js";
import type { HarnessMemoryEntry } from "./harness-memory.js";
import type { HarnessEvaluationReviewReceipt } from "@openpond/harness/evaluation-review";
import type { HarnessRefinementCandidate } from "@openpond/harness/refinement-lifecycle";
import type { ModelImprovementQualificationReceipt } from "@openpond/evals/model-improvement-qualification";
import type { WorkspaceDiffFile } from "./workspaces.js";

export type HarnessHistoryReleaseRef = {
  id: string;
  contentHash: string;
};

export type HarnessHistoryReleaseSummary = {
  id: string;
  contentHash: string;
  sourceRevision: string;
  createdAt: string;
  current: boolean;
  files: Array<{
    id: string;
    path: string;
    contentHash: string;
    sizeBytes: number;
    mediaType: string;
  }>;
};

export type HarnessHistoryChange = {
  receipt: HarnessAdvanceReceipt;
  proposal: HarnessImprovementProposal | null;
  validations: HarnessTargetedValidationReceipt[];
  routeDecision: ImprovementRouteDecision | null;
  applyReceipt: ImprovementApplyReceipt | null;
  outcome: HarnessRefinerOutcome | null;
  trigger: RefinementTriggerDecision | null;
};

export type HarnessHistoryRoute = {
  decision: ImprovementRouteDecision;
  trigger: RefinementTriggerDecision | null;
  outcome: HarnessRefinerOutcome | null;
};

export type HarnessHistoryPendingReview = {
  proposal: HarnessImprovementProposal;
  validations: HarnessTargetedValidationReceipt[];
  applyReceipt: ImprovementApplyReceipt | null;
  outcome: HarnessRefinerOutcome | null;
  trigger: RefinementTriggerDecision | null;
};

export type HarnessHistoryPayload = {
  workspace: HarnessWorkspace | null;
  backgroundReview: {
    enabled: boolean;
    updatedAt: string | null;
  };
  evaluationReviewSchedule: HarnessEvaluationReviewSchedule;
  releases: HarnessHistoryReleaseSummary[];
  changes: HarnessHistoryChange[];
  routes: HarnessHistoryRoute[];
  evaluationReviews: HarnessEvaluationReviewReceipt[];
  refinementCandidates: HarnessRefinementCandidate[];
  modelImprovementQualifications: ModelImprovementQualificationReceipt[];
  pendingReviews: HarnessHistoryPendingReview[];
  memories: HarnessMemoryEntry[];
};

export type HarnessEvaluationReviewCadence = "manual" | "daily" | "weekly";

export type HarnessEvaluationReviewSchedule = {
  enabled: boolean;
  activityEnabled: boolean;
  activityBatchSize: number;
  cadence: HarnessEvaluationReviewCadence;
  maxEstimatedCostUsd: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: {
    id: string;
    contentHash: string;
    classification: HarnessEvaluationReviewReceipt["classification"];
  } | null;
  lastError: string | null;
  updatedAt: string | null;
};

export type HarnessEvaluationReviewRequest = {
  workspaceId: string;
  maxEstimatedCostUsd?: number;
};

export type HarnessEvaluationReviewResponse = {
  receipt: HarnessEvaluationReviewReceipt;
  history: HarnessHistoryPayload;
};

export type HarnessEvaluationReviewScheduleRequest = {
  workspaceId: string;
  enabled: boolean;
  activityEnabled: boolean;
  activityBatchSize: number;
  cadence: HarnessEvaluationReviewCadence;
  maxEstimatedCostUsd: number;
};

export type HarnessEvaluationReviewScheduleResponse = {
  history: HarnessHistoryPayload;
};

export type HarnessBackgroundReviewRequest = {
  workspaceId: string;
  enabled: boolean;
};

export type HarnessBackgroundReviewResponse = {
  history: HarnessHistoryPayload;
};

export type HarnessReleaseDiffRequest = {
  workspaceId: string;
  baseRelease: HarnessHistoryReleaseRef | null;
  targetRelease: HarnessHistoryReleaseRef;
};

export type HarnessReleaseDiffPayload = {
  baseRelease: HarnessHistoryReleaseRef | null;
  targetRelease: HarnessHistoryReleaseRef;
  filesChanged: number;
  additions: number;
  deletions: number;
  files: WorkspaceDiffFile[];
};

export type HarnessRollbackRequest = {
  workspaceId: string;
  targetRelease: { id: string; contentHash: string };
};

export type HarnessRollbackResponse = {
  receipt: HarnessAdvanceReceipt;
  history: HarnessHistoryPayload;
};

export type HarnessProposalReviewRequest = {
  workspaceId: string;
  proposal: { id: string; contentHash: string };
  decision: "approve" | "decline";
};

export type HarnessProposalReviewResponse = {
  history: HarnessHistoryPayload;
  receipt: HarnessAdvanceReceipt | ImprovementApplyReceipt;
};
