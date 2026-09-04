import { describe, expect, test, vi } from "vitest";
import {
  ModelArtifactLineageSchema,
  ModelProjectSchema,
  TrainingArtifactSchema,
  TrainingJobEventSchema,
  TrainingJobSchema,
} from "../packages/contracts/src";
import { contentHash } from "../packages/taskset-sdk/src";
import { trainingRunDetail } from "../apps/server/src/training/run-detail";
import { tasksetFixture, planFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("local training job store", () => {
  test("normalizes retired destinations in persisted training state", async () => withTrainingStore(async ({ store }) => {
    const taskset = tasksetFixture({ ready: true });
    const modelProject = ModelProjectSchema.parse({
      schemaVersion: "openpond.modelProject.v2",
      id: "model_project_fixture",
      profileId: "default",
      name: "Fixture model",
      objective: null,
      defaultBaseModel: null,
      defaultDestinationId: null,
      revision: 1,
      trainingSetup: {
        tasksetRef: null,
        tasksetRelease: null,
        harnessRelease: null,
        baseModel: null,
        method: null,
        destinationId: null,
        managedRolloutPlacement: "remote",
        runPreset: null,
        recipe: null,
        preferredMaximumSpendUsd: null,
        preferredRetentionDays: null,
      },
      hosted: null,
      tasksetSyncs: [],
      createdAt: "2026-07-12T00:00:00Z",
      updatedAt: "2026-07-12T00:00:00Z",
    });
    await store.upsertTaskset(taskset);
    await store.saveReadinessReport(taskset.readiness!);
    await store.saveModelProject(modelProject);
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
    await (store as unknown as {
      run(sql: string, params: unknown[]): Promise<void>;
    }).run(
      "UPDATE model_projects SET payload = ? WHERE id = ?",
      [JSON.stringify({ ...modelProject, defaultDestinationId: "prime_hosted" }), modelProject.id],
    );

    await expect(store.getTaskset(taskset.id)).resolves.toMatchObject({
      readiness: { compatibleDestinationClasses: taskset.readiness!.compatibleDestinationClasses },
    });
    await expect(store.getReadinessReport(taskset.id)).resolves.toMatchObject({
      compatibleDestinationClasses: taskset.readiness!.compatibleDestinationClasses,
    });
    await expect(store.getModelProject(modelProject.id)).resolves.toMatchObject({
      id: modelProject.id,
      defaultDestinationId: null,
    });
  }));

  test("persists plans, jobs, ordered events, artifacts, and model lineage", async () => withTrainingStore(async ({ store }) => {
    const taskset = tasksetFixture({ ready: true });
    const plan = planFixture(taskset);
    await store.upsertTaskset(taskset);
    await store.saveTrainingPlan(plan);
    const job = TrainingJobSchema.parse({ schemaVersion: "openpond.trainingJob.v1", id: "job_fixture", planId: plan.id, bundleHash: "bundlehash", approvalId: "approval", destinationId: "openpond_managed", status: "running", nonProduction: false, workerPid: null, startedAt: "2026-07-12T00:00:00Z", completedAt: null, error: null, createdAt: "2026-07-12T00:00:00Z", updatedAt: "2026-07-12T00:00:00Z", metadata: {} });
    await store.saveTrainingJob(job);
    for (const sequence of [1, 0]) await store.saveTrainingJobEvent(TrainingJobEventSchema.parse({ schemaVersion: "openpond.trainingJobEvent.v1", id: `event_${sequence}`, jobId: job.id, sequence, type: sequence ? "metric" : "start", timestamp: "2026-07-12T00:00:00Z", payload: {} }));
    const artifact = TrainingArtifactSchema.parse({ schemaVersion: "openpond.trainingArtifact.v1", id: "artifact_fixture", jobId: job.id, kind: "adapter", path: "/tmp/adapter.safetensors", sha256: contentHash("adapter"), sizeBytes: 10, baseModelId: "base", baseModelRevision: "rev", tokenizerRevision: "tok", chatTemplateHash: contentHash("template"), nonProduction: true, createdAt: "2026-07-12T00:00:00Z", metadata: {} });
    await store.saveTrainingArtifact(artifact);
    await store.saveModelArtifactLineage(ModelArtifactLineageSchema.parse({ schemaVersion: "openpond.modelArtifactLineage.v1", id: "lineage_fixture", modelId: plan.modelId, artifactId: artifact.id, jobId: job.id, tasksetId: taskset.id, tasksetHash: taskset.contentHash, graderHash: contentHash(taskset.graders), planHash: plan.contentHash, bundleHash: job.bundleHash, recipeHash: contentHash(plan.recipe), workerVersion: "worker", trainerVersion: "trainer", importedAt: "2026-07-12T00:00:00Z", frozenEvaluationArtifactId: null, promotable: false }));
    expect((await store.listTrainingJobEvents(job.id)).map((item) => item.sequence)).toEqual([0, 1]);
    expect(await store.getTrainingArtifact(artifact.id)).toEqual(artifact);
    expect((await store.listModelArtifactLineage())[0]).toMatchObject({ id: "lineage_fixture", status: "imported", promotable: false });
  }));

  test("loads live events without scanning evaluation attempts and grades", async () => withTrainingStore(async ({ store }) => {
    const taskset = tasksetFixture({ ready: true });
    const plan = planFixture(taskset);
    const job = TrainingJobSchema.parse({ schemaVersion: "openpond.trainingJob.v1", id: "job_live_detail", planId: plan.id, bundleHash: "bundlehash", approvalId: "approval", destinationId: "openpond_managed", status: "running", nonProduction: false, workerPid: null, startedAt: "2026-07-12T00:00:00Z", completedAt: null, error: null, createdAt: "2026-07-12T00:00:00Z", updatedAt: "2026-07-12T00:00:00Z", metadata: {} });
    const event = TrainingJobEventSchema.parse({ schemaVersion: "openpond.trainingJobEvent.v1", id: "event_live_detail", jobId: job.id, sequence: 0, type: "progress", timestamp: "2026-07-12T00:00:01Z", payload: { remoteEventType: "physical_gpu_worker_state" } });
    await store.upsertTaskset(taskset);
    await store.saveTrainingPlan(plan);
    await store.saveTrainingJob(job);
    await store.saveTrainingJobEvent(event);
    const attempts = vi.spyOn(store, "listTaskAttempts");
    const grades = vi.spyOn(store, "listGradeResultsForTaskset");

    const detail = await trainingRunDetail(store, job.id, {
      includeEvaluation: false,
    });

    expect(detail.events).toEqual([event]);
    expect(detail.evaluation).toBeNull();
    expect(attempts).not.toHaveBeenCalled();
    expect(grades).not.toHaveBeenCalled();
  }));

  test("preserves lineage while removing retired managed-serving projections", async () => withTrainingStore(async ({ store }) => {
    const lineage = ModelArtifactLineageSchema.parse({
      schemaVersion: "openpond.modelArtifactLineage.v1",
      id: "lineage_retired_serving",
      modelId: "model_fixture",
      artifactId: "artifact_fixture",
      jobId: "job_fixture",
      tasksetId: "taskset_fixture",
      tasksetHash: contentHash("taskset"),
      graderHash: contentHash("graders"),
      planHash: contentHash("plan"),
      bundleHash: contentHash("bundle"),
      recipeHash: contentHash("recipe"),
      workerVersion: "worker",
      trainerVersion: "trainer",
      importedAt: "2026-07-12T00:00:00Z",
      frozenEvaluationArtifactId: null,
      promotable: false,
      managedServing: {
        schemaVersion: "openpond.managedAdapterServingProjection.v1",
        teamId: null,
        source: "sandbox_managed_rl",
        sourceRef: "serving_fixture",
        canonicalArtifactId: null,
        canonicalArtifactState: null,
        canonicalDeploymentId: null,
        canonicalDeploymentState: null,
        state: "failed",
        customerBindingAllowed: false,
        artifactContentHash: null,
        baseProfileId: null,
        publishedAt: null,
        lastSyncedAt: "2026-07-12T00:00:00Z",
        lastError: "Retired provider",
      },
    });
    await store.saveModelArtifactLineage(lineage);

    for (const source of ["openpond_training", "openpond_fireworks"]) {
      await (store as unknown as {
        run(sql: string, params: unknown[]): Promise<void>;
      }).run(
        "UPDATE model_artifact_lineage SET payload = ? WHERE id = ?",
        [JSON.stringify({ ...lineage, managedServing: { ...lineage.managedServing, source } }), lineage.id],
      );

      await expect(store.getModelArtifactLineage(lineage.id)).resolves.toMatchObject({
        id: lineage.id,
        managedServing: null,
      });
      await expect(store.listModelArtifactLineage()).resolves.toEqual([
        expect.objectContaining({ id: lineage.id, managedServing: null }),
      ]);
    }
  }));
});
