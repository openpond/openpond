import { describe, expect, test } from "vitest";
import { contentHash } from "@openpond/harness";
import {
  createLearningIterationWorker, createLearningService, LearningIterationSchema, reconcileLearningCandidateDecision,
  type LearningIterationExecutor, type LearningIterationExecutionContext, type LearningIterationObservation,
} from "@openpond/evals/learning";
import { SqliteLearningStore } from "../apps/server/src/store/store-learning";
import { learningContext, learningNow } from "./helpers/learning-fixtures";
import { learningIterationFixture } from "./helpers/learning-iteration-fixtures";
import { withTempDirectory } from "./helpers/temp-directory";

const ref = (id: string) => ({ id, contentHash: contentHash(id) });
async function fixture(store: SqliteLearningStore) {
  const f = await learningIterationFixture(store.learningRepository());
  const policy = await f.publishPolicy();
  await f.approve(await f.submit());
  const reserved = await f.reserve(policy, "dispatch-proof");
  const iteration = LearningIterationSchema.parse(reserved.resources.find(value => value.schemaVersion === "openpond.learningIteration.v1"));
  let clock = Date.parse(learningNow);
  const now = () => new Date(clock).toISOString();
  return { ...f, policy, iteration, now, advance: (ms = 10_000) => { clock += ms; } };
}
function provider() {
  let prepared = 0;
  let submitted = 0;
  let cancelled = 0;
  let loseReply = false;
  let terminalCancellation = false;
  let output: LearningIterationObservation | null = null;
  let last: LearningIterationExecutionContext | null = null;
  const observe = (input: LearningIterationExecutionContext): LearningIterationObservation => ({
    scope: input.scope, dispatchId: input.dispatch.id, submissionHash: input.dispatch.submissionHash!,
    execution: ref("provider-job"), status: "running", spendUsd: 0.2, cleanupComplete: false,
    receipt: null, evaluation: null, candidate: null, failure: null,
  });
  const executor: LearningIterationExecutor = {
    async prepare(input) { prepared++; return { provider: "fixture", protocol: "fixture.v1", payload: { policy: input.policy.contentHash, batch: input.batch.contentHash, parent: input.iteration.trainingParent.contentHash } }; },
    async reconcile(input) { last = input; return output; },
    async submit(input) {
      submitted++; last = input;
      output ??= observe(input);
      if (loseReply) { loseReply = false; throw new Error("Reply lost after provider accepted the exact dispatch"); }
      return output;
    },
    async cancel(input) {
      cancelled++; last = input;
      output ??= observe(input);
      if (terminalCancellation) output = { ...output, status: "cancelled", cleanupComplete: true, receipt: ref("cancel-receipt") };
      return output;
    },
  };
  return { executor, counts: () => ({ prepared, submitted, cancelled }), loseReply: () => { loseReply = true; },
    allowCancellation: () => { terminalCancellation = true; },
    complete: (candidate = true) => { output = { ...observe(last!), status: "succeeded", spendUsd: 0.5, cleanupComplete: true, receipt: ref("terminal-receipt"), evaluation: ref("retained-evaluation"), candidate: candidate ? ref("candidate") : null }; },
  };
}

