import { describe, expect, test } from "vitest";
import path from "node:path";
import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { buildTaskset } from "../packages/taskset-sdk/src";
import { createTrainingService } from "../apps/server/src/training/training-service";
import { trainingRunDetail } from "../apps/server/src/training/run-detail";
import { sftRecipeFixture, tasksetFixture, withTrainingStore } from "./helpers/training-fixtures";

describe.sequential("training start orchestration", () => {
  test("rejects unsupported methods before creating a training plan", async () => withTrainingStore(async ({ store, directory }) => {
    const taskset = tasksetFixture({ ready: true });
    await store.upsertTaskset(taskset);
    const service = createTrainingService({
      store,
      storeDir: directory,
      localWorkerProjectDir: path.resolve("python/openpond-training"),
    });
    try {
      await expect(service.createPlan({
        tasksetId: taskset.id,
        destinationId: "local_cpu_fixture",
        recipe: {
          schemaVersion: "openpond.unsupportedRecipe.v1",
          method: "grpo",
          parameterization: "lora",
          unsupportedReason: "The local worker does not implement GRPO.",
        },
      })).rejects.toThrow();
      expect(await store.listTrainingPlans()).toHaveLength(0);
    } finally { await service.close(); }
  }));

  test("creates plan, bundle, approval, job, evaluation, and lineage behind one start action", async () => withTrainingStore(async ({ store, directory }) => {
    const taskset = tasksetFixture({ ready: true });
    await store.upsertTaskset(taskset);
    await buildTaskset(taskset, path.join(directory, "training", "tasksets", taskset.id));
    let computeChecks = 0;
    let releaseArtifactStore!: () => void;
    let markArtifactStoreEntered!: () => void;
    const artifactStoreGate = new Promise<void>((resolve) => { releaseArtifactStore = resolve; });
    const artifactStoreEntered = new Promise<void>((resolve) => { markArtifactStoreEntered = resolve; });
    let serviceClosed = false;
    const service = createTrainingService({
      store,
      storeDir: directory,
      localWorkerProjectDir: path.resolve("python/openpond-training"),
      revalidateCompute: async () => { computeChecks += 1; },
      modelArtifactStore: async () => {
        markArtifactStoreEntered();
        await artifactStoreGate;
        return path.join(directory, "model-store");
      },
    });
    try {
      const started = await service.start({ tasksetId: taskset.id, destinationId: "local_cpu_fixture", recipe: sftRecipeFixture(), exportApproved: true, maximumCostUsd: 0 });
      expect(started).toMatchObject({ plan: { tasksetId: taskset.id }, bundle: { planId: started.plan.id }, approval: { planId: started.plan.id }, job: { planId: started.plan.id } });
      expect(computeChecks).toBe(2);
      await artifactStoreEntered;
      let closeFinished = false;
      const closing = service.close().then(() => { closeFinished = true; });
      await delay(25);
      const closedBeforeArtifactImportFinished = closeFinished;
      releaseArtifactStore();
      await closing;
      serviceClosed = true;
      expect(closedBeforeArtifactImportFinished).toBe(false);
      const completed = await waitForTerminal(store, started.job.id);
      expect(completed).toMatchObject({ status: "succeeded", metadata: { reloadVerified: true, frozenEvaluationExecuted: true } });
      const mirrored = String(completed.metadata.mirroredArtifactDirectory);
      await access(path.join(mirrored, "adapter", "adapter_model.safetensors"));
      await access(path.join(mirrored, "artifact-manifest.json"));
      expect(await store.listTrainingPlans()).toHaveLength(1);
      expect(await store.listTrainingBundles()).toHaveLength(1);
      expect(await store.listModelArtifactLineage(taskset.id)).toHaveLength(1);
      const events = await store.listTrainingJobEvents(started.job.id);
      const metricEvent = events.find((event) => event.type === "metric");
      expect(metricEvent).toBeDefined();
      await store.saveTrainingJobEvent({
        ...metricEvent!,
        id: "duplicate_metric_event",
        sequence: Math.max(...events.map((event) => event.sequence)) + 1,
        timestamp: new Date(
          Date.parse(metricEvent!.timestamp) + 1_000,
        ).toISOString(),
      });
      const detail = await trainingRunDetail(store, started.job.id);
      expect(detail.stepMetrics).toHaveLength(2);
      expect(detail.stepMetrics.map((metric) => metric.step)).toEqual([1, 2]);
      expect(detail.evaluation).toMatchObject({ base: { count: 1 }, trained: { count: 1 }, examples: [{ taskId: expect.any(String) }] });
    } finally {
      releaseArtifactStore();
      if (!serviceClosed) await service.close();
    }
  }), 90_000);
});

async function waitForTerminal(store: any, jobId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = await store.getTrainingJob(jobId);
    if (job && ["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${jobId}.`);
}
