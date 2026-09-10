import { contentHash } from "@openpond/harness";
import { BoundRewardResultSchema, type BoundRewardResult } from "../rewards.js";
import { sameLearningRef, learningRef } from "./contracts.js";
import { compileRewardCheck, matchRewardFixture, RewardCheckRunSchema, RewardCheckRuntimeSchema, type RewardCheckRun, type RewardCheckRuntime, type RewardFixture } from "./reward-checks.js";
import { requireLearningRelease, requireLearningResource, type LearningRepository } from "./repository.js";

export interface RewardFixtureExecutor {
  readonly runtime: RewardCheckRuntime;
  /** Resolve only the compiled private assets; settle after execution resources are cleaned up. */
  execute(input: ReturnType<typeof compileRewardCheck> & { scope: string; run: RewardCheckRun; fixture: RewardFixture; signal: AbortSignal }): Promise<BoundRewardResult>;
  /** True only after the execution owner confirms no work survives cancellation. */
  cancel(input: { scope: string; run: RewardCheckRun }): Promise<boolean>;
}

export function createRewardCheckWorker(repository: LearningRepository, executor: RewardFixtureExecutor, options: { workerId: string; now?: () => string }) {
  const runtime = RewardCheckRuntimeSchema.parse(executor.runtime);
  const now = options.now ?? (() => new Date().toISOString());
  const active = new Map<string, AbortController>();
  const key = (scope: string, id: string) => JSON.stringify([scope, id]);
  const terminal = (run: RewardCheckRun) => ["completed", "failed", "cancelled"].includes(run.status);

  async function run(scope: string, checkId: string): Promise<RewardCheckRun> {
    const claim = await repository.transaction(scope, async tx => {
      const current = await requireLearningResource(tx, "reward_check", checkId);
      if (terminal(current) || (current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) > Date.parse(now()))) return { acquired: false as const, run: current };
      const claimed = RewardCheckRunSchema.parse({ ...current, revision: current.revision + 1,
        status: current.status === "cancelling" ? "cancelling" : "running", runtime: current.status === "cancelling" ? current.runtime : runtime,
        leaseOwner: options.workerId, leaseExpiresAt: new Date(Date.parse(now()) + current.timeoutMs + 30_000).toISOString(),
        attemptCount: current.attemptCount + 1, results: current.results, matchesExpectations: null, failure: null, updatedAt: now(),
      });
      await tx.put("reward_check", claimed, current.revision, { parentId: claimed.reward.id, status: claimed.status });
      return { acquired: true as const, run: claimed };
    });
    if (!claim.acquired) return claim.run;
    if (claim.run.status === "cancelling") {
      const cleaned = await executor.cancel({ scope, run: claim.run });
      return finish(scope, claim.run, cleaned ? "cancelled" : "cancelling", null);
    }
    const controller = new AbortController();
    active.set(key(scope, checkId), controller);
    const timer = setTimeout(() => controller.abort(new Error("reward_check_timeout")), claim.run.timeoutMs);
    try {
      const compiled = await repository.transaction(scope, async tx => {
        const draft = await requireLearningRelease(tx, "draft", claim.run.draft);
        if (draft.targetKind !== "reward") throw new Error("reward_check_draft_kind_invalid");
        const base = draft.baseRelease ? await requireLearningRelease(tx, "reward", draft.baseRelease) : null;
        const compiled = compileRewardCheck(draft, base);
        if (compiled.snapshotHash !== claim.run.snapshotHash || !sameLearningRef(learningRef(compiled.reward), claim.run.reward) || contentHash(compiled.fixtureRefs) !== contentHash(claim.run.fixtureRefs)) throw new Error("reward_check_snapshot_mismatch");
        return compiled;
      });
      for (const fixture of compiled.fixtures) {
        controller.signal.throwIfAborted();
        const previous = claim.run.results.find(result => result.fixture.id === fixture.id);
        if (previous) {
          if (previous.fixture.contentHash !== contentHash(fixture) || !sameLearningRef(previous.result.reward, claim.run.reward)
            || previous.result.graderId !== compiled.reward.id || previous.result.role !== "evaluation") throw new Error("reward_check_retained_fixture_mismatch");
          continue;
        }
        const result = BoundRewardResultSchema.parse(await executor.execute({ ...compiled, scope, run: claim.run, fixture, signal: controller.signal }));
        // Retain a settled execution before observing cancellation. Its provider
        // cost and evidence already exist even if no more fixtures should run.
        if (result.graderId !== compiled.reward.id || !sameLearningRef(result.reward, claim.run.reward) || result.role !== "evaluation") throw new Error("reward_check_result_identity_mismatch");
        const retained = await repository.transaction(scope, async tx => {
          const current = await requireLearningResource(tx, "reward_check", checkId);
          if (!owns(current, claim.run) || terminal(current)) return current;
          const updated = RewardCheckRunSchema.parse({ ...current, revision: current.revision + 1, results: [...current.results, matchRewardFixture(fixture, result)], updatedAt: now() });
          await tx.put("reward_check", updated, current.revision, { parentId: current.reward.id, status: current.status });
          return updated;
        });
        if (!owns(retained, claim.run) || terminal(retained)) return retained;
        if (retained.status === "cancelling") controller.abort(new Error("reward_check_cancel_requested"));
      }
      controller.signal.throwIfAborted();
      return await finish(scope, claim.run, "completed", null);
    } catch (error) {
      if (controller.signal.aborted) {
        const cleaned = await executor.cancel({ scope, run: claim.run });
        if (!cleaned) return finish(scope, claim.run, "cancelling", "Execution cleanup is awaiting owner confirmation.");
        if (controller.signal.reason instanceof Error && controller.signal.reason.message === "reward_check_cancel_requested") return finish(scope, claim.run, "cancelled", null);
      }
      return await finish(scope, claim.run, "failed", error instanceof Error ? error.message : "Reward checks failed.");
    } finally {
      clearTimeout(timer);
      active.delete(key(scope, checkId));
    }
  }
  function owns(current: RewardCheckRun, claim: RewardCheckRun): boolean { return current.leaseOwner === options.workerId && current.attemptCount === claim.attemptCount; }
  async function finish(scope: string, claim: RewardCheckRun, status: RewardCheckRun["status"], failure: string | null): Promise<RewardCheckRun> {
    return repository.transaction(scope, async tx => {
      const current = await requireLearningResource(tx, "reward_check", claim.id);
      if (!owns(current, claim) || terminal(current)) return current;
      if (status === "completed" && current.results.length !== current.fixtureRefs.length) throw new Error("reward_check_results_incomplete");
      const updated = RewardCheckRunSchema.parse({ ...current, revision: current.revision + 1, status, failure,
        matchesExpectations: status === "completed" ? current.results.every(result => result.matchesExpectation) : null,
        leaseOwner: null, leaseExpiresAt: status === "cancelling" ? new Date(Date.parse(now()) + 5_000).toISOString() : null, updatedAt: now(),
      });
      await tx.put("reward_check", updated, current.revision, { parentId: current.reward.id, status: updated.status });
      return updated;
    });
  }
  return {
    run,
    requestCancellation(scope: string, id: string) { active.get(key(scope, id))?.abort(new Error("reward_check_cancel_requested")); },
    async drain(scope: string, limit = 20): Promise<RewardCheckRun[]> {
      const candidates = await repository.transaction(scope, async tx => {
        const rows: RewardCheckRun[] = [];
        for (const status of ["queued", "running", "cancelling"]) rows.push(...(await tx.list("reward_check", { status, limit: Math.max(1, Math.min(100, limit)) })).items);
        return rows;
      });
      const completed: RewardCheckRun[] = [];
      for (const candidate of candidates) completed.push(await run(scope, candidate.id));
      return completed;
    },
  };
}
