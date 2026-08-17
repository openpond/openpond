import {
  OptimizerTrainingSampleSchema,
  type ArtifactManifest,
  type AttemptReceipt,
  type CanonicalRolloutRecord,
  type RewardReceipt,
} from "@openpond/evals";
import {
  TaskAttemptResultSchema,
  type GradeResult,
  type TaskAttemptArtifact,
  type TaskAttemptResult,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";
import {
  projectDesktopCanonicalReceipts,
  projectDesktopCanonicalRollout,
  type DesktopHarnessContext,
} from "./portable-evals-adapter.js";
import { persistJsonTaskAttemptArtifact } from "./task-attempt-artifact-service.js";

export type PersistedCanonicalEvaluationEvidence = {
  attempt: TaskAttemptResult;
  artifacts: TaskAttemptArtifact[];
  attemptReceipt: AttemptReceipt;
  artifactManifest: ArtifactManifest;
  rewardReceipt: RewardReceipt;
  rolloutRecord: CanonicalRolloutRecord;
};

export async function persistCanonicalEvaluationEvidence(input: {
  store: SqliteStore;
  storeDir: string;
  taskset: Pick<Taskset, "id">;
  task: Pick<TaskDataRecord, "id">;
  context: DesktopHarnessContext;
  attempt: TaskAttemptResult;
  grade: GradeResult;
  artifacts: TaskAttemptArtifact[];
}): Promise<PersistedCanonicalEvaluationEvidence> {
  const canonical = projectDesktopCanonicalReceipts({
    context: input.context,
    attempt: input.attempt,
    grade: input.grade,
    artifacts: input.artifacts,
  });
  const optimizerSample = OptimizerTrainingSampleSchema.safeParse(
    input.attempt.metadata.optimizerTrainingSample
    ?? input.attempt.metadata.trainingSample,
  );
  const rolloutRecord = projectDesktopCanonicalRollout({
    context: input.context,
    attempt: input.attempt,
    artifacts: input.artifacts,
    canonical,
    optimizerSample: optimizerSample.success ? optimizerSample.data : null,
  });
  const canonicalEvidenceArtifacts = await Promise.all([
    persistJsonTaskAttemptArtifact({
      store: input.store,
      storeDir: input.storeDir,
      tasksetId: input.taskset.id,
      taskId: input.task.id,
      attemptId: input.attempt.id,
      requestId: input.attempt.id,
      kind: "grader_evidence",
      fileLabel: "artifact-manifest",
      payload: canonical.artifactManifest,
      timestamp: () => canonical.artifactManifest.createdAt,
    }),
    persistJsonTaskAttemptArtifact({
      store: input.store,
      storeDir: input.storeDir,
      tasksetId: input.taskset.id,
      taskId: input.task.id,
      attemptId: input.attempt.id,
      requestId: input.attempt.id,
      kind: "grader_evidence",
      fileLabel: "reward-receipt",
      payload: canonical.rewardReceipt,
      timestamp: () => canonical.rewardReceipt.createdAt,
    }),
    persistJsonTaskAttemptArtifact({
      store: input.store,
      storeDir: input.storeDir,
      tasksetId: input.taskset.id,
      taskId: input.task.id,
      attemptId: input.attempt.id,
      requestId: input.attempt.id,
      kind: "grader_evidence",
      fileLabel: "canonical-rollout",
      payload: rolloutRecord,
      timestamp: () => rolloutRecord.completedAt,
    }),
  ]);
  const artifacts = [...input.artifacts, ...canonicalEvidenceArtifacts];
  const attempt = TaskAttemptResultSchema.parse({
    ...input.attempt,
    artifactRefs: [...new Set([
      ...input.attempt.artifactRefs,
      ...canonicalEvidenceArtifacts.map((artifact) => artifact.id),
    ])],
    metadata: {
      ...input.attempt.metadata,
      portableRunManifestRef: {
        id: input.context.runManifest.id,
        contentHash: input.context.runManifest.contentHash,
      },
      portableAttemptReceipt: canonical.attemptReceipt,
      portableArtifactManifest: canonical.artifactManifest,
      portableRewardReceipt: canonical.rewardReceipt,
      portableCanonicalRollout: rolloutRecord,
      portableEnvironmentReleaseRef: {
        id: input.context.environmentRelease.id,
        contentHash: input.context.environmentRelease.contentHash,
      },
      portableVerifierSetReleaseRef: {
        id: input.context.verifierSetRelease.id,
        contentHash: input.context.verifierSetRelease.contentHash,
      },
      canonicalEvidenceArtifactRefs: canonicalEvidenceArtifacts.map(
        (artifact) => artifact.id,
      ),
    },
  });
  await input.store.saveTaskAttempt(attempt);
  return {
    attempt,
    artifacts,
    attemptReceipt: canonical.attemptReceipt,
    artifactManifest: canonical.artifactManifest,
    rewardReceipt: canonical.rewardReceipt,
    rolloutRecord,
  };
}
