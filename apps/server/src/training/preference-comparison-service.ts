import {
  createComparisonAssignment,
  createPreferenceCalibrationReport,
  createPreferenceReceipt,
  createPreferenceRewardComponents,
  type ComparisonAssignmentCandidateInput,
  type HarnessCompatibilityReceipt,
  type PreferenceCalibrationPair,
  type PreferenceCalibrationReport,
  type PreferenceComparisonPurpose,
  type PreferenceComparisonRelease,
  type PreferenceReceipt,
  type PreferenceReviewer,
  type RewardComponentReceipt,
  type TasksetRelease,
} from "@openpond/evals";

import type { SqliteStore } from "../store/store.js";
import type {
  PreferenceComparisonAssignmentRecord,
  PreferenceComparisonReleaseRecord,
} from "./preference-comparison-records.js";
import type { createPreferenceComparisonModelJudge } from "./preference-comparison-model-judge.js";

export type PreferenceComparisonAuthorization = (input: {
  action: "publish" | "review" | "calibrate";
  tasksetId: string;
  reviewerKey: string;
}) => Promise<boolean> | boolean;

export function createPreferenceComparisonService(deps: {
  store: SqliteStore;
  authorize: PreferenceComparisonAuthorization;
  /**
   * Prepared here, but deliberately invoked only by the calibrated hosted
   * review workflow. Keeping the judge at this boundary makes the native
   * artifact path a production dependency without treating it as a generic
   * metadata-only grader.
   */
  modelJudge?: ReturnType<typeof createPreferenceComparisonModelJudge>;
  now?: () => string;
}) {
  const now = deps.now ?? (() => new Date().toISOString());

  async function publishRelease(input: {
    tasksetId: string;
    tasksetRelease: TasksetRelease;
    release: PreferenceComparisonRelease;
    publisherKey: string;
    retentionUntil?: string | null;
  }): Promise<PreferenceComparisonReleaseRecord> {
    await requireAuthorized("publish", input.tasksetId, input.publisherKey);
    const taskset = await deps.store.getTaskset(input.tasksetId);
    if (!taskset) throw new Error("Preference comparison Taskset was not found.");
    if (
      input.release.tasksetRelease.id !== input.tasksetRelease.id
      || input.release.tasksetRelease.contentHash !== input.tasksetRelease.contentHash
    ) {
      throw new Error("Preference comparison release does not belong to the admitted Taskset release.");
    }
    return deps.store.savePreferenceComparisonRelease({
      schemaVersion: "openpond.preferenceComparisonReleaseRecord.v1",
      id: input.release.id,
      tasksetId: input.tasksetId,
      tasksetRelease: input.tasksetRelease,
      release: input.release,
      publishedBy: input.publisherKey,
      sourceConsent: "authorized",
      retentionUntil: input.retentionUntil ?? null,
      createdAt: now(),
    });
  }

  async function createAssignment(input: {
    id: string;
    tasksetId: string;
    comparisonReleaseId: string;
    candidates: readonly ComparisonAssignmentCandidateInput[];
    harnessCompatibilityReceipts?: readonly HarnessCompatibilityReceipt[];
    purpose: PreferenceComparisonPurpose;
    presentedCandidateOrder?: readonly string[];
    creatorKey: string;
  }): Promise<PreferenceComparisonAssignmentRecord> {
    await requireAuthorized("publish", input.tasksetId, input.creatorKey);
    const releaseRecord = await requireRelease(input.tasksetId, input.comparisonReleaseId);
    if (releaseRecord.sourceConsent !== "authorized") {
      throw new Error("Preference comparison source consent has been revoked.");
    }
    const assignment = createComparisonAssignment({
      id: input.id,
      comparisonRelease: releaseRecord.release,
      taskset: releaseRecord.tasksetRelease,
      candidates: input.candidates,
      harnessCompatibilityReceipts: input.harnessCompatibilityReceipts,
      purpose: input.purpose,
      presentedCandidateOrder: input.presentedCandidateOrder,
      createdAt: now(),
    });
    enforceSplitPurpose({ assignment, tasksetRelease: releaseRecord.tasksetRelease });
    return deps.store.savePreferenceComparisonAssignment({
      schemaVersion: "openpond.preferenceComparisonAssignmentRecord.v1",
      id: assignment.id,
      tasksetId: input.tasksetId,
      assignment,
      state: "queued",
      reviewerKey: null,
      unreviewableReason: null,
      createdAt: now(),
      updatedAt: now(),
    });
  }

  async function nextAssignment(input: {
    tasksetId: string;
    reviewerKey: string;
  }): Promise<PreferenceComparisonAssignmentRecord | null> {
    await requireAuthorized("review", input.tasksetId, input.reviewerKey);
    return deps.store.claimNextPreferenceComparisonAssignment({
      tasksetId: input.tasksetId,
      reviewerKey: input.reviewerKey,
      updatedAt: now(),
    });
  }

  async function submitHumanReceipt(input: {
    id: string;
    tasksetId: string;
    assignmentId: string;
    reviewerKey: string;
    reviewer: PreferenceReviewer;
    order: readonly (readonly string[])[];
    rejectAll: boolean;
    criterionScores?: Record<string, Record<string, number>>;
    feedbackArtifactRef?: { id: string; contentHash: string; mediaType: string; sizeBytes: number } | null;
    startedAt: string;
  }): Promise<PreferenceReceipt> {
    await requireAuthorized("review", input.tasksetId, input.reviewerKey);
    if (input.reviewer.kind !== "human") {
      throw new Error("The human review queue only accepts human preference receipts.");
    }
    const assignmentRecord = await requireAssignment(input.tasksetId, input.assignmentId);
    const release = await requireRelease(input.tasksetId, assignmentRecord.assignment.comparisonRelease.id);
    const receipt = createPreferenceReceipt({
      id: input.id,
      assignment: assignmentRecord.assignment,
      comparisonRelease: release.release,
      reviewer: input.reviewer,
      order: input.order,
      rejectAll: input.rejectAll,
      criterionScores: input.criterionScores,
      feedbackArtifactRef: input.feedbackArtifactRef,
      startedAt: input.startedAt,
      completedAt: now(),
    });
    const record = await deps.store.savePreferenceComparisonSubmission({
      schemaVersion: "openpond.preferenceComparisonSubmissionRecord.v1",
      id: receipt.id,
      tasksetId: input.tasksetId,
      assignmentId: assignmentRecord.id,
      reviewerKey: input.reviewerKey,
      receipt,
      submittedAt: now(),
    });
    return record.receipt;
  }

  async function markUnreviewable(input: {
    tasksetId: string;
    assignmentId: string;
    reviewerKey: string;
    reason: string;
  }): Promise<PreferenceComparisonAssignmentRecord> {
    await requireAuthorized("review", input.tasksetId, input.reviewerKey);
    return deps.store.markPreferenceComparisonUnreviewable({
      id: input.assignmentId,
      reviewerKey: input.reviewerKey,
      reason: input.reason,
      updatedAt: now(),
    });
  }

  async function saveCalibration(input: {
    id: string;
    tasksetId: string;
    comparisonReleaseId: string;
    reviewerKey: string;
    pairs: readonly PreferenceCalibrationPair[];
  }): Promise<PreferenceCalibrationReport> {
    await requireAuthorized("calibrate", input.tasksetId, input.reviewerKey);
    const release = await requireRelease(input.tasksetId, input.comparisonReleaseId);
    const report = createPreferenceCalibrationReport({
      id: input.id,
      comparisonRelease: release.release,
      pairs: input.pairs,
      createdAt: now(),
    });
    const saved = await deps.store.savePreferenceComparisonCalibration({
      schemaVersion: "openpond.preferenceComparisonCalibrationRecord.v1",
      id: report.id,
      tasksetId: input.tasksetId,
      report,
      createdAt: now(),
    });
    return saved.report;
  }

  async function projectModelReward(input: {
    tasksetId: string;
    assignmentId: string;
    receipt: PreferenceReceipt;
    candidateEligibility?: Parameters<typeof createPreferenceRewardComponents>[0]["candidates"];
  }): Promise<Record<string, RewardComponentReceipt>> {
    const assignment = await requireAssignment(input.tasksetId, input.assignmentId);
    const release = await requireRelease(input.tasksetId, assignment.assignment.comparisonRelease.id);
    const calibrations = await deps.store.listPreferenceComparisonCalibrations(input.tasksetId);
    const calibration = calibrations.find((record) =>
      record.report.passed
      && record.report.comparisonRelease.id === release.release.id
      && record.report.comparisonRelease.contentHash === release.release.contentHash
      && record.report.automatedReviewer.id === input.receipt.reviewer.releaseRef.id
      && record.report.automatedReviewer.contentHash === input.receipt.reviewer.releaseRef.contentHash,
    )?.report ?? null;
    return createPreferenceRewardComponents({
      assignment: assignment.assignment,
      comparisonRelease: release.release,
      result: input.receipt,
      calibrationReport: calibration,
      candidates: input.candidateEligibility,
    });
  }

  async function requireAuthorized(
    action: "publish" | "review" | "calibrate",
    tasksetId: string,
    reviewerKey: string,
  ): Promise<void> {
    if (!await deps.authorize({ action, tasksetId, reviewerKey })) {
      throw new Error("Preference comparison authorization was denied.");
    }
  }

  async function requireRelease(
    tasksetId: string,
    releaseId: string,
  ): Promise<PreferenceComparisonReleaseRecord> {
    const release = await deps.store.getPreferenceComparisonRelease(releaseId);
    if (!release || release.tasksetId !== tasksetId) {
      throw new Error("Preference comparison release was not found for this Taskset.");
    }
    return release;
  }

  async function requireAssignment(
    tasksetId: string,
    assignmentId: string,
  ): Promise<PreferenceComparisonAssignmentRecord> {
    const assignment = await deps.store.getPreferenceComparisonAssignment(assignmentId);
    if (!assignment || assignment.tasksetId !== tasksetId) {
      throw new Error("Preference comparison assignment was not found for this Taskset.");
    }
    return assignment;
  }

  return {
    publishRelease,
    createAssignment,
    nextAssignment,
    submitHumanReceipt,
    markUnreviewable,
    saveCalibration,
    projectModelReward,
    modelJudge: deps.modelJudge,
  };
}

function enforceSplitPurpose(input: {
  assignment: PreferenceComparisonAssignmentRecord["assignment"];
  tasksetRelease: TasksetRelease;
}): void {
  const task = input.tasksetRelease.tasks.find((candidate) => candidate.id === input.assignment.taskRef.id);
  if (!task) throw new Error("Preference comparison assignment task is absent from the admitted Taskset release.");
  if ((task.split === "frozen_eval") !== (input.assignment.purpose === "frozen_eval")) {
    throw new Error("Frozen-evaluation tasks must use frozen-evaluation comparison assignments and cannot mix with training evidence.");
  }
  if (input.assignment.purpose === "training_reward" && task.split !== "train") {
    throw new Error("Online preference rewards may only be assigned to the Taskset train split.");
  }
  if (input.assignment.purpose === "calibration" && task.split === "frozen_eval") {
    throw new Error("Frozen-evaluation tasks cannot calibrate an automated preference reviewer.");
  }
}
