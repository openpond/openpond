import {
  CreateImproveEvidenceSnapshotSchema,
  CreateImproveTasksetRefSchema,
  type CreateImproveEvidenceSnapshot,
  type CreateImproveTasksetRef,
  type CreateImproveTargetKind,
  type CreateImproveRun,
  type TaskDesignProposal,
  type Taskset,
  type TrainingSourceRef,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

export function createEvidenceSnapshot(input: {
  objective: string;
  sources: TrainingSourceRef[];
  timestamp: string;
}): CreateImproveEvidenceSnapshot {
  const sources = input.sources.length
    ? input.sources.map((source) => ({
        kind: "conversation" as const,
        id: source.id,
        sourceHash: source.sourceHash,
        excerptRef: `training-source:${source.id}`,
      }))
    : [{
        kind: "manual_intent" as const,
        id: `manual_intent_${contentHash(input.objective).slice(0, 24)}`,
        sourceHash: contentHash({ objective: input.objective }),
        excerptRef: null,
      }];
  const snapshotContent = {
    consent: {
      status: "granted" as const,
      scope: input.sources.length ? "selected_turns" as const : "direct_intent" as const,
      reviewedBy: "local_user",
      reviewedAt: input.timestamp,
    },
    sources,
    reviewerIntent: input.objective,
  };
  const snapshotHash = contentHash(snapshotContent);
  return CreateImproveEvidenceSnapshotSchema.parse({
    schemaVersion: "openpond.createImprove.evidenceSnapshot.v1",
    id: `evidence_snapshot_${snapshotHash.slice(0, 24)}`,
    contentHash: snapshotHash,
    ...snapshotContent,
    createdAt: input.timestamp,
    metadata: {
      immutable: true,
      sourceCount: sources.length,
    },
  });
}

export function createOutcomeEvidenceSnapshot(input: {
  run: CreateImproveRun;
  candidateId: string;
  outcome: "released" | "rejected";
  reason: string;
  receiptRefs: string[];
  timestamp: string;
}): CreateImproveEvidenceSnapshot {
  const outcomeContent = {
    runId: input.run.id,
    candidateId: input.candidateId,
    tasksetId: input.run.tasksetRef?.id ?? null,
    tasksetRevision: input.run.tasksetRef?.revision ?? null,
    tasksetHash: input.run.tasksetRef?.contentHash ?? null,
    outcome: input.outcome,
    reason: input.reason,
    receiptRefs: input.receiptRefs,
  };
  const outcomeHash = contentHash(outcomeContent);
  return CreateImproveEvidenceSnapshotSchema.parse({
    schemaVersion: "openpond.createImprove.evidenceSnapshot.v1",
    id: `evidence_outcome_${outcomeHash.slice(0, 24)}`,
    contentHash: outcomeHash,
    consent: {
      status: "granted",
      scope: "direct_intent",
      reviewedBy: input.run.actor.id ?? "local_user",
      reviewedAt: input.timestamp,
    },
    sources: [{
      kind: "artifact",
      id: `${input.outcome}:${input.run.id}:${input.candidateId}`,
      sourceHash: outcomeHash,
      excerptRef: input.receiptRefs[0] ?? null,
    }],
    reviewerIntent: input.reason,
    createdAt: input.timestamp,
    metadata: {
      immutable: true,
      evidenceKind: "candidate_outcome",
      outcome: input.outcome,
      priorTasksetRevision: input.run.tasksetRef?.revision ?? null,
      recommendedNextTasksetRevision: input.run.tasksetRef
        ? input.run.tasksetRef.revision + 1
        : 1,
      receiptRefs: input.receiptRefs,
    },
  });
}

export function createTasksetRef(input: {
  taskset: Taskset;
  proposal?: TaskDesignProposal | null;
  evidenceSnapshotIds: string[];
  approvedAt: string;
}): CreateImproveTasksetRef {
  const targetRecommendation = input.proposal
    ? recommendationForProposal(input.proposal)
    : {
        kind: "model" as const,
        rationale: ["A reviewed training plan selected Model execution for this Taskset."],
        confidence: 1,
      };
  return CreateImproveTasksetRefSchema.parse({
    schemaVersion: "openpond.createImprove.tasksetRef.v1",
    id: input.taskset.id,
    revision: input.taskset.revision,
    contentHash: input.taskset.contentHash,
    evidenceSnapshotIds: input.evidenceSnapshotIds,
    policyBoundary: input.taskset.policy,
    targetRecommendation,
    authoringSplitRefs: input.taskset.tasks
      .filter((task) => task.split === "train" || task.split === "validation")
      .map((task) => task.id),
    privateSplitRefs: input.taskset.tasks
      .filter((task) => task.split === "test" || task.split === "frozen_eval")
      .map((task) => task.id),
    approvedBy: "local_user",
    approvedAt: input.approvedAt,
    metadata: {
      immutable: true,
      taskCreationProposalId: input.proposal?.id ?? null,
    },
  });
}

export function assertTasksetRefMatches(
  ref: CreateImproveTasksetRef,
  taskset: Taskset,
): void {
  if (
    ref.id !== taskset.id ||
    ref.revision !== taskset.revision ||
    ref.contentHash !== taskset.contentHash
  ) {
    throw new Error(
      `Taskset lineage mismatch: the run approved ${ref.id}@${ref.revision} (${ref.contentHash}), ` +
      `but execution resolved ${taskset.id}@${taskset.revision} (${taskset.contentHash}).`,
    );
  }
}

function recommendationForProposal(
  proposal: TaskDesignProposal,
): CreateImproveTasksetRef["targetRecommendation"] {
  const kind = targetKindForProposal(proposal);
  return {
    kind,
    rationale: proposal.diagnosis.rationale.length
      ? proposal.diagnosis.rationale
      : [`${kind} best matches the reviewed behavior boundary.`],
    confidence: proposal.diagnosis.confidence,
  };
}

function targetKindForProposal(proposal: TaskDesignProposal): CreateImproveTargetKind {
  if (proposal.diagnosis.trainingEligible) return "model";
  if (proposal.diagnosis.intervention === "retrieval") return "configuration";
  return "agent";
}
