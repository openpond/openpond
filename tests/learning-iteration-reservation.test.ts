import { describe, expect, test } from "vitest";
import {
  createLearningService, LearningChainSchema, LearningIterationSchema, LearningIterationReservationSchema,
  LearningPolicySchema, learningRef, type LearningPolicy, type LearningRepository, type TaskEvidence,
} from "@openpond/evals/learning";

import { SqliteLearningStore } from "../apps/server/src/store/store-learning";
import { learningContext, learningFixture, learningNow } from "./helpers/learning-fixtures";
import { withTempDirectory } from "./helpers/temp-directory";

const withStore = (run: (store: SqliteLearningStore, home: string) => Promise<void>) => withTempDirectory("openpond-iteration-", async (home) => {
  const store = new SqliteLearningStore(home);
  try { await run(store, home); } finally { await store.close(); }
});

async function fixture(repository: LearningRepository) {
  const value = await learningFixture(repository);
  const ref = (id: string) => ({ id, contentHash: "a".repeat(64) });
  const publishPolicy = async (previous?: LearningPolicy, changes: Partial<LearningPolicy> = {}) => {
    const { contentHash: _hash, ...content } = previous ?? {} as LearningPolicy;
    return LearningPolicySchema.parse((await value.command({ action: "publish", kind: "policy", expectedRevision: previous?.revision ?? 0, content: {
      schemaVersion: "openpond.learningPolicy.v1", id: "policy", modelProjectId: "model", executionOwner: "hosted", enabled: true,
      sources: [learningRef(value.source)], taskDefinition: learningRef(value.definition), rewardBinding: learningRef(value.binding),
      admission: { mode: "human", qualification: null, minimumApprovedExamples: 1 },
      trigger: { kind: "schedule", intervalSeconds: 3600 }, trainingParent: ref("parent"), teacher: null,
      training: { method: "grpo", recipe: ref("recipe"), retentionEvaluation: ref("evaluation"), replayBatches: [] },
      limits: { maxIterationSpendUsd: 2, maxDailySpendUsd: 4, cooldownSeconds: 0, maxRetries: 1, maxBatchExamples: 1, maxBacklogExamples: 1000 },
      automation: { collect: false, train: true, accept: false, serve: false },
      acceptance: { minimumScore: 0.8, maximumRetentionRegression: 0, requireImprovement: true, rollbackVersion: null },
      ...content, ...changes, revision: (previous?.revision ?? 0) + 1,
    } })).resources[0]);
  };
  const approve = async (evidence: TaskEvidence) => value.command({
    action: "review", evidence: learningRef(evidence), expectedRevision: 0, disposition: "approved", targetApproval: "not_required",
    approvedTarget: null, observedGradeId: null, targetGradeId: null, note: "Human approved reward-training input.",
  });
  const reserve = (policy: LearningPolicy, identity: string) => value.command({ action: "reserve_iteration", policy: learningRef(policy), trigger: { kind: "manual", identity } });
  const cancel = (id: string) => value.command({ action: "cancel_iteration_reservation", iterationId: id, expectedRevision: 1 });
  return { ...value, publishPolicy, approve, reserve, cancel };
}

