import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  ArtifactManifestSchema,
  AttemptReceiptSchema,
  ComparisonAssignmentSchema,
  RunManifestSchema,
  validateComparisonAssignment,
  verifyArtifactManifest,
  verifyAttemptReceipt,
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
import {
  TaskAttemptArtifactSchema,
  TaskAttemptResultSchema,
} from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";
import type { ChatModelRef } from "@openpond/contracts";
import { contentHash } from "@openpond/harness";
import { sha256 } from "@openpond/taskset-sdk";
import { z } from "zod";
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
  storeDir: string;
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

  async function submitModelReceipt(input: {
    id: string;
    tasksetId: string;
    assignmentId: string;
    actorKey: string;
    model: ChatModelRef;
    rubric: string;
    reviewVariant?: "canonical" | "order_swap";
    signal: AbortSignal;
  }) {
    await requireAuthorized("calibrate", input.tasksetId, input.actorKey);
    if (!deps.modelJudge) throw new Error("Preference model review is unavailable in this server build.");
    const assignmentRecord = await requireAssignment(input.tasksetId, input.assignmentId);
    const release = await requireRelease(input.tasksetId, assignmentRecord.assignment.comparisonRelease.id);
    if (contentHash(input.rubric) !== release.release.rubricRef.contentHash) {
      throw new Error("Preference model review rubric does not match the immutable comparison release.");
    }
    const taskset = await deps.store.getTaskset(input.tasksetId);
    const task = taskset?.tasks.find((candidate) => candidate.id === assignmentRecord.assignment.taskRef.id) ?? null;
    const reviewer = modelReviewer(input.model);
    const reviewerKey = `${reviewer.releaseRef.id}:${reviewer.releaseRef.contentHash}`;
    const reviewVariant = input.reviewVariant ?? "canonical";
    const outcome = await deps.modelJudge.judge({
      id: input.id,
      assignment: assignmentRecord.assignment,
      comparisonRelease: release.release,
      reviewer,
      model: input.model,
      rubric: input.rubric,
      taskPrompt: typeof task?.input.prompt === "string" ? task.input.prompt : null,
      ...(reviewVariant === "order_swap"
        ? { presentedCandidateOrder: [...assignmentRecord.assignment.presentedCandidateOrder].reverse() }
        : {}),
      signal: input.signal,
    });
    if (outcome.status === "unscorable") return outcome;
    const record = await deps.store.savePreferenceComparisonSubmission({
      schemaVersion: "openpond.preferenceComparisonSubmissionRecord.v1",
      id: outcome.receipt.id,
      tasksetId: input.tasksetId,
      assignmentId: input.assignmentId,
      reviewerKey: modelSubmissionKey(reviewerKey, reviewVariant),
      receipt: outcome.receipt,
      submittedAt: now(),
    });
    return { ...outcome, receipt: record.receipt };
  }

  async function importManagedCalibrationBatch(input: {
    tasksetId: string;
    importerKey: string;
    batch: unknown;
  }): Promise<PreferenceComparisonAssignmentRecord> {
    await requireAuthorized("publish", input.tasksetId, input.importerKey);
    const parsed = ManagedCalibrationBatchSchema.parse(input.batch);
    const assignment = ComparisonAssignmentSchema.parse(parsed.assignment);
    if (assignment.purpose !== "calibration") {
      throw new Error("Managed calibration batch assignment must use calibration purpose.");
    }
    const release = await requireRelease(input.tasksetId, assignment.comparisonRelease.id);
    if (release.release.contentHash !== assignment.comparisonRelease.contentHash) {
      throw new Error("Managed calibration batch references a different comparison release.");
    }
    validateComparisonAssignment(assignment, release.release);
    const { contentHash: runManifestHash, ...runManifestContent } = parsed.runManifest;
    if (contentHash(runManifestContent) !== runManifestHash) {
      throw new Error("Managed calibration Run Manifest failed immutable verification.");
    }
    const taskset = await deps.store.getTaskset(input.tasksetId);
    const task = taskset?.tasks.find((candidate) => candidate.id === assignment.taskRef.id);
    if (!task) throw new Error("Managed calibration task is absent from the local Taskset.");
    const directory = path.join(
      deps.storeDir,
      "training",
      "evaluation-artifacts",
      input.tasksetId,
      "managed-calibration",
      safeSegment(parsed.jobId),
    );
    await mkdir(directory, { recursive: true });
    for (const candidate of parsed.candidates) {
      if (!verifyAttemptReceipt(candidate.attempt) || !verifyArtifactManifest(candidate.artifactManifest)) {
        throw new Error("Managed calibration candidate lineage failed immutable verification.");
      }
      if (!assignment.candidates.some((entry) => entry.attemptRef.id === candidate.attempt.id)) {
        throw new Error("Managed calibration candidate is absent from its immutable assignment.");
      }
      const localArtifacts = [];
      const reviewEntries = candidate.artifactManifest.entries.filter((entry) => entry.artifact);
      for (const entry of reviewEntries) {
        const artifact = entry.artifact!;
        const mediaType = artifact.mediaType;
        if (!mediaType) continue;
        const visual = candidate.visualArtifacts.find((item) => item.sha256 === artifact.contentHash);
        const bytes = mediaType.startsWith("image/")
          ? decodeDataUrl(visual?.dataUrl, mediaType)
          : mediaType.startsWith("text/")
            ? Buffer.from(candidate.output, "utf8")
            : null;
        if (!bytes) continue;
        if (sha256(bytes) !== artifact.contentHash || (artifact.sizeBytes !== null && bytes.byteLength !== artifact.sizeBytes)) {
          throw new Error(`Managed calibration artifact ${artifact.id} failed byte verification.`);
        }
        const artifactPath = path.join(directory, safeSegment(artifact.id));
        await writeFile(artifactPath, bytes, { flag: "wx", mode: 0o600 }).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
          const existing = await readFile(artifactPath);
          if (sha256(existing) !== artifact.contentHash || existing.byteLength !== bytes.byteLength) {
            throw new Error(`Managed calibration artifact ${artifact.id} changed after import.`);
          }
        });
        localArtifacts.push(await deps.store.saveTaskAttemptArtifact(TaskAttemptArtifactSchema.parse({
          schemaVersion: "openpond.taskAttemptArtifact.v1",
          id: artifact.id,
          tasksetId: input.tasksetId,
          taskId: task.id,
          attemptId: candidate.attempt.id,
          kind: "output_artifact",
          path: artifactPath,
          mediaType,
          sha256: artifact.contentHash,
          sizeBytes: bytes.byteLength,
          createdAt: parsed.createdAt,
          metadata: {
            source: "managed-calibration-batch",
            managedRlJobId: parsed.jobId,
            portableArtifactManifestId: candidate.artifactManifest.id,
          },
        })));
      }
      await deps.store.saveTaskAttempt(TaskAttemptResultSchema.parse({
        schemaVersion: "openpond.taskAttempt.v1",
        id: candidate.attempt.id,
        tasksetId: input.tasksetId,
        taskId: task.id,
        split: task.split,
        attempt: 0,
        seed: 17,
        modelRef: null,
        startedAt: candidate.attempt.startedAt,
        completedAt: candidate.attempt.completedAt,
        output: { text: candidate.output },
        runtimeEventRefs: [],
        artifactRefs: localArtifacts.map((artifact) => artifact.id),
        privilegedOutcomeRef: null,
        infrastructureError: null,
        costUsd: candidate.attempt.costUsd,
        latencyMs: candidate.attempt.latencyMs,
        userInterventions: 0,
        metadata: {
          managedRlJobId: parsed.jobId,
          portableAttemptHash: candidate.attempt.contentHash,
          portableArtifactManifest: candidate.artifactManifest,
          portableRunManifest: parsed.runManifest,
        },
      }));
    }
    enforceSplitPurpose({ assignment, tasksetRelease: release.tasksetRelease });
    return deps.store.savePreferenceComparisonAssignment({
      schemaVersion: "openpond.preferenceComparisonAssignmentRecord.v1",
      id: assignment.id,
      tasksetId: input.tasksetId,
      assignment,
      state: "queued",
      reviewerKey: null,
      unreviewableReason: null,
      createdAt: parsed.createdAt,
      updatedAt: now(),
    });
  }

  async function calibrationStatus(input: {
    tasksetId: string;
    reviewerKey: string;
    comparisonReleaseId?: string | null;
  }) {
    await requireAuthorized("calibrate", input.tasksetId, input.reviewerKey);
    const releases = await deps.store.listPreferenceComparisonReleases(input.tasksetId);
    const release = input.comparisonReleaseId
      ? releases.find((record) => record.id === input.comparisonReleaseId) ?? null
      : releases[0] ?? null;
    if (!release) {
      return {
        release: null,
        assignmentCount: 0,
        humanCompleted: 0,
        canonicalModelCompleted: 0,
        swappedModelCompleted: 0,
        minimumSamples: null,
        readyToFinalize: false,
        latestReport: null,
      };
    }
    const assignments = (await deps.store.listPreferenceComparisonAssignments({ tasksetId: input.tasksetId }))
      .filter((record) =>
        record.assignment.purpose === "calibration"
        && record.assignment.comparisonRelease.id === release.id
        && record.assignment.comparisonRelease.contentHash === release.release.contentHash,
      );
    const submissions = await Promise.all(assignments.map(async (assignment) => ({
      assignment,
      submissions: await deps.store.listPreferenceComparisonSubmissions(assignment.id),
    })));
    const humanCompleted = submissions.filter(({ submissions: records }) =>
      records.some((record) => record.receipt.reviewer.kind === "human"),
    ).length;
    const canonicalModelCompleted = submissions.filter(({ submissions: records }) =>
      records.some((record) => record.receipt.reviewer.kind === "model" && record.reviewerKey.endsWith(":canonical")),
    ).length;
    const swappedModelCompleted = submissions.filter(({ submissions: records }) =>
      records.some((record) => record.receipt.reviewer.kind === "model" && record.reviewerKey.endsWith(":order_swap")),
    ).length;
    const calibrations = await deps.store.listPreferenceComparisonCalibrations(input.tasksetId);
    return {
      release: release.release,
      assignmentCount: assignments.length,
      humanCompleted,
      canonicalModelCompleted,
      swappedModelCompleted,
      minimumSamples: release.release.calibration.minimumSamples,
      readyToFinalize:
        humanCompleted >= release.release.calibration.minimumSamples
        && canonicalModelCompleted >= release.release.calibration.minimumSamples
        && swappedModelCompleted >= release.release.calibration.minimumSamples,
      latestReport: calibrations.find((record) =>
        record.report.comparisonRelease.id === release.id
        && record.report.comparisonRelease.contentHash === release.release.contentHash,
      )?.report ?? null,
    };
  }

  async function submitNextCalibrationModelReceipt(input: {
    id: string;
    tasksetId: string;
    comparisonReleaseId?: string | null;
    actorKey: string;
    model: ChatModelRef;
    rubric: string;
    signal: AbortSignal;
  }) {
    await requireAuthorized("calibrate", input.tasksetId, input.actorKey);
    const releases = await deps.store.listPreferenceComparisonReleases(input.tasksetId);
    const release = input.comparisonReleaseId
      ? releases.find((record) => record.id === input.comparisonReleaseId) ?? null
      : releases[0] ?? null;
    if (!release) throw new Error("Preference comparison release was not found for calibration.");
    const assignments = (await deps.store.listPreferenceComparisonAssignments({ tasksetId: input.tasksetId }))
      .filter((record) =>
        record.assignment.purpose === "calibration"
        && record.assignment.comparisonRelease.id === release.id,
      );
    const reviewer = modelReviewer(input.model);
    const baseReviewerKey = `${reviewer.releaseRef.id}:${reviewer.releaseRef.contentHash}`;
    for (const assignment of assignments) {
      const submissions = await deps.store.listPreferenceComparisonSubmissions(assignment.id);
      if (!submissions.some((record) => record.receipt.reviewer.kind === "human")) continue;
      for (const variant of ["canonical", "order_swap"] as const) {
        if (submissions.some((record) => record.reviewerKey === modelSubmissionKey(baseReviewerKey, variant))) continue;
        return submitModelReceipt({
          id: `${input.id}:${assignment.id}:${variant}`,
          tasksetId: input.tasksetId,
          assignmentId: assignment.id,
          actorKey: input.actorKey,
          model: input.model,
          rubric: input.rubric,
          reviewVariant: variant,
          signal: input.signal,
        });
      }
    }
    return { status: "complete" as const };
  }

  async function saveCalibrationFromStoredReceipts(input: {
    id: string;
    tasksetId: string;
    comparisonReleaseId: string;
    reviewerKey: string;
    model: ChatModelRef;
  }): Promise<PreferenceCalibrationReport> {
    await requireAuthorized("calibrate", input.tasksetId, input.reviewerKey);
    const release = await requireRelease(input.tasksetId, input.comparisonReleaseId);
    const reviewer = modelReviewer(input.model);
    const baseReviewerKey = `${reviewer.releaseRef.id}:${reviewer.releaseRef.contentHash}`;
    const assignments = (await deps.store.listPreferenceComparisonAssignments({ tasksetId: input.tasksetId }))
      .filter((record) =>
        record.assignment.purpose === "calibration"
        && record.assignment.comparisonRelease.id === release.id,
      );
    const pairs: PreferenceCalibrationPair[] = [];
    for (const assignment of assignments) {
      const submissions = await deps.store.listPreferenceComparisonSubmissions(assignment.id);
      const human = submissions.find((record) => record.receipt.reviewer.kind === "human")?.receipt;
      const model = submissions.find((record) => record.reviewerKey === modelSubmissionKey(baseReviewerKey, "canonical"))?.receipt;
      const swappedModel = submissions.find((record) => record.reviewerKey === modelSubmissionKey(baseReviewerKey, "order_swap"))?.receipt;
      if (human && model && swappedModel) {
        pairs.push({ assignment: assignment.assignment, human, model, swappedModel });
      }
    }
    return saveCalibration({
      id: input.id,
      tasksetId: input.tasksetId,
      comparisonReleaseId: input.comparisonReleaseId,
      reviewerKey: input.reviewerKey,
      pairs,
    });
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
    submitModelReceipt,
    markUnreviewable,
    saveCalibration,
    calibrationStatus,
    submitNextCalibrationModelReceipt,
    saveCalibrationFromStoredReceipts,
    importManagedCalibrationBatch,
    projectModelReward,
    modelJudge: deps.modelJudge,
  };
}

