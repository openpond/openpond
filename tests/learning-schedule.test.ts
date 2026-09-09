import { describe, expect, test } from "vitest";
import { contentHash } from "@openpond/harness";
import { createLearningScheduleWorker, createLearningService, learningScheduleId, synchronizeLearningSchedule, type LearningRepository } from "@openpond/evals/learning";
import { SqliteLearningStore } from "../apps/server/src/store/store-learning";
import { learningContext, learningNow } from "./helpers/learning-fixtures";
import { learningIterationFixture } from "./helpers/learning-iteration-fixtures";
import { withTempDirectory } from "./helpers/temp-directory";

const hour = 3_600_000;
function clock() {
  let value = Date.parse(learningNow);
  return { now: () => new Date(value).toISOString(), advance: (ms: number) => { value += ms; } };
}

describe("durable learning schedule fires", () => {
  // Downtime and duplicate replicas must not consume multiple batches or shift
  // a persisted occurrence to the retrying worker's current timestamp.
  test("coalesces downtime and preserves one exact fire across duplicate ticks and reopening", async () => withTempDirectory("learning-schedule-", async home => {
    let store = new SqliteLearningStore(home);
    try {
      const time = clock(); const f = await learningIterationFixture(store.learningRepository(), time);
      const policy = await f.publishPolicy(); await f.approve(await f.submit());
      const id = learningScheduleId(policy.id);
      time.advance(4 * hour);
      const worker = createLearningScheduleWorker(store.learningRepository(), { executionOwner: "hosted", now: time.now });
      const [first, duplicate] = await Promise.all([worker.run(learningContext.scope, id, "owner"), worker.run(learningContext.scope, id, "other-replica")]);
      expect(duplicate).toEqual(first);
      const fire = await f.service.get(learningContext, "schedule_fire", first.lastFire!.id);
      expect(fire).toMatchObject({ scheduledAt: "2026-09-06T13:00:00.000Z", coalescedThroughAt: "2026-09-06T16:00:00.000Z", coalescedCount: 3, outcome: "reserved" });
      expect(first.nextRunAt).toBe("2026-09-06T17:00:00.000Z");
      await store.close(); store = new SqliteLearningStore(home);
      expect(await createLearningScheduleWorker(store.learningRepository(), { executionOwner: "hosted", now: time.now }).run(learningContext.scope, id, "restarted")).toEqual(first);
      const service = createLearningService(store.learningRepository());
      expect((await service.list(learningContext, "consumption")).items).toHaveLength(1);
      expect((await service.list(learningContext, "schedule_fire")).items).toHaveLength(1);
      await expect(createLearningScheduleWorker(store.learningRepository(), { executionOwner: "local", now: time.now }).run(learningContext.scope, id, "local")).rejects.toThrow("learning_execution_owner_mismatch");
    } finally { await store.close(); }
  }));

  // Approval changes eligibility, not cadence. A waiting timer consumes no
  // budget, and an active training/review chain prevents an overlapping batch.
  test("waits for human review until the next fire and records active-chain skips", async () => withTempDirectory("learning-schedule-review-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      const time = clock(); const f = await learningIterationFixture(store.learningRepository(), time);
      const policy = await f.publishPolicy(); const evidence = await f.submit();
      const id = learningScheduleId(policy.id);
      const worker = createLearningScheduleWorker(store.learningRepository(), { executionOwner: "hosted", now: time.now });
      time.advance(hour);
      const waiting = await worker.run(learningContext.scope, id, "owner");
      const fire = await f.service.get(learningContext, "schedule_fire", waiting.lastFire!.id);
      expect(fire.outcome).toBe("waiting_for_review");
      expect((await f.service.get(learningContext, "reservation", fire.iteration!.id)).budget.reservedSpendUsd).toBe(0);
      await f.approve(evidence);
      expect(await worker.run(learningContext.scope, id, "owner")).toEqual(waiting);
      time.advance(hour);
      const reserved = await worker.run(learningContext.scope, id, "owner");
      expect((await f.service.get(learningContext, "schedule_fire", reserved.lastFire!.id)).outcome).toBe("reserved");
      time.advance(hour);
      const skipped = await worker.run(learningContext.scope, id, "owner");
      expect(await f.service.get(learningContext, "schedule_fire", skipped.lastFire!.id)).toMatchObject({ outcome: "skipped", reason: "active_iteration", iteration: null });
      expect((await f.service.list(learningContext, "consumption")).items).toHaveLength(1);
    } finally { await store.close(); }
  }));

  // Routine policy edits preserve the pending due time. Pausing prevents a
  // launch, and resuming or changing cadence establishes a new future timer.
  test("synchronizes policy edits and pause/resume atomically", async () => withTempDirectory("learning-schedule-edits-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      const time = clock(); const f = await learningIterationFixture(store.learningRepository(), time);
      let policy = await f.publishPolicy(); const id = learningScheduleId(policy.id);
      const { contentHash: _hash, ...content } = policy;
      const publication = { kind: "policy", expectedRevision: 1, content: { ...content, revision: 2 } };
      const editor = { ...learningContext, actor: { id: "editor", role: "editor" as const } };
      await expect(f.service.command(editor, { action: "publish", operationId: "editor-timer", ...publication })).rejects.toThrow("learning_review_not_authorized");
      await expect(f.service.command(editor, { action: "publish_resources", operationId: "editor-timer-batch", resources: [publication] })).rejects.toThrow("learning_review_not_authorized");
      time.advance(hour / 2);
      const original = policy;
      policy = await f.publishPolicy(policy, { limits: { ...policy.limits, maxRetries: 2 } });
      await expect(store.learningRepository().transaction(learningContext.scope, tx => synchronizeLearningSchedule(tx, original, time.now()))).rejects.toThrow("learning_policy_revision_stale");
      expect((await f.service.get(learningContext, "schedule", id)).nextRunAt).toBe("2026-09-06T13:00:00.000Z");
      policy = await f.publishPolicy(policy, { enabled: false });
      expect(await f.service.get(learningContext, "schedule", id)).toMatchObject({ state: "disabled", nextRunAt: null });
      time.advance(1.5 * hour);
      policy = await f.publishPolicy(policy, { enabled: true });
      expect((await f.service.get(learningContext, "schedule", id)).nextRunAt).toBe("2026-09-06T15:00:00.000Z");
      await f.publishPolicy(policy, { trigger: { kind: "schedule", intervalSeconds: 7200 } });
      expect((await f.service.get(learningContext, "schedule", id)).nextRunAt).toBe("2026-09-06T16:00:00.000Z");
    } finally { await store.close(); }
  }));

  // A crash after sealing a batch but before the fire commits must roll back
  // consumption, retain the due identity, and stop retrying after its limit.
  test("rolls back partial reservation and bounds retries without losing the original fire", async () => withTempDirectory("learning-schedule-rollback-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      const time = clock(); const repository = store.learningRepository();
      const f = await learningIterationFixture(repository, time);
      const policy = await f.publishPolicy(); await f.approve(await f.submit());
      const id = learningScheduleId(policy.id);
      const fireId = `schedule-fire-${contentHash([id, "2026-09-06T13:00:00.000Z"])}`;
      let failures = 2;
      const interrupted: LearningRepository = { transaction: (scope, callback) => repository.transaction(scope, async tx => {
        const result = await callback(tx);
        if (failures > 0 && await tx.get("schedule_fire", fireId)) { failures--; throw new Error("Interrupted before commit"); }
        return result;
      }) };
      const worker = createLearningScheduleWorker(interrupted, { executionOwner: "hosted", now: time.now });
      time.advance(hour);
      const failed = await worker.run(learningContext.scope, id, "owner");
      expect(failed).toMatchObject({ state: "scheduled", consecutiveFailures: 1, nextRunAt: "2026-09-06T13:00:00.000Z", lastFire: null });
      expect((await f.service.list(learningContext, "consumption")).items).toHaveLength(0);
      expect((await f.service.list(learningContext, "reservation")).items).toHaveLength(0);
      expect(await worker.run(learningContext.scope, id, "owner")).toEqual(failed);
      time.advance(1000);
      const blocked = await worker.run(learningContext.scope, id, "owner");
      expect(blocked).toMatchObject({ state: "blocked", consecutiveFailures: 2, lastFire: null });
      time.advance(10_000);
      expect(await worker.run(learningContext.scope, id, "owner")).toEqual(blocked);
      await f.publishPolicy(policy, { limits: { ...policy.limits, maxRetries: 2 } });
      const recovered = await worker.run(learningContext.scope, id, "owner");
      expect(recovered.lastFire?.id).toBe(fireId);
      expect((await f.service.list(learningContext, "consumption")).items).toHaveLength(1);
      expect((await f.service.get(learningContext, "schedule_fire", fireId)).outcome).toBe("reserved");
    } finally { await store.close(); }
  }));
});
