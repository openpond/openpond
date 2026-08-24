import { readFile } from "node:fs/promises";

import type { ComparisonAssignment, PreferenceComparisonRelease } from "@openpond/evals";

import type { SqliteStore } from "../store/store.js";
import type { PreferenceComparisonVisualCandidate } from "./preference-comparison-model-judge.js";

const MAX_IMAGES_PER_CANDIDATE = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Resolves the exact collected image artifacts selected by an assignment. */
export function createPreferenceComparisonVisualLoader(deps: {
  store: SqliteStore;
}) {
  async function loadVisualCandidates(input: {
    assignment: ComparisonAssignment;
    comparisonRelease: PreferenceComparisonRelease;
  }): Promise<PreferenceComparisonVisualCandidate[]> {
    return Promise.all(input.assignment.candidates.map(async (candidate) => {
      const visibleIds = new Set(candidate.visibleArtifactIds);
      const artifacts = await deps.store.listTaskAttemptArtifacts({
        attemptId: candidate.attemptRef.id,
      });
      const images = await Promise.all(
        artifacts
          .filter((artifact) => visibleIds.has(artifact.id))
          .filter((artifact) => isImageMediaType(artifact.mediaType))
          .slice(0, MAX_IMAGES_PER_CANDIDATE)
          .map(async (artifact) => {
            if (artifact.sizeBytes > MAX_IMAGE_BYTES) {
              throw new Error(`Image artifact ${artifact.id} exceeds the native-review size bound.`);
            }
            const bytes = await readFile(artifact.path);
            if (bytes.byteLength !== artifact.sizeBytes) {
              throw new Error(`Image artifact ${artifact.id} changed after collection.`);
            }
            return {
              url: `data:${artifact.mediaType};base64,${bytes.toString("base64")}`,
              detail: "high" as const,
            };
          }),
      );
      return { attemptId: candidate.attemptRef.id, images };
    }));
  }

  return { loadVisualCandidates };
}

function isImageMediaType(mediaType: string | null | undefined): mediaType is string {
  return Boolean(mediaType?.startsWith("image/"));
}