describe("durable learning iteration reservations", () => {
  // Duplicate events and different callers must never consume two batches or
  // reserve two budgets, including after the database is reopened.
  test("reserves atomically across concurrent triggers, policy edits and restart", async () => withStore(async (store, home) => {
    const f = await fixture(store.learningRepository());
    const policy = await f.publishPolicy();
    await f.approve(await f.submit());
    const results = await Promise.allSettled([f.reserve(policy, "manual-a"), f.command({ action: "reserve_iteration", policy: learningRef(policy), trigger: { kind: "schedule", scheduledAt: learningNow } })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => String(result.reason))).toEqual([expect.stringContaining("learning_iteration_active")]);
    const iteration = LearningIterationSchema.parse(results.find((result) => result.status === "fulfilled")!.value.resources[0]);
    const changed = await f.publishPolicy(policy, { enabled: false });
    await expect(f.reserve(changed, "new-fire")).rejects.toThrow("learning_policy_paused");
    const enabled = await f.publishPolicy(changed, { enabled: true });
    await expect(f.reserve(enabled, "new-fire")).rejects.toThrow("learning_iteration_active");
    const originalTrigger = LearningIterationReservationSchema.parse((await f.service.get(learningContext, "reservation", iteration.id))).trigger;
    await store.close();
    const reopened = new SqliteLearningStore(home);
    try {
      const service = createLearningService(reopened.learningRepository());
      const retry = await service.command({ ...learningContext, actor: { id: "another-reviewer", role: "reviewer" } }, {
        action: "reserve_iteration", operationId: "retry-after-restart", policy: learningRef(policy), trigger: originalTrigger,
      });
      expect(LearningIterationSchema.parse(retry.resources[0]).dispatchId).toBe(iteration.dispatchId);
      expect((await service.list(learningContext, "consumption")).items).toHaveLength(1);
      expect((await service.list(learningContext, "reservation")).items).toHaveLength(1);
      await expect(service.command(learningContext, { action: "reserve_iteration", operationId: "changed-retry", policy: learningRef(enabled), trigger: originalTrigger })).rejects.toThrow("learning_trigger_identity_conflict");
    } finally { await reopened.close(); }
  }));

  // Waiting must not consume data or spend. A later approval must be discovered
  // even though an earlier tick already scanned the same hashed evidence IDs.
  test("keeps review waits free and finds late approvals without retraining consumed examples", async () => withStore(async (store) => {
    const f = await fixture(store.learningRepository());
    let policy = await f.publishPolicy();
    const evidence = await f.submit();
    const waiting = await f.reserve(policy, "before-review");
    expect(LearningIterationSchema.parse(waiting.resources[0]).status).toBe("waiting_for_review");
    expect(LearningIterationReservationSchema.parse(waiting.resources[1]).budget.reservedSpendUsd).toBe(0);
    expect((await f.service.list(learningContext, "consumption")).items).toHaveLength(0);
    await f.approve(evidence);
    const ready = LearningIterationSchema.parse((await f.reserve(policy, "after-review")).resources[0]);
    expect(ready.status).toBe("ready");
    await f.cancel(ready.id);
    policy = await f.publishPolicy(policy);
    const noNewData = await f.reserve(policy, "after-policy-edit");
    expect(LearningIterationSchema.parse(noNewData.resources[0]).status).toBe("waiting_for_data");
    expect(LearningIterationReservationSchema.parse(noNewData.resources[1]).counts.consumed).toBe(1);
    const later = await f.submit({ idempotencyKey: "later", exampleId: "later", familyKey: "later", input: { question: "A new question" } });
    await f.approve(later);
    const next = LearningIterationSchema.parse((await f.reserve(policy, "later-arrival")).resources[0]);
    expect(next.status).toBe("ready");
    await store.learningRepository().transaction(learningContext.scope, async (tx) => {
      await tx.put("iteration", { ...next, revision: 2, status: "training" }, 1);
    });
    await expect(f.command({ action: "cancel_iteration_reservation", iterationId: next.id, expectedRevision: 2 })).rejects.toThrow("learning_execution_cancellation_required");
    expect((await f.service.get(learningContext, "reservation", next.id)).budget.reservedSpendUsd).toBe(2);
  }));

  // A crash midway through the atomic write must not strand a sealed batch,
  // a spent example or a budget reservation with no resumable iteration.
  test("rolls back a partial reservation and retries the same fire", async () => withStore(async (store) => {
    const base = store.learningRepository();
    const f = await fixture(base);
    const policy = await f.publishPolicy();
    await f.approve(await f.submit());
    const faulted: LearningRepository = { transaction: (scope, callback) => base.transaction(scope, (tx) => callback({
      ...tx, put: async (kind, resource, revision, index) => {
        if (kind === "reservation") throw new Error("simulated-storage-failure");
        await tx.put(kind, resource, revision, index);
      },
    })) };
    const request = { action: "reserve_iteration", operationId: "crash", policy: learningRef(policy), trigger: { kind: "manual", identity: "crash-fire" } };
    await expect(createLearningService(faulted).command(learningContext, request)).rejects.toThrow("simulated-storage-failure");
    for (const kind of ["chain", "batch", "package", "consumption", "iteration", "reservation"] as const) {
      expect((await f.service.list(learningContext, kind)).items).toHaveLength(0);
    }
    expect(LearningIterationSchema.parse((await f.service.command(learningContext, request)).resources[0]).status).toBe("ready");
  }));

  // Daily admission must include outstanding reservations from earlier dates,
  // and a date's offset spelling must not bypass spend or event identity.
  test("counts unsettled and settled spend and normalizes scheduled fire identities", async () => withStore(async (store) => {
    const repository = store.learningRepository();
    const f = await fixture(repository);
    const policy = await f.publishPolicy();
    await f.approve(await f.submit());
    const scheduled = { kind: "schedule", scheduledAt: "2026-09-06T08:00:00-04:00" };
    const first = await f.command({ action: "reserve_iteration", policy: learningRef(policy), trigger: scheduled });
    const iteration = LearningIterationSchema.parse(first.resources[0]);
    const retry = await f.command({ action: "reserve_iteration", policy: learningRef(policy), trigger: { kind: "schedule", scheduledAt: learningNow } });
    expect(LearningIterationSchema.parse(retry.resources[0]).id).toBe(iteration.id);
    await f.cancel(iteration.id);
    // Seed authoritative accounting as the execution reconciler will do;
    // no execution or provider mock is used by these reservation tests.
    await repository.transaction(learningContext.scope, async (tx) => {
      const reservation = (await tx.get("reservation", iteration.id))!;
      await tx.put("reservation", { ...reservation, revision: reservation.revision + 1, budget: { maximumSpendUsd: 4, reservedSpendUsd: 1, settledSpendUsd: 2, settledAt: "2026-09-05T23:30:00-04:00" } }, reservation.revision, { parentId: reservation.chainId });
    });
    await f.approve(await f.submit({ idempotencyKey: "second", exampleId: "second", familyKey: "second", input: { question: "Next" } }));
    await expect(f.reserve(policy, "over-budget")).rejects.toThrow("learning_daily_budget_exhausted");
    expect((await f.service.list(learningContext, "reservation")).items).toHaveLength(1);
    expect(LearningChainSchema.parse((await f.service.list(learningContext, "chain")).items[0]).activeIterationId).toBeNull();
  }));

  // The first page is not the whole backlog, and held-out examples must never
  // count toward a training threshold even when a human approved them.
  test("scans later pages, excludes held-out data and requires the configured review role", async () => withStore(async (store) => {
    const f = await fixture(store.learningRepository());
    const policy = await f.publishPolicy();
    for (let index = 0; index < 101; index += 1) await f.submit({ idempotencyKey: `row-${index}`, exampleId: `row-${index}` });
    const page = await f.service.list(learningContext, "evidence", { parentId: f.source.id, limit: 100 });
    const last = (await f.service.list(learningContext, "evidence", { parentId: f.source.id, afterId: page.nextCursor!, limit: 100 })).items[0]!;
    await f.approve(last);
    const heldOut = await f.submit({ idempotencyKey: "held-out", exampleId: "held-out", familyKey: "held-out", split: "frozen_eval", input: { question: "Private test" } });
    await f.approve(heldOut);
    await expect(f.service.command({ ...learningContext, actor: { id: "editor", role: "editor" } }, { action: "reserve_iteration", operationId: "editor-fire", policy: learningRef(policy), trigger: { kind: "manual", identity: "editor-fire" } })).rejects.toThrow("learning_review_not_authorized");
    const result = await f.reserve(policy, "page-two");
    const iteration = LearningIterationSchema.parse(result.resources[0]);
    expect(LearningIterationReservationSchema.parse(result.resources[1]).counts).toEqual({ eligible: 1, awaitingReview: 100, excluded: 1, consumed: 0 });
    expect((await f.service.get(learningContext, "batch", iteration.batch!.id)).examples.map((entry) => entry.evidence)).toEqual([learningRef(last)]);
  }));
});
