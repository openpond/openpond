import { describe, expect, test } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { TaskMinerRunSchema } from "@openpond/contracts";
import { createTaskMinerService } from "../apps/server/src/training/task-miner";
import { createTaskMinerBackgroundLoop } from "../apps/server/src/training/task-miner-background-loop";
import { sourceFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("task mining", () => {
  test("clusters three consented recurring sources and deduplicates reruns", async () => withTrainingStore(async ({ store }) => {
    for (let index = 0; index < 3; index += 1) await store.upsertTrainingSource({ ...recentSourceFixture(`source_${index}`, `cluster_${index}`), title: `Weekly research workflow ${index}`, metadata: { workflowSignature: "weekly-research", verifiableOutcome: true, frontierCost: true } });
    const service = createTaskMinerService({ store });
    const first = await service.run({ profileId: "default" });
    const second = await service.run({ profileId: "default" });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ workflowSignature: "weekly-research", status: "needs_review", metadata: { sourceCount: 3 } });
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(first[0]?.evidence.every((item) => item.consented)).toBe(true);
  }));

  test("automatically scans an enabled active profile without uploading evidence", async () => withTrainingStore(async ({ store }) => {
    for (let index = 0; index < 3; index += 1) await store.upsertTrainingSource({ ...recentSourceFixture(`auto_${index}`, `cluster_${index}`), metadata: { workflowSignature: "automatic-workflow" } });
    const service = createTaskMinerService({ store });
    await service.updateConfig("default", { schemaVersion: "openpond.taskMinerConfig.v1", enabled: true, localOnly: true, observationWindowDays: 30, minimumRecurrence: 3, clustering: "hybrid_deterministic_first", consentRequired: true });
    const loop = createTaskMinerBackgroundLoop({ service, loadProfileState: async () => ({ activeProfile: "default" } as any), isClosing: () => false });
    const result = await loop.tickNow();
    expect(result.skippedReason).toBeNull();
    expect(result.candidates[0]?.workflowSignature).toBe("automatic-workflow");
    expect(result.candidates[0]?.metadata.clustering).toBe("hybrid_deterministic_first");
  }));

  test("persists user-triggered scan progress and candidate lineage", async () => withTrainingStore(async ({ store }) => {
    for (let index = 0; index < 3; index += 1) await store.upsertTrainingSource({ ...recentSourceFixture(`run_${index}`, `cluster_${index}`), metadata: { workflowSignature: "persisted-run" } });
    const service = createTaskMinerService({ store });
    const started = await service.startRun({ profileId: "default" });
    expect(started).toMatchObject({ status: "queued", progress: { stage: "queued" }, candidateIds: [] });
    const completed = await waitForMinerRun(store, started.id);
    expect(completed).toMatchObject({ status: "succeeded", progress: { stage: "complete", processedSources: 3, totalSources: 3, candidatesFound: 1 } });
    expect(completed.candidateIds).toHaveLength(1);
    expect((await store.listTaskMinerRuns("default"))[0]?.id).toBe(started.id);
  }));

  test("persists cancellation for an active scan", async () => withTrainingStore(async ({ store }) => {
    for (let index = 0; index < 200; index += 1) await store.upsertTrainingSource({ ...recentSourceFixture(`cancel_${index}`, `cluster_${index}`), metadata: { workflowSignature: `cancel-${index}` } });
    const service = createTaskMinerService({ store });
    const started = await service.startRun({ profileId: "default" });
    await service.cancelRun(started.id);
    const completed = await waitForMinerRun(store, started.id);
    expect(completed.status).toBe("cancelled");
    expect(completed.cancelRequested).toBe(true);
    expect(completed.error).toBeNull();
  }));

  test("ingests session evidence inside the durable scan before clustering", async () => withTrainingStore(async ({ store }) => {
    const ingestedSessionIds: string[] = [];
    const service = createTaskMinerService({
      store,
      addSessionSource: async ({ sessionId }) => {
        ingestedSessionIds.push(sessionId);
        const source = {
          ...recentSourceFixture(`ingested_${sessionId}`, "ingested", sessionId),
          metadata: { workflowSignature: "ingested-workflow" },
        };
        await store.upsertTrainingSource(source);
        return source;
      },
    });
    const sessionIds = ["session_ingest_1", "session_ingest_2", "session_ingest_3"];
    const started = await service.startRun({ profileId: "default", sessionIds });
    expect(started).toMatchObject({
      status: "queued",
      sessionIds,
      progress: { stage: "queued", processedSources: 0, totalSources: 3 },
    });
    const completed = await waitForMinerRun(store, started.id);
    expect(completed).toMatchObject({
      status: "succeeded",
      progress: { stage: "complete", processedSources: 3, totalSources: 3, candidatesFound: 1 },
    });
    expect(completed.sourceIds).toHaveLength(3);
    expect(completed.candidateIds).toHaveLength(1);
    expect(new Set(ingestedSessionIds)).toEqual(new Set(sessionIds));
    await service.close();
  }));

  test("cancels a durable scan while session evidence is being ingested", async () => withTrainingStore(async ({ store }) => {
    const service = createTaskMinerService({
      store,
      addSessionSource: async ({ sessionId }) => {
        await delay(100);
        const source = recentSourceFixture(`cancel_ingest_${sessionId}`, "cancel-ingest", sessionId);
        await store.upsertTrainingSource(source);
        return source;
      },
    });
    const sessionIds = Array.from({ length: 32 }, (_, index) => `session_cancel_ingest_${index}`);
    const started = await service.startRun({ profileId: "default", sessionIds });
    await waitForMinerStage(store, started.id, "ingesting");
    await service.cancelRun(started.id);
    const completed = await waitForMinerRun(store, started.id);
    expect(completed.status).toBe("cancelled");
    expect(completed.cancelRequested).toBe(true);
    expect(completed.progress.processedSources).toBeLessThan(sessionIds.length);
    await service.close();
  }));

  test("skips sessions without completed evidence and keeps scanning", async () => withTrainingStore(async ({ store }) => {
    const service = createTaskMinerService({
      store,
      addSessionSource: async ({ sessionId }) => {
        if (sessionId === "session_empty") throw new Error("No completed turns were selected.");
        const source = {
          ...recentSourceFixture(`skip_${sessionId}`, "skip", sessionId),
          metadata: { workflowSignature: "skip-workflow" },
        };
        await store.upsertTrainingSource(source);
        return source;
      },
    });
    const started = await service.startRun({
      profileId: "default",
      sessionIds: ["session_good_1", "session_empty", "session_good_2", "session_good_3"],
    });
    const completed = await waitForMinerRun(store, started.id);
    expect(completed).toMatchObject({
      status: "succeeded",
      progress: { stage: "complete", processedSources: 3, totalSources: 3, candidatesFound: 1, skippedSources: 1 },
    });
    expect(completed.sourceIds).toHaveLength(3);
    await service.close();
  }));

  test("preserves completed ingestion batches when a later source fails", async () => withTrainingStore(async ({ store }) => {
    const service = createTaskMinerService({
      store,
      addSessionSource: async ({ sessionId }) => {
        if (sessionId === "session_failure") throw new Error("Synthetic source storage failure.");
        const source = recentSourceFixture(`preserved_${sessionId}`, "preserved", sessionId);
        await store.upsertTrainingSource(source);
        return source;
      },
    });
    const sessionIds = [
      ...Array.from({ length: 16 }, (_, index) => `session_preserved_${index}`),
      "session_failure",
    ];
    const started = await service.startRun({ profileId: "default", sessionIds });
    const completed = await waitForMinerRun(store, started.id);
    expect(completed).toMatchObject({
      status: "failed",
      progress: { stage: "ingesting", processedSources: 16, totalSources: 17 },
      error: "Synthetic source storage failure.",
    });
    expect(completed.sourceIds).toHaveLength(16);
    await service.close();
  }));

  test("reconciles a persisted scan interrupted by server restart", async () => withTrainingStore(async ({ store }) => {
    const timestamp = "2026-07-14T00:00:00.000Z";
    const interrupted = TaskMinerRunSchema.parse({
      schemaVersion: "openpond.taskMinerRun.v1",
      id: "task_miner_run_interrupted",
      profileId: "default",
      status: "running",
      config: {
        schemaVersion: "openpond.taskMinerConfig.v1",
        enabled: true,
        localOnly: true,
        observationWindowDays: 30,
        minimumRecurrence: 3,
        clustering: "hybrid_deterministic_first",
        consentRequired: true,
      },
      sourceIds: ["source_preserved"],
      sessionIds: ["session_preserved"],
      progress: { stage: "ingesting", processedSources: 1, totalSources: 3, candidatesFound: 0, skippedSources: 0 },
      candidateIds: [],
      cancelRequested: false,
      error: null,
      createdAt: timestamp,
      startedAt: timestamp,
      completedAt: null,
      updatedAt: timestamp,
    });
    await store.saveTaskMinerRun(interrupted);
    const service = createTaskMinerService({ store });
    await service.config("default");
    expect(await store.getTaskMinerRun(interrupted.id)).toMatchObject({
      status: "failed",
      sourceIds: ["source_preserved"],
      progress: { stage: "ingesting", processedSources: 1 },
      error: expect.stringContaining("restarted"),
    });
    await service.close();
  }));
});

function recentSourceFixture(...args: Parameters<typeof sourceFixture>) {
  return {
    ...sourceFixture(...args),
    occurredAt: new Date().toISOString(),
  };
}

async function waitForMinerRun(store: any, id: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await store.getTaskMinerRun(id);
    if (run && ["succeeded", "failed", "cancelled"].includes(run.status)) return run;
    await delay(10);
  }
  throw new Error(`Timed out waiting for Task Miner run ${id}.`);
}

async function waitForMinerStage(store: any, id: string, stage: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await store.getTaskMinerRun(id);
    if (run?.progress.stage === stage) return run;
    await delay(10);
  }
  throw new Error(`Timed out waiting for Task Miner run ${id} to reach ${stage}.`);
}
