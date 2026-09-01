import {
  ModelComparisonSeriesSchema,
  type ModelComparisonSeries,
  type ModelComparisonSeriesEntry,
  type Taskset,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";
import { describe, expect, it } from "vitest";

import { createModelComparisonSeriesService } from "./model-comparison-series-service.js";

const NOW = "2026-09-01T12:00:00.000Z";
const taskRef = (taskset: Taskset) => ({ id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash });
const GRADER = { id: "grader-service-test", version: "1", label: "Service grader", kind: "content", weight: 1, hardGate: false, rewardEligible: true, privileged: true, config: {}, metadata: {} } as const;

function taskset(id: string, taskIds: string[]): Taskset {
  return {
    id,
    revision: 1,
    profileId: "profile-service-test",
    name: id,
    objective: "Exercise Comparison Series release construction.",
    status: "ready",
    tasks: taskIds.map((taskId) => ({
      id: taskId,
      split: "train",
      clusterKey: `family-${taskId}`,
      metadata: {},
    })),
    graders: [GRADER],
    graderFixtures: [],
    learningSignals: {},
    metadata: {},
    contentHash: contentHash(id),
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as Taskset;
}

function draftSeries(seed: Taskset, eligible: Taskset, development: Taskset, retained: Taskset, frozen: Taskset): ModelComparisonSeries {
  return ModelComparisonSeriesSchema.parse({
    schemaVersion: "openpond.modelComparisonSeries.v1",
    id: "series-service-test",
    profileId: "profile-service-test",
    modelProjectId: "project-service-test",
    name: "Service test",
    objective: "Exercise daily and weekly comparison branches.",
    status: "draft",
    revision: 1,
    productionBinding: { role: "chat_manual", roleTargetId: "target-service-test" },
    baseModel: { id: "base-service-test", revision: "base-revision" },
    seedTaskset: taskRef(seed),
    eligibleTaskPool: taskRef(eligible),
    evaluationTasksets: {
      development: taskRef(development),
      retained: taskRef(retained),
      frozenFinal: taskRef(frozen),
    },
    grader: { id: GRADER.id, contentHash: contentHash(GRADER) },
    residualProfile: {
      profileId: "residual-service-test",
      serializedEnvelopeRank: 32,
      maximumEnabledRank: 19,
      topology: "uniform_block_masked",
    },
    schedule: [
      { id: "schedule-p0", ordinal: 0, label: "P0", role: "seed", parentRule: "base_model", taskSource: "seed_taskset", trainableRank: 16, minimumTasks: 1, maximumTasks: 10 },
      { id: "schedule-p1", ordinal: 1, label: "P1", role: "daily_residual", parentRule: "accepted_daily_head", taskSource: "nightly_selection", trainableRank: 1, minimumTasks: 1, maximumTasks: 2 },
      { id: "schedule-p2", ordinal: 2, label: "P2", role: "daily_residual", parentRule: "accepted_daily_head", taskSource: "nightly_selection", trainableRank: 2, minimumTasks: 1, maximumTasks: 2 },
      { id: "schedule-p7", ordinal: 3, label: "P7", role: "weekly_rollup", parentRule: "accepted_seed", taskSource: "daily_cohort_union", trainableRank: 3, minimumTasks: 2, maximumTasks: 4 },
      { id: "schedule-p8", ordinal: 4, label: "P8", role: "full_refresh", parentRule: "base_model", taskSource: "eligible_task_pool", trainableRank: 19, minimumTasks: 3, maximumTasks: 10 },
    ],
    scheduleSealedAt: null,
    advancementPolicy: {
      id: "advancement-service-test",
      version: 1,
      requireCheckpoint: true,
      requireAppliedOptimizerUpdate: true,
      minimumCurrentCohortMeanImprovement: 0.05,
      maximumRetainedMeanRegression: 0.02,
      blockCriticalInvariantRegression: true,
      automaticDailyAdvancement: true,
    },
    executionPolicy: { startWhenReady: false },
    acceptedSeedEntryId: null,
    acceptedDailyHeadEntryId: null,
    promotedBindingId: null,
    createdBy: "actor-service-test",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function memoryStore(tasksets: Taskset[]) {
  const series = new Map<string, ModelComparisonSeries>();
  const entries = new Map<string, ModelComparisonSeriesEntry>();
  const tasksetMap = new Map(tasksets.map((item) => [item.id, item]));
  const versions = new Map<string, Record<string, unknown>>();
  const runs = new Map<string, Record<string, unknown>>();
  const plans = new Map<string, Record<string, unknown>>();
  const jobs: Array<Record<string, unknown>> = [];
  return {
    data: { series, entries, tasksets: tasksetMap, versions, runs, plans, jobs },
    api: {
      getModelProject: async (id: string) => id === "project-service-test" ? { id, profileId: "profile-service-test" } : null,
      getModelComparisonSeries: async (id: string) => series.get(id) ?? null,
      saveModelComparisonSeries: async (value: ModelComparisonSeries) => { series.set(value.id, value); return value; },
      listModelComparisonSeriesEntries: async (filter?: { seriesId?: string }) => [...entries.values()]
        .filter((entry) => !filter?.seriesId || entry.seriesId === filter.seriesId)
        .sort((a, b) => a.ordinal - b.ordinal),
      getModelComparisonSeriesEntry: async (id: string) => entries.get(id) ?? null,
      getTasksetRevision: async (id: string, revision: number, hash: string) => {
        const value = tasksetMap.get(id);
        return value?.revision === revision && value.contentHash === hash ? value : null;
      },
      getTaskset: async (id: string) => tasksetMap.get(id) ?? null,
      upsertTaskset: async (value: Taskset) => { tasksetMap.set(value.id, value); return value; },
      commitModelComparisonSeriesMutation: async (input: { expectedSeriesRevision: number; series: ModelComparisonSeries; entry: ModelComparisonSeriesEntry; expectedEntryStatus: ModelComparisonSeriesEntry["status"] | null }) => {
        const currentSeries = series.get(input.series.id);
        const currentEntry = entries.get(input.entry.id);
        if (currentSeries?.revision !== input.expectedSeriesRevision || (currentEntry?.status ?? null) !== input.expectedEntryStatus) throw new Error("compare-and-swap conflict");
        series.set(input.series.id, input.series);
        entries.set(input.entry.id, input.entry);
        return { series: input.series, entry: input.entry };
      },
      compareAndSwapModelComparisonSeriesEntry: async (input: { expectedStatus: ModelComparisonSeriesEntry["status"]; entry: ModelComparisonSeriesEntry }) => {
        if (entries.get(input.entry.id)?.status !== input.expectedStatus) throw new Error("entry compare-and-swap conflict");
        entries.set(input.entry.id, input.entry);
        return input.entry;
      },
      getModelVersion: async (id: string) => versions.get(id) ?? null,
      listModelVersions: async () => [...versions.values()],
      getTrainingPlan: async (id: string) => plans.get(id) ?? null,
      getModelRun: async (id: string) => runs.get(id) ?? null,
      listModelRuns: async () => [...runs.values()],
      listTrainingJobs: async () => jobs,
      getModelBinding: async () => null,
    },
  };
}

async function candidate(service: ReturnType<typeof createModelComparisonSeriesService>, entry: ModelComparisonSeriesEntry, versionId: string) {
  await service.linkRun({ entryId: entry.id, expectedStatus: "ready", status: "queued" });
  await service.linkRun({ entryId: entry.id, expectedStatus: "queued", status: "running" });
  return service.linkRun({ entryId: entry.id, expectedStatus: "running", status: "candidate", modelVersionId: versionId });
}

describe("Model Comparison Series service", () => {
  it("enforces sealed lineage, family quarantine, decisions, and independent P7/P8 parents", async () => {
    const seed = taskset("seed-service-test", ["seed-task"]);
    const eligible = taskset("eligible-service-test", ["daily-one", "daily-two", "daily-three"]);
    const development = taskset("development-service-test", ["development-task"]);
    const retained = taskset("retained-service-test", ["retained-task"]);
    const frozen = taskset("frozen-service-test", ["frozen-task"]);
    const store = memoryStore([seed, eligible, development, retained, frozen]);
    const service = createModelComparisonSeriesService(store.api as never);
    const saved = await service.saveSeries(draftSeries(seed, eligible, development, retained, frozen));
    const sealed = await service.sealSeries({ seriesId: saved.id, expectedRevision: 1 });
    await expect(service.saveSeries({ ...sealed, name: "illegal sealed edit", revision: 3 })).rejects.toThrow("sealed");

    const p0Result = await service.queueRelease({ seriesId: sealed.id, scheduleEntryId: "schedule-p0", taskSelection: null, expectedSeriesRevision: 2 });
    const p0Retry = await service.queueRelease({ seriesId: sealed.id, scheduleEntryId: "schedule-p0", taskSelection: null, expectedSeriesRevision: 2 });
    expect(p0Retry.entry.id).toBe(p0Result.entry.id);
    store.data.versions.set("version-p0", {
      id: "version-p0", profileId: sealed.profileId, modelId: sealed.modelProjectId,
      taskset: p0Result.entry.taskset, contentHash: contentHash("version-p0"), artifactLineageId: "lineage-p0",
      comparisonSeriesEntry: { seriesId: sealed.id, entryId: p0Result.entry.id, scheduleEntryId: p0Result.entry.scheduleEntryId, ordinal: 0, releaseHash: p0Result.entry.releaseHash },
    });
    const p0Candidate = await candidate(service, p0Result.entry, "version-p0");
    expect((await service.linkRun({
      entryId: p0Candidate.id,
      expectedStatus: "candidate",
      status: "candidate",
      modelVersionId: "version-p0",
    })).id).toBe(p0Candidate.id);
    const p0Decision = await service.decide({
      entryId: p0Result.entry.id,
      expectedSeriesRevision: 3,
      decision: { disposition: "advance", policy: { id: "advancement-service-test", version: 1 }, reasonCodes: ["seed_learned"], summary: "Seed checkpoint learned and retained.", decidedBy: "actor-service-test", decidedAt: "2026-09-01T12:10:00.000Z" },
    });
    expect(p0Decision.series.acceptedSeedEntryId).toBe(p0Result.entry.id);
    expect(p0Decision.series.acceptedDailyHeadEntryId).toBe(p0Result.entry.id);

    const selection = (taskId: string, reviewedAt: string) => ({
      source: "replay_evidence" as const,
      taskIds: [taskId], observedFrom: NOW, observedTo: NOW, reviewedAt,
      reviewedBy: "reviewer-service-test", sourceTaskset: taskRef(eligible),
    });
    const p1Result = await service.queueRelease({ seriesId: sealed.id, scheduleEntryId: "schedule-p1", taskSelection: selection("daily-one", "2026-09-01T12:20:00.000Z"), expectedSeriesRevision: 4 });
    expect(p1Result.entry.parent).toMatchObject({ kind: "model_version", id: "version-p0" });
    await expect(service.queueRelease({ seriesId: sealed.id, scheduleEntryId: "schedule-p2", taskSelection: selection("daily-one", "2026-09-01T12:21:00.000Z"), expectedSeriesRevision: 5 })).rejects.toThrow("already used");

    store.data.versions.set("version-p1", {
      id: "version-p1", profileId: sealed.profileId, modelId: sealed.modelProjectId,
      taskset: p1Result.entry.taskset, contentHash: contentHash("version-p1"), artifactLineageId: "lineage-p1",
      comparisonSeriesEntry: { seriesId: sealed.id, entryId: p1Result.entry.id, scheduleEntryId: p1Result.entry.scheduleEntryId, ordinal: 1, releaseHash: p1Result.entry.releaseHash },
    });
    await candidate(service, p1Result.entry, "version-p1");
    const p1Decision = await service.decide({
      entryId: p1Result.entry.id, expectedSeriesRevision: 5,
      decision: { disposition: "advance", policy: { id: "advancement-service-test", version: 1 }, reasonCodes: ["acquisition_passed"], summary: "Daily acquisition passed retention limits.", decidedBy: "actor-service-test", decidedAt: "2026-09-01T12:30:00.000Z" },
    });

    const p2Result = await service.queueRelease({ seriesId: sealed.id, scheduleEntryId: "schedule-p2", taskSelection: selection("daily-two", "2026-09-01T12:40:00.000Z"), expectedSeriesRevision: 6 });
    expect(p2Result.entry.parent).toMatchObject({ kind: "model_version", id: "version-p1" });
    store.data.versions.set("version-p2", {
      id: "version-p2", profileId: sealed.profileId, modelId: sealed.modelProjectId,
      taskset: p2Result.entry.taskset, contentHash: contentHash("version-p2"), artifactLineageId: "lineage-p2",
      comparisonSeriesEntry: { seriesId: sealed.id, entryId: p2Result.entry.id, scheduleEntryId: p2Result.entry.scheduleEntryId, ordinal: 2, releaseHash: p2Result.entry.releaseHash },
    });
    await candidate(service, p2Result.entry, "version-p2");
    const p2Decision = await service.decide({
      entryId: p2Result.entry.id, expectedSeriesRevision: 7,
      decision: { disposition: "hold", policy: { id: "advancement-service-test", version: 1 }, reasonCodes: ["retention_regression"], summary: "Hold the child because retained performance regressed.", decidedBy: "actor-service-test", decidedAt: "2026-09-01T12:50:00.000Z" },
    });
    expect(p2Decision.entry.status).toBe("rejected");
    expect(p2Decision.series.acceptedDailyHeadEntryId).toBe(p1Decision.entry.id);
    await expect(service.recordPromotion({
      entryId: p2Decision.entry.id, bindingId: "binding-p2", expectedSeriesRevision: 8,
    })).rejects.toThrow("accepted entry");

    const p7Result = await service.queueRelease({ seriesId: sealed.id, scheduleEntryId: "schedule-p7", taskSelection: null, expectedSeriesRevision: 8 });
    expect(p7Result.entry.parent).toMatchObject({ kind: "model_version", id: "version-p0" });
    expect(store.data.tasksets.get(p7Result.entry.taskset.id)?.tasks).toHaveLength(2);
    const p8Result = await service.queueRelease({ seriesId: sealed.id, scheduleEntryId: "schedule-p8", taskSelection: null, expectedSeriesRevision: 9 });
    expect(p8Result.entry.parent).toEqual({ kind: "base_model", id: "base-service-test", revision: "base-revision" });
    expect(p8Result.entry.taskset).toEqual(taskRef(eligible));
    expect(p8Result.entry.sourceTasksets).toEqual([taskRef(eligible)]);
    expect(store.data.tasksets.get(p8Result.entry.taskset.id)?.tasks.map((task) => task.id)).toEqual([
      "daily-one", "daily-two", "daily-three",
    ]);
    expect(p8Result.entry.trainableRank).toBe(19);

    store.data.versions.set("version-p7", {
      id: "version-p7", profileId: sealed.profileId, modelId: sealed.modelProjectId,
      taskset: p7Result.entry.taskset, contentHash: contentHash("version-p7"), artifactLineageId: "lineage-p7",
      comparisonSeriesEntry: { seriesId: sealed.id, entryId: p7Result.entry.id, scheduleEntryId: p7Result.entry.scheduleEntryId, ordinal: 3, releaseHash: p7Result.entry.releaseHash },
    });
    await candidate(service, p7Result.entry, "version-p7");
    const p7Decision = await service.decide({
      entryId: p7Result.entry.id, expectedSeriesRevision: 10,
      decision: { disposition: "advance", policy: { id: "advancement-service-test", version: 1 }, reasonCodes: ["final_review_selected"], summary: "Accept the weekly candidate without changing the daily branch head.", decidedBy: "actor-service-test", decidedAt: "2026-09-01T14:00:00.000Z" },
    });
    expect(p7Decision.entry.status).toBe("accepted");
    expect(p7Decision.series.acceptedDailyHeadEntryId).toBe(p1Decision.entry.id);
  });

  it("rejects invalid parents and version references while preserving cancellation and no-signal outcomes", async () => {
    const seed = taskset("seed-service-test", ["seed-task"]);
    const eligible = taskset("eligible-service-test", ["daily-one", "daily-two"]);
    const development = taskset("development-service-test", ["development-task"]);
    const retained = taskset("retained-service-test", ["retained-task"]);
    const frozen = taskset("frozen-service-test", ["frozen-task"]);
    const store = memoryStore([seed, eligible, development, retained, frozen]);
    const service = createModelComparisonSeriesService(store.api as never);
    await service.saveSeries(draftSeries(seed, eligible, development, retained, frozen));
    const sealed = await service.sealSeries({ seriesId: "series-service-test", expectedRevision: 1 });
    const selection = {
      source: "replay_evidence" as const,
      taskIds: ["daily-one"], observedFrom: NOW, observedTo: NOW, reviewedAt: NOW,
      reviewedBy: "reviewer-service-test", sourceTaskset: taskRef(eligible),
    };
    await expect(service.queueRelease({
      seriesId: sealed.id, scheduleEntryId: "schedule-p1", taskSelection: selection, expectedSeriesRevision: 2,
    })).rejects.toThrow("accepted parent");

    const p0 = (await service.queueRelease({
      seriesId: sealed.id, scheduleEntryId: "schedule-p0", taskSelection: null, expectedSeriesRevision: 2,
    })).entry;
    await service.linkRun({ entryId: p0.id, expectedStatus: "ready", status: "queued" });
    await service.linkRun({ entryId: p0.id, expectedStatus: "queued", status: "running" });
    store.data.versions.set("wrong-version", {
      id: "wrong-version", profileId: sealed.profileId, modelId: sealed.modelProjectId,
      taskset: taskRef(eligible), contentHash: contentHash("wrong-version"), artifactLineageId: "wrong-lineage",
      comparisonSeriesEntry: { seriesId: sealed.id, entryId: p0.id, scheduleEntryId: p0.scheduleEntryId, ordinal: 0, releaseHash: p0.releaseHash },
    });
    await expect(service.linkRun({
      entryId: p0.id, expectedStatus: "running", status: "candidate", modelVersionId: "wrong-version",
    })).rejects.toThrow("does not match");
    const noSignal = await service.linkRun({ entryId: p0.id, expectedStatus: "running", status: "no_signal" });
    const decided = await service.decide({
      entryId: noSignal.id,
      expectedSeriesRevision: 3,
      decision: { disposition: "no_signal", policy: { id: "advancement-service-test", version: 1 }, reasonCodes: ["equal_reward_groups"], summary: "The receipt was complete but no optimizer update was applied.", decidedBy: "actor-service-test", decidedAt: "2026-09-01T13:00:00.000Z" },
    });
    expect(decided.entry.status).toBe("no_signal");
    expect(decided.series.acceptedDailyHeadEntryId).toBeNull();

    const alternate = { ...p0, id: "cancel-entry", releaseHash: contentHash("cancel-entry"), status: "ready" as const };
    store.data.entries.set(alternate.id, alternate);
    const cancelled = await service.linkRun({ entryId: alternate.id, expectedStatus: "ready", status: "cancelled" });
    expect(cancelled.status).toBe("cancelled");
    await expect(service.linkRun({ entryId: alternate.id, expectedStatus: "cancelled", status: "ready" })).rejects.toThrow("Invalid Comparison entry transition");
  });

  it("reconciles the canonical Model Run lifecycle into its Comparison entry", async () => {
    const seed = taskset("seed-service-test", ["seed-task"]);
    const eligible = taskset("eligible-service-test", ["daily-one", "daily-two", "daily-three"]);
    const development = taskset("development-service-test", ["development-task"]);
    const retained = taskset("retained-service-test", ["retained-task"]);
    const frozen = taskset("frozen-service-test", ["frozen-task"]);
    const store = memoryStore([seed, eligible, development, retained, frozen]);
    const service = createModelComparisonSeriesService(store.api as never);
    await service.saveSeries(draftSeries(seed, eligible, development, retained, frozen));
    const sealed = await service.sealSeries({ seriesId: "series-service-test", expectedRevision: 1 });
    const entry = (await service.queueRelease({
      seriesId: sealed.id,
      scheduleEntryId: "schedule-p0",
      taskSelection: null,
      expectedSeriesRevision: 2,
    })).entry;
    const comparisonSeriesEntry = {
      seriesId: entry.seriesId,
      entryId: entry.id,
      scheduleEntryId: entry.scheduleEntryId,
      ordinal: entry.ordinal,
      releaseHash: entry.releaseHash,
    };
    store.data.plans.set("plan-reconciled", {
      id: "plan-reconciled",
      modelId: entry.modelProjectId,
      tasksetId: entry.taskset.id,
      tasksetHash: entry.taskset.contentHash,
      comparisonSeriesEntry,
    });
    store.data.runs.set("run-reconciled", {
      id: "run-reconciled",
      profileId: entry.profileId,
      modelId: entry.modelProjectId,
      modelVersionId: "version-reconciled",
      taskset: entry.taskset,
      comparisonSeriesEntry,
      status: "running",
    });
    store.data.jobs.push({ id: "job-reconciled", planId: "plan-reconciled", metadata: { modelRunId: "run-reconciled" } });

    await service.reconcileEntries();
    expect(store.data.entries.get(entry.id)).toMatchObject({
      status: "running",
      trainingPlanId: "plan-reconciled",
      modelRunId: "run-reconciled",
    });

    store.data.versions.set("version-reconciled", {
      id: "version-reconciled",
      profileId: entry.profileId,
      modelId: entry.modelProjectId,
      taskset: entry.taskset,
      comparisonSeriesEntry,
      adapterStatus: "trained",
      artifactLineageId: "lineage-reconciled",
    });
    store.data.runs.set("run-reconciled", {
      ...store.data.runs.get("run-reconciled")!,
      status: "succeeded",
    });
    await service.reconcileEntries();
    expect(store.data.entries.get(entry.id)).toMatchObject({
      status: "candidate",
      modelVersionId: "version-reconciled",
    });
  });
});
