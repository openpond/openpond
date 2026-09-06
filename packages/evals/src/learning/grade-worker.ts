import { executeRewardBinding, type RewardBinding, type RewardComposition, type RewardRelease } from "../rewards.js";
import { assertGradeIdentity, taskAttemptEvidence, taskRecordFromEvidence } from "./admission.js";
import { TaskGradeRunSchema, type TaskDefinition, type TaskEvidence, type TaskGradeRun } from "./contracts.js";
import { requireLearningRelease, requireLearningResource, type LearningRepository } from "./repository.js";

export type TaskGradeExecution = {
  scope: string;
  run: TaskGradeRun;
  evidence: TaskEvidence;
  definition: TaskDefinition;
  binding: RewardBinding;
  rewards: RewardRelease[];
  signal: AbortSignal;
};
export interface TaskGradeExecutor {
  /** Host adapters enforce run timeout/spend and deduplicate remote dispatch by run.id. */
  execute(input: TaskGradeExecution): Promise<RewardComposition>;
  /** True means the execution owner has confirmed cleanup/terminal cancellation. */
  cancel(input: { scope: string; run: TaskGradeRun }): Promise<boolean>;
}

export function createBuiltinTaskGradeExecutor(): TaskGradeExecutor {
  return {
    execute(input) {
      return executeRewardBinding({ binding: input.binding, rewards: input.rewards, task: taskRecordFromEvidence(input.evidence, input.definition), evidence: taskAttemptEvidence(input.evidence, input.run.output), signal: input.signal });
    },
    // This executor allocates no remote compute and runs only bounded portable checks.
    async cancel() { return true; },
  };
}

export function createTaskGradeWorker(repository: LearningRepository, executor: TaskGradeExecutor, options: { workerId: string; now?: () => string }) {
  const now = options.now ?? (() => new Date().toISOString());
  const active = new Map<string, AbortController>();
  const key = (scope: string, id: string) => JSON.stringify([scope, id]);

  async function run(scope: string, gradeId: string): Promise<TaskGradeRun> {
    const claim = await repository.transaction(scope, async (transaction) => {
      const current = await requireLearningResource(transaction, "grade", gradeId);
      if (["completed", "failed", "cancelled"].includes(current.status)) return { acquired: false as const, run: current };
      if (current.leaseExpiresAt !== null && Date.parse(current.leaseExpiresAt) > Date.parse(now())) return { acquired: false as const, run: current };
      const run = TaskGradeRunSchema.parse({
        ...current, revision: current.revision + 1, status: current.status === "cancelling" ? "cancelling" : "running",
        leaseOwner: options.workerId, leaseExpiresAt: new Date(Date.parse(now()) + current.timeoutMs + 30_000).toISOString(),
        attemptCount: current.attemptCount + 1, updatedAt: now(),
      });
      await transaction.put("grade", run, current.revision, { parentId: current.evidence.id, status: run.status });
      return { acquired: true as const, run };
    });
    if (!claim.acquired) return claim.run;
    if (claim.run.status === "cancelling") {
      const terminal = await executor.cancel({ scope, run: claim.run });
      return finish(scope, claim.run, terminal ? { status: "cancelled", composition: null, failure: null } : { status: "cancelling", composition: null, failure: null });
    }
    const controller = new AbortController();
    active.set(key(scope, gradeId), controller);
    const timer = setTimeout(() => controller.abort(new Error("task_grade_timeout")), claim.run.timeoutMs);
    try {
      const resolved = await repository.transaction(scope, async (transaction) => {
        const evidence = await requireLearningRelease(transaction, "evidence", claim.run.evidence);
        const definition = await requireLearningRelease(transaction, "definition", evidence.submission.taskDefinition);
        const binding = await requireLearningRelease(transaction, "binding", claim.run.binding);
        const rewards = await Promise.all(binding.sources.map((source) => requireLearningRelease(transaction, "reward", source.reward)));
        return { evidence, definition, binding, rewards };
      });
      controller.signal.throwIfAborted();
      const composition = await executor.execute({ scope, run: claim.run, ...resolved, signal: controller.signal });
      controller.signal.throwIfAborted();
      assertGradeIdentity(composition, resolved.evidence, resolved.definition, claim.run.output);
      return await finish(scope, claim.run, { status: "completed", composition, failure: null });
    } catch (error) {
      if (controller.signal.aborted) {
        const terminal = await executor.cancel({ scope, run: claim.run });
        if (!terminal) return finish(scope, claim.run, { status: "cancelling", composition: null, failure: "Execution cancellation is awaiting owner confirmation." });
        if (controller.signal.reason instanceof Error && controller.signal.reason.message === "task_grade_cancel_requested") return finish(scope, claim.run, { status: "cancelled", composition: null, failure: null });
      }
      return await finish(scope, claim.run, { status: "failed", composition: null, failure: error instanceof Error ? error.message : "Task grading failed." });
    } finally {
      clearTimeout(timer);
      active.delete(key(scope, gradeId));
    }
  }

  async function finish(scope: string, claimed: TaskGradeRun, outcome: Pick<TaskGradeRun, "status" | "composition" | "failure">): Promise<TaskGradeRun> {
    return repository.transaction(scope, async (transaction) => {
      const current = await requireLearningResource(transaction, "grade", claimed.id);
      if (current.leaseOwner !== options.workerId || current.attemptCount !== claimed.attemptCount || ["completed", "failed", "cancelled"].includes(current.status)) return current;
      // A cancellation request does not override the execution owner's result.
      const status = outcome.status;
      const updated = TaskGradeRunSchema.parse({ ...current, ...outcome, status, composition: status === "completed" ? outcome.composition : null, revision: current.revision + 1, leaseOwner: null, leaseExpiresAt: status === "cancelling" ? new Date(Date.parse(now()) + 5_000).toISOString() : null, updatedAt: now() });
      await transaction.put("grade", updated, current.revision, { parentId: current.evidence.id, status: updated.status });
      return updated;
    });
  }

  return {
    run,
    requestCancellation(scope: string, gradeId: string) { active.get(key(scope, gradeId))?.abort(new Error("task_grade_cancel_requested")); },
    async drain(scope: string, limit = 20): Promise<TaskGradeRun[]> {
      const candidates = await repository.transaction(scope, async (transaction) => {
        const rows: TaskGradeRun[] = [];
        for (const status of ["queued", "running", "cancelling"]) rows.push(...(await transaction.list("grade", { status, limit: Math.max(1, Math.min(100, limit)) })).items);
        return rows;
      });
      const completed: TaskGradeRun[] = [];
      for (const candidate of candidates) completed.push(await run(scope, candidate.id));
      return completed;
    },
  };
}