describe("durable iteration dispatch", () => {
  // Reviews can arrive twice or out of order after another iteration starts.
  // Reconciliation must retain exact evidence and never release that newer chain.
  test("reconciles candidate decisions monotonically without clearing a newer iteration", async () => withTempDirectory("iteration-review-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      const f = await fixture(store); const p = provider();
      const repository = store.learningRepository();
      const worker = createLearningIterationWorker(repository, p.executor, { workerId: "review-worker", executionOwner: "hosted", now: f.now });
      await worker.run(learningContext.scope, f.iteration.id);
      p.complete(); f.advance(); await worker.run(learningContext.scope, f.iteration.id);
      const observation = { scope: learningContext.scope, iterationId: f.iteration.id,
        decision: { ...ref("decision-one"), revision: 1 }, outcome: "accepted" as const,
        execution: ref("provider-job"), candidate: ref("candidate"), evaluation: ref("retained-evaluation"), receipt: ref("terminal-receipt") };
      await expect(reconcileLearningCandidateDecision(repository, { ...observation, candidate: ref("other-candidate") })).rejects.toThrow("learning_candidate_decision_evidence_mismatch");
      const accepted = await reconcileLearningCandidateDecision(repository, observation, { now: f.now });
      expect(accepted).toMatchObject({ status: "accepted", candidateDecision: observation.decision });
      expect((await f.service.list(learningContext, "chain")).items[0]?.activeIterationId).toBeNull();
      expect(await reconcileLearningCandidateDecision(repository, observation)).toEqual(accepted);
      await expect(reconcileLearningCandidateDecision(repository, { ...observation, outcome: "rejected" })).rejects.toThrow("learning_candidate_decision_revision_conflict");
      const chain = (await f.service.list(learningContext, "chain")).items[0]!;
      await repository.transaction(learningContext.scope, tx => tx.put("chain", { ...chain, revision: chain.revision + 1, activeIterationId: "newer-iteration", latestIterationId: "newer-iteration" }, chain.revision));
      const rejected = await reconcileLearningCandidateDecision(repository, { ...observation, outcome: "rejected", decision: { ...ref("decision-two"), revision: 2 } }, { now: f.now });
      expect(rejected.status).toBe("rejected");
      expect(await reconcileLearningCandidateDecision(repository, observation)).toEqual(rejected);
      expect((await f.service.list(learningContext, "chain")).items[0]?.activeIterationId).toBe("newer-iteration");
      expect((await f.service.get(learningContext, "reservation", f.iteration.id)).budget).toMatchObject({ reservedSpendUsd: 0, settledSpendUsd: 0.5 });
    } finally { await store.close(); }
  }));

  // A provider can commit a Job before its reply is lost. Restart must recover
  // that Job and its exact request without rebuilding inputs or consuming again.
  test("recovers an ambiguous submission after reopening and settles only the terminal receipt", async () => withTempDirectory("iteration-dispatch-", async home => {
    let store = new SqliteLearningStore(home);
    try {
      const f = await fixture(store);
      const p = provider(); p.loseReply();
      const worker = () => createLearningIterationWorker(store.learningRepository(), p.executor, { workerId: "worker", executionOwner: "hosted", now: f.now });
      expect(await worker().run(learningContext.scope, f.iteration.id)).toMatchObject({ status: "dispatching", retryCount: 1 });
      const before = await f.service.get(learningContext, "dispatch", f.iteration.dispatchId);
      expect(before.submissionStartedAt).not.toBeNull();
      expect((await f.service.get(learningContext, "reservation", f.iteration.id)).budget.reservedSpendUsd).toBe(2);
      await store.close(); store = new SqliteLearningStore(home); f.advance();
      expect(await worker().run(learningContext.scope, f.iteration.id)).toMatchObject({ trainingJob: ref("provider-job"), status: "training" });
      expect(p.counts()).toEqual({ prepared: 1, submitted: 1, cancelled: 0 });
      const service = createLearningService(store.learningRepository());
      expect((await service.get(learningContext, "dispatch", f.iteration.dispatchId)).submission).toEqual(before.submission);
      p.complete(); f.advance();
      const done = await worker().run(learningContext.scope, f.iteration.id);
      expect(done).toMatchObject({ status: "candidate_ready", candidateVersion: ref("candidate"), spendUsd: 0.5 });
      expect((await service.get(learningContext, "reservation", f.iteration.id)).budget).toMatchObject({ reservedSpendUsd: 0, settledSpendUsd: 0.5 });
      expect((await service.list(learningContext, "chain")).items[0]?.activeIterationId).toBe(f.iteration.id);
      expect((await service.list(learningContext, "consumption")).items).toHaveLength(1);
      expect(await worker().run(learningContext.scope, f.iteration.id)).toEqual(done);
    } finally { await store.close(); }
  }));

  // Cancellation during an uncertain submit cannot release reserved spend on
  // a browser request, transient failure, or nonterminal provider response.
  test("retains budget and execution ownership until cancellation is confirmed", async () => withTempDirectory("iteration-cancel-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      const f = await fixture(store); const p = provider(); p.loseReply();
      const worker = createLearningIterationWorker(store.learningRepository(), p.executor, { workerId: "worker", executionOwner: "hosted", now: f.now });
      const running = await worker.run(learningContext.scope, f.iteration.id);
      await expect(f.command({ action: "cancel_iteration_reservation", iterationId: running.id, expectedRevision: running.revision })).rejects.toThrow("learning_execution_cancellation_required");
      await f.command({ action: "cancel_iteration", iterationId: running.id, expectedRevision: running.revision });
      f.advance();
      expect(await worker.run(learningContext.scope, running.id)).toMatchObject({ status: "cancelling" });
      expect((await f.service.get(learningContext, "reservation", running.id)).budget.reservedSpendUsd).toBe(2);
      p.allowCancellation(); f.advance();
      expect(await worker.run(learningContext.scope, running.id)).toMatchObject({ status: "cancelled", spendUsd: 0.2 });
      expect((await f.service.get(learningContext, "reservation", running.id)).budget).toMatchObject({ reservedSpendUsd: 0, settledSpendUsd: 0.2 });
      expect((await f.service.list(learningContext, "chain")).items[0]?.activeIterationId).toBeNull();
      expect(p.counts()).toEqual({ prepared: 1, submitted: 1, cancelled: 2 });
    } finally { await store.close(); }
  }));

  // An expired worker may return after a replacement has already submitted.
  // Its late preparation must not overwrite the request or create another Job.
  test("fences an expired preparation lease across concurrent workers", async () => withTempDirectory("iteration-lease-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      const f = await fixture(store); const p = provider();
      let release!: () => void; let entered!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const slow: LearningIterationExecutor = { ...p.executor, async prepare(input) { entered(); await gate; return p.executor.prepare(input); } };
      const first = createLearningIterationWorker(store.learningRepository(), slow, { workerId: "first", executionOwner: "hosted", now: f.now }).run(learningContext.scope, f.iteration.id);
      await waiting;
      const second = createLearningIterationWorker(store.learningRepository(), p.executor, { workerId: "second", executionOwner: "hosted", now: f.now });
      expect(await second.run(learningContext.scope, f.iteration.id)).toMatchObject({ status: "dispatching" });
      expect(p.counts().submitted).toBe(0);
      f.advance(61_000);
      await second.run(learningContext.scope, f.iteration.id);
      release(); await first;
      expect(p.counts().submitted).toBe(1);
      expect((await f.service.get(learningContext, "dispatch", f.iteration.dispatchId)).leaseGeneration).toBe(2);
    } finally { await store.close(); }
  }));

  // A preparation failure must be recoverable/cancellable without accidentally
  // launching work.
  test("pauses new launches, bounds preparation retries and cancels before submission", async () => withTempDirectory("iteration-preparation-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      const f = await fixture(store); const p = provider();
      const paused = await f.publishPolicy(f.policy, { enabled: false });
      const worker = createLearningIterationWorker(store.learningRepository(), { ...p.executor, async prepare() { throw new Error("Pinned input unavailable"); } }, { workerId: "worker", executionOwner: "hosted", now: f.now });
      expect(await worker.run(learningContext.scope, f.iteration.id)).toMatchObject({ status: "ready" });
      expect(await f.service.list(learningContext, "dispatch")).toMatchObject({ items: [] });
      await f.publishPolicy(paused, { enabled: true });
      await worker.run(learningContext.scope, f.iteration.id); f.advance();
      const blocked = await worker.run(learningContext.scope, f.iteration.id);
      expect(blocked.failure?.code).toBe("learning_dispatch_attention_required");
      expect((await f.service.get(learningContext, "reservation", blocked.id)).budget.reservedSpendUsd).toBe(2);
      await f.command({ action: "retry_iteration_dispatch", iterationId: blocked.id, expectedRevision: blocked.revision });
      const retry = await worker.run(learningContext.scope, blocked.id);
      expect(retry.retryCount).toBe(3);
      expect((await f.service.get(learningContext, "dispatch", f.iteration.dispatchId)).consecutiveFailures).toBe(1);
      await f.command({ action: "cancel_iteration", iterationId: retry.id, expectedRevision: retry.revision });
      expect(await worker.run(learningContext.scope, blocked.id)).toMatchObject({ status: "cancelled", spendUsd: 0 });
      expect(p.counts()).toEqual({ prepared: 0, submitted: 0, cancelled: 0 });
      expect((await f.service.get(learningContext, "reservation", blocked.id)).budget.reservedSpendUsd).toBe(0);
    } finally { await store.close(); }
  }));

  // Cross-scope responses cannot settle another iteration's spend, and a
  // successful Job without an adapter must not become an invented candidate.
  test("rejects substituted observations and retains a no-candidate completion", async () => withTempDirectory("iteration-observation-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      const f = await fixture(store); const p = provider();
      const worker = (executor = p.executor) => createLearningIterationWorker(store.learningRepository(), executor, { workerId: "worker", executionOwner: "hosted", now: f.now });
      await worker().run(learningContext.scope, f.iteration.id); f.advance();
      const bad = { ...p.executor, async reconcile(input: LearningIterationExecutionContext) { return { ...(await p.executor.reconcile(input))!, scope: "other-scope" }; } };
      expect((await worker(bad).run(learningContext.scope, f.iteration.id)).failure?.message).toContain("learning_execution_identity_mismatch");
      expect((await f.service.get(learningContext, "reservation", f.iteration.id)).budget.reservedSpendUsd).toBe(2);
      p.complete(false); f.advance();
      const unsafe = { ...p.executor, async reconcile(input: LearningIterationExecutionContext) { return { ...(await p.executor.reconcile(input))!, cleanupComplete: false }; } };
      const blocked = await worker(unsafe).run(learningContext.scope, f.iteration.id);
      expect(blocked.failure?.code).toBe("learning_dispatch_attention_required");
      expect((await f.service.get(learningContext, "reservation", blocked.id)).budget.reservedSpendUsd).toBe(2);
      await f.command({ action: "retry_iteration_dispatch", iterationId: blocked.id, expectedRevision: blocked.revision });
      expect(await worker().run(learningContext.scope, f.iteration.id)).toMatchObject({ status: "completed_without_candidate", candidateVersion: null, spendUsd: 0.5 });
      expect(p.counts().submitted).toBe(1);
      expect((await f.service.list(learningContext, "chain")).items[0]?.activeIterationId).toBeNull();
    } finally { await store.close(); }
  }));
});
