import type { PreferenceReviewer } from "@openpond/evals";
import { contentHash } from "@openpond/harness";
import type { SqliteStore } from "../store/store.js";
import type { createPreferenceComparisonService } from "./preference-comparison-service.js";

type PreferenceComparisons = ReturnType<typeof createPreferenceComparisonService>;

export function humanPreferenceReviewer(reviewerKey: string): PreferenceReviewer {
  const id = `human-reviewer:${reviewerKey}`;
  return {
    kind: "human",
    releaseRef: {
      id,
      contentHash: contentHash({ schemaVersion: "openpond.humanPreferenceReviewer.v1", reviewerKey }),
    },
  };
}
export async function preferenceComparisonReviewPayload(
  store: SqliteStore,
  assignment: Awaited<ReturnType<PreferenceComparisons["nextAssignment"]>> & {},
  reviewer: PreferenceReviewer,
) {
  const taskset = await store.getTaskset(assignment.tasksetId);
  const task = taskset?.tasks.find((candidate) => candidate.id === assignment.assignment.taskRef.id) ?? null;
  const attempts = await store.listTaskAttempts(assignment.tasksetId);
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const candidates = await Promise.all(assignment.assignment.presentedCandidateOrder.map(async (attemptId, index) => {
    const candidate = assignment.assignment.candidates.find((item) => item.attemptRef.id === attemptId)!;
    const attempt = attemptById.get(attemptId) ?? null;
    const artifacts = await store.listTaskAttemptArtifacts({ attemptId });
    const visibleIds = new Set(candidate.visibleArtifactIds);
    return {
      label: `candidate-${index + 1}`,
      attemptId,
      output: attempt?.output ?? {},
      artifacts: artifacts
        .filter((artifact) => visibleIds.has(artifact.id))
        .map((artifact) => ({
          id: artifact.id,
          mediaType: artifact.mediaType,
          sizeBytes: artifact.sizeBytes,
        })),
    };
  }));
  return {
    assignment,
    reviewer,
    taskPrompt: task?.input ?? null,
    candidates,
  };
}
