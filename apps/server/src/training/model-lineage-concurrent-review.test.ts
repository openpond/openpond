import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManagedAdapterServingProjectionSchema, ModelArtifactLineageSchema } from "@openpond/contracts";
import { expect, it } from "vitest";
import { SqliteStore } from "../store/store.js";

// A serving refresh must never restore the stale imported status of a rejected
// candidate; review writes must likewise preserve the newest serving evidence.
it("preserves review and serving fields through concurrent writes and reopening SQLite", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lineage-review-race-"));
  let store = new SqliteStore(directory);
  const at = "2026-09-09T03:00:00.000Z";
  const hash = "a".repeat(64);
  const lineage = ModelArtifactLineageSchema.parse({
    schemaVersion: "openpond.modelArtifactLineage.v1", id: "lineage-review", modelId: "model-review",
    artifactId: "adapter-review", jobId: "job-review", tasksetId: "taskset-review",
    tasksetHash: hash, graderHash: hash, planHash: hash, bundleHash: hash, recipeHash: hash,
    workerVersion: "test", trainerVersion: "test", importedAt: at,
    frozenEvaluationArtifactId: "baseline", promotable: false, pinned: true,
  });
  const projection = ManagedAdapterServingProjectionSchema.parse({
    schemaVersion: "openpond.managedAdapterServingProjection.v1", source: "sandbox_managed_rl",
    teamId: "team-review", sourceRef: "job-review", canonicalArtifactId: "canonical-review",
    canonicalArtifactState: "imported_unvalidated", canonicalDeploymentId: null,
    canonicalDeploymentState: null, state: "imported", publishedAt: at, lastSyncedAt: at, lastError: null,
  });
  try {
    await store.saveModelArtifactLineage(lineage);
    for (const reviewFirst of [true, false]) {
      const review = () => store.updateModelArtifactLineageReview(lineage.id, {
        status: "rejected", rejectedAt: at, rejectionReason: "No measured improvement.", frozenEvaluationArtifactId: "candidate",
      });
      const serving = () => store.updateModelArtifactLineageServing(lineage.id, projection);
      await Promise.all(reviewFirst ? [review(), serving()] : [serving(), review()]);
      expect(await store.getModelArtifactLineage(lineage.id)).toMatchObject({
        status: "rejected", rejectionReason: "No measured improvement.", frozenEvaluationArtifactId: "candidate",
        managedServing: projection, pinned: true, chatConfiguration: lineage.chatConfiguration,
      });
    }
    await store.close();
    store = new SqliteStore(directory);
    expect(await store.getModelArtifactLineage(lineage.id)).toMatchObject({ status: "rejected", managedServing: projection, pinned: true });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