const ManagedCalibrationBatchSchema = z.object({
  schemaVersion: z.literal("openpond.managedRlCalibrationBatch.v1"),
  jobId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  runManifest: RunManifestSchema,
  assignment: ComparisonAssignmentSchema,
  candidates: z.array(z.object({
    rolloutId: z.string().trim().min(1),
    output: z.string(),
    visualArtifacts: z.array(z.object({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      mediaType: z.literal("image/png"),
      dataUrl: z.string().startsWith("data:image/png;base64,"),
    }).passthrough()),
    attempt: AttemptReceiptSchema,
    artifactManifest: ArtifactManifestSchema,
  }).strict()).length(4),
  createdAt: z.iso.datetime({ offset: true }),
}).passthrough();

function decodeDataUrl(value: string | undefined, mediaType: string): Buffer {
  const prefix = `data:${mediaType};base64,`;
  if (!value?.startsWith(prefix)) throw new Error("Managed calibration visual artifact bytes are missing.");
  return Buffer.from(value.slice(prefix.length), "base64");
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!segment) throw new Error("Managed calibration artifact path segment is empty.");
  return segment;
}

function modelReviewer(model: ChatModelRef): PreferenceReviewer {
  return {
    kind: "model",
    releaseRef: {
      id: `model-reviewer:${model.providerId}:${model.modelId}`,
      contentHash: contentHash({ schemaVersion: "openpond.preferenceModelReviewer.v1", model }),
    },
  };
}

function modelSubmissionKey(
  reviewerKey: string,
  variant: "canonical" | "order_swap",
): string {
  return `${reviewerKey}:${variant}`;
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
