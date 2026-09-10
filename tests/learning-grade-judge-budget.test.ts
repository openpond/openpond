import { expect, test } from "vitest";
import { createBudgetedJudgeExecutor, createTaskGradeJudgeBudgetStore, TaskGradeRunSchema } from "@openpond/evals/learning";
import { SqliteLearningStore } from "../apps/server/src/store/store-learning";
import { withTempDirectory } from "./helpers/temp-directory";
import { learningContext, learningFixture } from "./helpers/learning-fixtures";

// Grading reservations must share the same durable run identity and lease as
// the result. A late provider reply survives cancellation; a new call does not.
test("grade budget settles after cancellation and rejects further dispatch", async () => {
  await withTempDirectory("openpond-grade-judge-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      const repository = store.learningRepository();
      const fixture = await learningFixture(repository);
      const evidence = await fixture.submit();
      const queued = await fixture.queueGrade(evidence);
      const run = TaskGradeRunSchema.parse({ ...queued, revision: queued.revision + 1, status: "running",
        maximumSpendUsd: 0.01, leaseOwner: "owner", leaseExpiresAt: "2099-01-01T00:00:00.000Z", attemptCount: 1 });
      await repository.transaction(learningContext.scope, tx => tx.put("grade", run, queued.revision, { parentId: evidence.id, status: "running" }));
      let release!: () => void, entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      let calls = 0;
      const response = { text: "{}", modelId: "judge", modelRevision: null, responseId: "receipt", inputTokens: 10, outputTokens: 2, costUsd: 0.002 };
      const execute = createBudgetedJudgeExecutor({ store: createTaskGradeJudgeBudgetStore({ repository, scope: learningContext.scope, run }),
        maximumCharge: () => 0.008, dispatch: async () => { calls++; entered(); await wait; return response; } });
      const request = { providerId: "openpond", modelId: "judge", revision: null, temperature: 0, system: "Rubric", data: "{}" };
      const pending = execute("first", request);
      await ready;
      await expect(execute("second", request)).rejects.toThrow("budget_exceeded");
      await repository.transaction(learningContext.scope, async tx => {
        const current = (await tx.get("grade", run.id))!;
        await tx.put("grade", { ...current, revision: current.revision + 1, status: "cancelling" }, current.revision, { parentId: evidence.id, status: "cancelling" });
      });
      release();
      expect(await pending).toEqual(response);
      await expect(execute("third", request)).rejects.toThrow("owner_inactive");
      const retained = await repository.transaction(learningContext.scope, tx => tx.get("grade", run.id));
      expect(retained?.judgeCalls).toMatchObject([{ id: "first", status: "settled", response: { responseId: "receipt", costUsd: 0.002 } }]);
      expect(calls).toBe(1);
    } finally { await store.close(); }
  });
});
