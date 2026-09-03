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
    graderFixtures: [{
      id: `${id}-grader-fixture`,
      taskId: taskIds[0],
      label: "positive",
      output: { passed: true },
      infrastructureError: null,
      expectedPassed: true,
      expectedRewardEligible: true,
      metadata: {},
    }],
    learningSignals: {
      demonstrations: [],
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: [],
      labels: [],
    },
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
      { id: "schedule-p1", ordinal: 1, label: "P1", role: "daily_residual", parentRule: "previous_release", taskSource: "nightly_selection", trainableRank: 1, minimumTasks: 1, maximumTasks: 2 },
      { id: "schedule-p2", ordinal: 2, label: "P2", role: "daily_residual", parentRule: "previous_release", taskSource: "nightly_selection", trainableRank: 2, minimumTasks: 1, maximumTasks: 2 },
      { id: "schedule-p7", ordinal: 3, label: "P7", role: "weekly_rollup", parentRule: "seed_release", taskSource: "daily_cohort_union", trainableRank: 3, minimumTasks: 2, maximumTasks: 4 },
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

function causalRankSeries(
  seed: Taskset,
  eligible: Taskset,
  development: Taskset,
  retained: Taskset,
  frozen: Taskset,
): ModelComparisonSeries {
  const draft = draftSeries(seed, eligible, development, retained, frozen);
  const childRanks = [1, 2, 3, 4, 6, 8, 11, 16];
  return ModelComparisonSeriesSchema.parse({
    ...draft,
    id: "series-causal-rank-test",
    name: "Causal rank test",
    objective: "Compare child rank while holding the seed parent, task release, and training contract fixed.",
    residualProfile: {
      ...draft.residualProfile,
      maximumEnabledRank: 32,
    },
    schedule: [
      {
        id: "causal-p0",
        ordinal: 0,
        label: "P0",
        role: "seed",
        parentRule: "base_model",
        taskSource: "seed_taskset",
        trainableRank: 16,
        minimumTasks: 1,
        maximumTasks: 10,
      },
      ...childRanks.map((rank, index) => ({
        id: `causal-p${index + 1}`,
        ordinal: index + 1,
        label: `P${index + 1}`,
        role: "rank_candidate" as const,
        parentRule: "seed_release" as const,
        taskSource: "eligible_task_pool" as const,
        trainableRank: rank,
        minimumTasks: 1,
        maximumTasks: 10,
      })),
    ],
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
      listModelComparisonSeries: async (filter?: { modelProjectId?: string }) => [...series.values()]
        .filter((candidate) => !filter?.modelProjectId || candidate.modelProjectId === filter.modelProjectId),
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
      saveReadinessReport: async () => undefined,
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
  it("creates causal rank siblings from one exact seed and one exact task release", async () => {
    const seed = taskset("seed-causal-rank-test", ["seed-task"]);
    const eligible = taskset("eligible-causal-rank-test", ["rank-one", "rank-two"]);
    const development = taskset("development-causal-rank-test", ["development-task"]);
    const retained = taskset("retained-causal-rank-test", ["retained-task"]);
    const frozen = taskset("frozen-causal-rank-test", ["frozen-task"]);
    const store = memoryStore([seed, eligible, development, retained, frozen]);
    const service = createModelComparisonSeriesService(store.api as never);
    const saved = await service.saveSeries(causalRankSeries(seed, eligible, development, retained, frozen));
    const sealed = await service.sealSeries({ seriesId: saved.id, expectedRevision: 1 });

    await expect(service.queueRelease({
      seriesId: sealed.id,
      scheduleEntryId: "causal-p1",
      taskSelection: null,
      expectedSeriesRevision: sealed.revision,
    })).rejects.toThrow("trained seed Model Version");

    const p0 = (await service.queueRelease({
      seriesId: sealed.id,
      scheduleEntryId: "causal-p0",
      taskSelection: null,
      expectedSeriesRevision: sealed.revision,
    })).entry;
    store.data.versions.set("version-causal-p0", {
      id: "version-causal-p0",
      profileId: sealed.profileId,
      modelId: sealed.modelProjectId,
      taskset: p0.taskset,
      contentHash: contentHash("version-causal-p0"),
      artifactLineageId: "lineage-causal-p0",
      comparisonSeriesEntry: {
        seriesId: sealed.id,
        entryId: p0.id,
        scheduleEntryId: p0.scheduleEntryId,
        ordinal: p0.ordinal,
        releaseHash: p0.releaseHash,
      },
    });
    await candidate(service, p0, "version-causal-p0");

    const siblings: ModelComparisonSeriesEntry[] = [];
    let expectedRevision = sealed.revision + 1;
    for (let ordinal = 1; ordinal <= 8; ordinal += 1) {
      const result = await service.queueRelease({
        seriesId: sealed.id,
        scheduleEntryId: `causal-p${ordinal}`,
        taskSelection: null,
        expectedSeriesRevision: expectedRevision,
      });
      siblings.push(result.entry);
      expectedRevision = result.series.revision;
    }

    expect(new Set(siblings.map((entry) => JSON.stringify(entry.parent)))).toEqual(
      new Set([JSON.stringify({
        kind: "model_version",
        id: "version-causal-p0",
        contentHash: contentHash("version-causal-p0"),
      })]),
    );
    expect(new Set(siblings.map((entry) => `${entry.taskset.id}:${entry.taskset.revision}:${entry.taskset.contentHash}`))).toEqual(
      new Set([`${eligible.id}:${eligible.revision}:${eligible.contentHash}`]),
    );
    expect(siblings.map((entry) => entry.trainableRank)).toEqual([1, 2, 3, 4, 6, 8, 11, 16]);
    expect(siblings.map((entry) => entry.enabledCumulativeRank)).toEqual([17, 18, 19, 20, 22, 24, 27, 32]);
    for (const sibling of siblings) {
      expect(sibling.residualBlocks).toEqual([
        expect.objectContaining({ rank: 16, optimizationRole: "frozen", artifactLineageId: "lineage-causal-p0" }),
        expect.objectContaining({ rank: sibling.trainableRank, optimizationRole: "trainable", artifactLineageId: null }),
      ]);
    }
  });

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
    expect(store.data.tasksets.get(p1Result.entry.taskset.id)?.readiness?.tasksetHash).toBe(p1Result.entry.taskset.contentHash);
    const p1Ref = { seriesId: sealed.id, entryId: p1Result.entry.id, scheduleEntryId: p1Result.entry.scheduleEntryId, ordinal: 1, releaseHash: p1Result.entry.releaseHash };
    store.data.plans.set("plan-p1-failed", {
      id: "plan-p1-failed",
      modelId: sealed.modelProjectId,
      tasksetId: p1Result.entry.taskset.id,
      tasksetHash: p1Result.entry.taskset.contentHash,
      comparisonSeriesEntry: p1Ref,
    });
    store.data.runs.set("run-p1-failed", {
      id: "run-p1-failed",
      status: "failed",
      profileId: sealed.profileId,
      modelId: sealed.modelProjectId,
      taskset: p1Result.entry.taskset,
      comparisonSeriesEntry: p1Ref,
    });
    await service.linkRun({
      entryId: p1Result.entry.id,
      expectedStatus: "ready",
      status: "queued",
      trainingPlanId: "plan-p1-failed",
      modelRunId: "run-p1-failed",
    });
    await service.linkRun({ entryId: p1Result.entry.id, expectedStatus: "queued", status: "failed" });
    const p1Retry = await service.retryEntry({ entryId: p1Result.entry.id });
    expect(p1Retry.attemptOrdinal).toBe(2);
    expect(p1Retry.priorRunAttempts).toHaveLength(1);
    expect(p1Retry.residualBlocks.find((block) => block.optimizationRole === "frozen")?.artifactLineageId).toBe("lineage-p0");
    expect(p1Retry.residualBlocks.find((block) => block.optimizationRole === "trainable")?.artifactLineageId).toBeNull();
    await expect(service.queueRelease({ seriesId: sealed.id, scheduleEntryId: "schedule-p2", taskSelection: selection("daily-one", "2026-09-01T12:21:00.000Z"), expectedSeriesRevision: 5 })).rejects.toThrow("already used");

    store.data.versions.set("version-p1", {
      id: "version-p1", profileId: sealed.profileId, modelId: sealed.modelProjectId,
      taskset: p1Result.entry.taskset, contentHash: contentHash("version-p1"), artifactLineageId: "lineage-p1",
      comparisonSeriesEntry: { seriesId: sealed.id, entryId: p1Result.entry.id, scheduleEntryId: p1Result.entry.scheduleEntryId, ordinal: 1, releaseHash: p1Result.entry.releaseHash },
    });
    await candidate(service, p1Retry, "version-p1");
    const p1Decision = await service.decide({
      entryId: p1Result.entry.id, expectedSeriesRevision: 5,
      decision: { disposition: "advance", policy: { id: "advancement-service-test", version: 1 }, reasonCodes: ["acquisition_passed"], summary: "Daily acquisition passed retention limits.", decidedBy: "actor-service-test", decidedAt: "2026-09-01T12:30:00.000Z" },
    });

    const p2Result = await service.queueRelease({ seriesId: sealed.id, scheduleEntryId: "schedule-p2", taskSelection: selection("daily-two", "2026-09-01T12:40:00.000Z"), expectedSeriesRevision: 6 });
    expect(p2Result.entry.parent).toMatchObject({ kind: "model_version", id: "version-p1" });
    expect(store.data.tasksets.get(p2Result.entry.taskset.id)?.graderFixtures).toEqual(
      eligible.graderFixtures,
    );
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

  it("chains daily releases through every prior residual without an intermediate quality decision", async () => {
    const seed = taskset("seed-cumulative-test", ["seed-task"]);
    const eligible = taskset("eligible-cumulative-test", ["daily-one", "daily-two"]);
    const development = taskset("development-cumulative-test", ["development-task"]);
    const retained = taskset("retained-cumulative-test", ["retained-task"]);
    const frozen = taskset("frozen-cumulative-test", ["frozen-task"]);
    const store = memoryStore([seed, eligible, development, retained, frozen]);
    const service = createModelComparisonSeriesService(store.api as never);
    const saved = await service.saveSeries(draftSeries(seed, eligible, development, retained, frozen));
    const sealed = await service.sealSeries({ seriesId: saved.id, expectedRevision: 1 });
    const selection = (taskId: string) => ({
      source: "replay_evidence" as const,
      taskIds: [taskId], observedFrom: NOW, observedTo: NOW, reviewedAt: NOW,
      reviewedBy: "reviewer-cumulative-test", sourceTaskset: taskRef(eligible),
    });

    const p0 = (await service.queueRelease({
      seriesId: sealed.id, scheduleEntryId: "schedule-p0", taskSelection: null, expectedSeriesRevision: 2,
    })).entry;
    store.data.versions.set("version-cumulative-p0", {
      id: "version-cumulative-p0", profileId: sealed.profileId, modelId: sealed.modelProjectId,
      taskset: p0.taskset, contentHash: contentHash("version-cumulative-p0"), artifactLineageId: "lineage-cumulative-p0",
      comparisonSeriesEntry: { seriesId: sealed.id, entryId: p0.id, scheduleEntryId: p0.scheduleEntryId, ordinal: p0.ordinal, releaseHash: p0.releaseHash },
    });
    await candidate(service, p0, "version-cumulative-p0");

    const p1 = (await service.queueRelease({
      seriesId: sealed.id, scheduleEntryId: "schedule-p1", taskSelection: selection("daily-one"), expectedSeriesRevision: 3,
    })).entry;
    expect(p1.parent).toMatchObject({ kind: "model_version", id: "version-cumulative-p0" });
    store.data.versions.set("version-cumulative-p1", {
      id: "version-cumulative-p1", profileId: sealed.profileId, modelId: sealed.modelProjectId,
      taskset: p1.taskset, contentHash: contentHash("version-cumulative-p1"), artifactLineageId: "lineage-cumulative-p1",
      comparisonSeriesEntry: { seriesId: sealed.id, entryId: p1.id, scheduleEntryId: p1.scheduleEntryId, ordinal: p1.ordinal, releaseHash: p1.releaseHash },
    });
    await candidate(service, p1, "version-cumulative-p1");

    const p2 = (await service.queueRelease({
      seriesId: sealed.id, scheduleEntryId: "schedule-p2", taskSelection: selection("daily-two"), expectedSeriesRevision: 4,
    })).entry;
    expect(p2.parent).toMatchObject({ kind: "model_version", id: "version-cumulative-p1" });
    expect(p2.residualBlocks.map((block) => ({ rank: block.rank, role: block.optimizationRole }))).toEqual([
      { rank: 16, role: "frozen" },
      { rank: 1, role: "frozen" },
      { rank: 2, role: "trainable" },
    ]);
    expect(p2.enabledCumulativeRank).toBe(19);
    expect(p2.decision).toBeNull();

    const p7 = (await service.queueRelease({
      seriesId: sealed.id, scheduleEntryId: "schedule-p7", taskSelection: null, expectedSeriesRevision: 5,
    })).entry;
    expect(p7.parent).toMatchObject({ kind: "model_version", id: "version-cumulative-p0" });
    expect(p0.decision).toBeNull();
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
    })).rejects.toThrow("previous release's trained Model Version");

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
    const retried = await service.retryEntry({ entryId: alternate.id });
    expect(retried.status).toBe("ready");
    expect(retried.attemptOrdinal).toBe(1);
    expect(retried.priorRunAttempts).toEqual([]);

    const attempted = {
      ...p0,
      id: "retry-entry",
      releaseHash: contentHash("retry-entry"),
      status: "cancelled" as const,
      trainingPlanId: "retry-plan",
      modelRunId: "retry-run",
      queuedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
    };
    store.data.entries.set(attempted.id, attempted);
    store.data.runs.set("retry-run", { id: "retry-run", status: "cancelled" });
    const nextAttempt = await service.retryEntry({ entryId: attempted.id });
    expect(nextAttempt.status).toBe("ready");
    expect(nextAttempt.attemptOrdinal).toBe(2);
    expect(nextAttempt.modelRunId).toBeNull();
    expect(nextAttempt.priorRunAttempts).toEqual([expect.objectContaining({
      attemptOrdinal: 1,
      modelRunId: "retry-run",
      terminalStatus: "cancelled",
    })]);
  });

  it("completes post-launch linkage after reconciliation advances the entry", async () => {
    const seed = taskset("seed-service-test", ["seed-task"]);
    const eligible = taskset("eligible-service-test", ["daily-one"]);
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
      expectedSeriesRevision: sealed.revision,
    })).entry;
    const comparisonSeriesEntry = {
      seriesId: entry.seriesId,
      entryId: entry.id,
      scheduleEntryId: entry.scheduleEntryId,
      ordinal: entry.ordinal,
      releaseHash: entry.releaseHash,
    };
    store.data.plans.set("plan-race", {
      id: "plan-race",
      modelId: entry.modelProjectId,
      tasksetId: entry.taskset.id,
      tasksetHash: entry.taskset.contentHash,
      comparisonSeriesEntry,
    });
    store.data.runs.set("run-race", {
      id: "run-race",
      profileId: entry.profileId,
      modelId: entry.modelProjectId,
      taskset: entry.taskset,
      comparisonSeriesEntry,
      status: "running",
    });

    await service.linkRun({
      entryId: entry.id,
      expectedStatus: "ready",
      status: "queued",
      modelRunId: "run-race",
    });
    await service.linkRun({
      entryId: entry.id,
      expectedStatus: "queued",
      status: "running",
    });

    const linked = await service.linkStartedRun({
      entryId: entry.id,
      trainingPlanId: "plan-race",
      modelRunId: "run-race",
    });
    expect(linked.status).toBe("running");
    expect(linked.trainingPlanId).toBe("plan-race");
    expect(linked.modelRunId).toBe("run-race");
  });

  it("archives terminal series history but refuses to orphan active work", async () => {
    const seed = taskset("seed-service-test", ["seed-task"]);
    const eligible = taskset("eligible-service-test", ["daily-one"]);
    const development = taskset("development-service-test", ["development-task"]);
    const retained = taskset("retained-service-test", ["retained-task"]);
    const frozen = taskset("frozen-service-test", ["frozen-task"]);
    const store = memoryStore([seed, eligible, development, retained, frozen]);
    const service = createModelComparisonSeriesService(store.api as never);
    await service.saveSeries(draftSeries(seed, eligible, development, retained, frozen));
    const sealed = await service.sealSeries({
      seriesId: "series-service-test",
      expectedRevision: 1,
    });
    const queued = await service.queueRelease({
      seriesId: sealed.id,
      scheduleEntryId: "schedule-p0",
      taskSelection: null,
      expectedSeriesRevision: sealed.revision,
    });
    await service.linkRun({
      entryId: queued.entry.id,
      expectedStatus: "ready",
      status: "queued",
    });

    await expect(service.archiveSeries({
      seriesId: sealed.id,
      expectedRevision: queued.series.revision,
    })).rejects.toThrow("cannot be archived");

    await service.linkRun({
      entryId: queued.entry.id,
      expectedStatus: "queued",
      status: "cancelled",
    });
    const archived = await service.archiveSeries({
      seriesId: sealed.id,
      expectedRevision: queued.series.revision,
    });
    expect(archived).toMatchObject({
      id: sealed.id,
      status: "archived",
      revision: queued.series.revision + 1,
    });
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
