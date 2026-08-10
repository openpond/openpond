import { describe, expect, test } from "vitest";
import { ModelArtifactLineageSchema, TrainingArtifactSchema, TrainingJobEventSchema, TrainingJobSchema } from "../packages/contracts/src";
import { contentHash } from "../packages/taskset-sdk/src";
import { tasksetFixture, planFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("local training job store", () => {
  test("removes retired hosted destination classes from persisted readiness", async () => withTrainingStore(async ({ store }) => {
    const taskset = tasksetFixture({ ready: true });
    await store.upsertTaskset(taskset);
    await store.saveReadinessReport(taskset.readiness!);
    const retiredClasses = [
      ...taskset.readiness!.compatibleDestinationClasses,
      "openpond_managed",
      "hosted_byok",
    ];
    await (store as unknown as {
      run(sql: string, params: unknown[]): Promise<void>;
    }).run(
      "UPDATE tasksets SET payload = ? WHERE id = ?",
      [JSON.stringify({ ...taskset, readiness: { ...taskset.readiness, compatibleDestinationClasses: retiredClasses } }), taskset.id],
    );
    await (store as unknown as {
      run(sql: string, params: unknown[]): Promise<void>;
    }).run(
      "UPDATE readiness_reports SET payload = ? WHERE taskset_id = ?",
      [JSON.stringify({ ...taskset.readiness, compatibleDestinationClasses: retiredClasses }), taskset.id],
    );

    await expect(store.getTaskset(taskset.id)).resolves.toMatchObject({
      readiness: { compatibleDestinationClasses: taskset.readiness!.compatibleDestinationClasses },
    });
    await expect(store.getReadinessReport(taskset.id)).resolves.toMatchObject({
      compatibleDestinationClasses: taskset.readiness!.compatibleDestinationClasses,
    });
  }));

  test("persists plans, jobs, ordered events, artifacts, and model lineage", async () => withTrainingStore(async ({ store }) => {
    const taskset = tasksetFixture({ ready: true });
    const plan = planFixture(taskset);
    await store.upsertTaskset(taskset);
    await store.saveTrainingPlan(plan);
    const job = TrainingJobSchema.parse({ schemaVersion: "openpond.trainingJob.v1", id: "job_fixture", planId: plan.id, bundleHash: "bundlehash", approvalId: "approval", destinationId: "local_cpu_fixture", status: "running", nonProduction: true, workerPid: null, startedAt: "2026-07-12T00:00:00Z", completedAt: null, error: null, createdAt: "2026-07-12T00:00:00Z", updatedAt: "2026-07-12T00:00:00Z", metadata: {} });
    await store.saveTrainingJob(job);
    for (const sequence of [1, 0]) await store.saveTrainingJobEvent(TrainingJobEventSchema.parse({ schemaVersion: "openpond.trainingJobEvent.v1", id: `event_${sequence}`, jobId: job.id, sequence, type: sequence ? "metric" : "start", timestamp: "2026-07-12T00:00:00Z", payload: {} }));
    const artifact = TrainingArtifactSchema.parse({ schemaVersion: "openpond.trainingArtifact.v1", id: "artifact_fixture", jobId: job.id, kind: "adapter", path: "/tmp/adapter.safetensors", sha256: contentHash("adapter"), sizeBytes: 10, baseModelId: "base", baseModelRevision: "rev", tokenizerRevision: "tok", chatTemplateHash: contentHash("template"), nonProduction: true, createdAt: "2026-07-12T00:00:00Z", metadata: {} });
    await store.saveTrainingArtifact(artifact);
    await store.saveModelArtifactLineage(ModelArtifactLineageSchema.parse({ schemaVersion: "openpond.modelArtifactLineage.v1", id: "lineage_fixture", modelId: plan.modelId, artifactId: artifact.id, jobId: job.id, tasksetId: taskset.id, tasksetHash: taskset.contentHash, graderHash: contentHash(taskset.graders), planHash: plan.contentHash, bundleHash: job.bundleHash, recipeHash: contentHash(plan.recipe), workerVersion: "worker", trainerVersion: "trainer", importedAt: "2026-07-12T00:00:00Z", frozenEvaluationArtifactId: null, promotable: false }));
    expect((await store.listTrainingJobEvents(job.id)).map((item) => item.sequence)).toEqual([0, 1]);
    expect(await store.getTrainingArtifact(artifact.id)).toEqual(artifact);
    expect((await store.listModelArtifactLineage())[0]).toMatchObject({ id: "lineage_fixture", status: "imported", promotable: false });
  }));
});
