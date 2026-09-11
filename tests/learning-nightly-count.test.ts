import { describe, expect, test } from "vitest";
import { coalesceNightlyOccurrences, createLearningScheduleWorker, learningScheduleId, nextNightlyOccurrence, NightlyScheduleSchema } from "@openpond/evals/learning";
import { SqliteLearningStore } from "../apps/server/src/store/store-learning";
import { learningContext, learningNow } from "./helpers/learning-fixtures";
import { learningIterationFixture } from "./helpers/learning-iteration-fixtures";
import { withTempDirectory } from "./helpers/temp-directory";

describe("nightly and task-count learning", () => {
  // A daily interval shifts the local hour at DST boundaries and may double-run
  // an ambiguous hour; calendar schedules must fire only once per local date.
  test("retains local time through DST, ambiguous hours and downtime", () => {
    const nightly = { localTime: "20:00", timeZone: "America/New_York" };
    expect(nextNightlyOccurrence(nightly, "2026-03-08T01:00:00Z")).toBe("2026-03-09T00:00:00.000Z");
    expect(nextNightlyOccurrence(nightly, "2026-11-01T00:00:00Z")).toBe("2026-11-02T01:00:00.000Z");
    const repeated = { ...nightly, localTime: "01:30" };
    expect(nextNightlyOccurrence(repeated, "2026-11-01T04:00:00Z")).toBe("2026-11-01T05:30:00.000Z");
    expect(nextNightlyOccurrence(repeated, "2026-11-01T05:45:00Z")).toBe("2026-11-02T06:30:00.000Z");
    expect(nextNightlyOccurrence({ ...nightly, localTime: "02:30" }, "2026-03-08T05:00:00Z")).toBe("2026-03-08T07:30:00.000Z");
    expect(coalesceNightlyOccurrences(nightly, "2026-03-08T01:00:00Z", "2026-03-10T01:00:00Z")).toEqual({ coalescedCount: 2, coalescedThroughAt: "2026-03-10T00:00:00.000Z", nextRunAt: "2026-03-11T00:00:00.000Z" });
    expect(NightlyScheduleSchema.safeParse({ ...nightly, timeZone: "Not/A_Zone" }).success).toBe(false);
    expect(NightlyScheduleSchema.safeParse({ ...nightly, localTime: "24:00" }).success).toBe(false);
  });

  // Persisted timers must use the calendar after each fire and recompute a
  // changed local time rather than retaining an old interval-based due date.
  test("persists nightly cadence and calendar edits across actual timer fires", async () => withTempDirectory("learning-nightly-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      let time = Date.parse("2026-03-07T23:00:00Z");
      const clock = { now: () => new Date(time).toISOString() };
      const f = await learningIterationFixture(store.learningRepository(), clock);
      const policy = await f.publishPolicy(undefined, { trigger: { kind: "nightly", localTime: "20:00", timeZone: "America/New_York" } });
      const id = learningScheduleId(policy.id);
      expect((await f.service.get(learningContext, "schedule", id)).nextRunAt).toBe("2026-03-08T01:00:00.000Z");
      time = Date.parse("2026-03-08T01:00:00Z");
      const fired = await createLearningScheduleWorker(store.learningRepository(), { executionOwner: "hosted", now: clock.now }).run(learningContext.scope, id, "owner");
      expect(fired.nextRunAt).toBe("2026-03-09T00:00:00.000Z");
      expect(fired.intervalSeconds).toBe(null);
      await f.publishPolicy(policy, { trigger: { kind: "nightly", localTime: "21:00", timeZone: "America/New_York" } });
      expect((await f.service.get(learningContext, "schedule", id)).nextRunAt).toBe("2026-03-08T02:00:00.000Z");
    } finally { await store.close(); }
  }));

  // Checking repeatedly before the threshold must create no run. Shared sources
  // count once, held-out/pending evidence stays excluded, and duplicate workers
  // reserve a completed threshold exactly once.
  test("counts only eligible unused attempts and reserves one threshold batch", async () => withTempDirectory("learning-count-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      let time = Date.parse(learningNow);
      const clock = { now: () => new Date(time).toISOString() };
      const f = await learningIterationFixture(store.learningRepository(), clock);
      const policy = await f.publishPolicy(undefined, { trigger: { kind: "approved_count" }, admission: { mode: "human", qualification: null, minimumApprovedExamples: 2 }, limits: { maxIterationSpendUsd: 2, maxDailySpendUsd: 4, cooldownSeconds: 0, maxRetries: 1, maxBatchExamples: 2, maxBacklogExamples: 1000 } });
      const secondPolicy = await f.publishPolicy(undefined, { id: "second-policy", modelProjectId: "model", trigger: { kind: "manual" } });
      const first = await f.submit();
      await f.approve(first);
      const id = learningScheduleId(policy.id);
      const worker = createLearningScheduleWorker(store.learningRepository(), { executionOwner: "hosted", now: clock.now });
      expect((await f.service.inspectTaskQueue(learningContext)).pendingTrainingCount).toBe(1);
      expect((await f.service.inspectTaskQueue(learningContext, "other-model")).pendingTrainingCount).toBe(0);
      time += 60_000;
      await worker.run(learningContext.scope, id, "owner");
      expect((await f.service.list(learningContext, "iteration")).items).toHaveLength(0);
      expect((await f.service.list(learningContext, "schedule_fire")).items).toHaveLength(0);
      const pending = await f.submit({ exampleId: "second", attemptId: "second", idempotencyKey: "second" });
      await f.submit({ exampleId: "held", attemptId: "held", idempotencyKey: "held", split: "frozen_eval" });
      expect((await f.service.inspectTaskQueue(learningContext)).pendingTrainingCount).toBe(1);
      await f.approve(pending);
      expect((await f.service.inspectTaskQueue(learningContext)).pendingTrainingCount).toBe(2);
      time += 60_000;
      const results = await Promise.all([worker.run(learningContext.scope, id, "owner"), worker.run(learningContext.scope, id, "replica")]);
      expect(results[0]).toEqual(results[1]);
      expect((await f.service.list(learningContext, "iteration")).items).toHaveLength(1);
      expect((await f.service.list(learningContext, "consumption")).items).toHaveLength(2);
      expect((await f.service.inspectTaskQueue(learningContext)).pendingTrainingCount).toBe(0);
      await f.publishPolicy(secondPolicy, { enabled: false });
      expect((await f.service.inspectTaskQueue(learningContext)).pendingTrainingCount).toBe(0);
      await expect(f.service.inspectTaskQueue({ ...learningContext, actor: { id: "source", role: "source", sourceId: f.source.id } })).rejects.toThrow();
    } finally { await store.close(); }
  }));
});
