import { expect, test } from "vitest";
import { contentHash } from "@openpond/harness";
import { AuthoringDraftSchema, createBudgetedJudgeExecutor, createBudgetedRewardFixtureExecutor, createLearningService, createRewardCheckJudgeBudgetStore, createRewardCheckWorker, learningRef, rewardAuthoringFields, RewardCheckRunSchema } from "@openpond/evals/learning";
import { executeJavaScriptVerifierInWorker } from "@openpond/evals/javascript-verifier/node";
import { SqliteLearningStore } from "../apps/server/src/store/store-learning";
import { withTempDirectory } from "./helpers/temp-directory";
import { learningContext } from "./helpers/learning-fixtures";

test("queued draft judge fixtures retain scores and budget receipts while zero budget prevents dispatch", async () => {
  await withTempDirectory("openpond-budgeted-fixtures-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      const repository = store.learningRepository();
      const service = createLearningService(repository);
      const saved = AuthoringDraftSchema.parse((await service.command(learningContext, { action: "save_draft", operationId: "save", expectedRevision: 0,
        draft: { id: "judge-draft", targetId: "judge", targetKind: "reward", baseRelease: null, editorVersion: "openpond.modelsEditor.v1", fields: {
          ...rewardAuthoringFields(null, null), name: "Judge", kind: "model_judge", rubric: "Require a supported answer.", providerId: "openai", modelId: "judge-model",
          fixtures: [{ id: "positive", name: "Positive", input: "{}", output: '{"answer":"yes"}', expectedOutput: '{"answer":"yes"}', evaluatorContext: "{}", artifactRefs: [], runtimeEventRefs: [], infrastructureError: "", expectedStatus: "scored", minimumScore: "1", maximumScore: "1", expectedPassed: "true" }],
        } },
      })).resources[0]);
      let calls = 0;
      const executor = createBudgetedRewardFixtureExecutor({ repository, runtime: { id: "test-judge", packageVersion: "test", engine: "mock provider" }, executeJavaScript: executeJavaScriptVerifierInWorker,
        provider: { async cancel() { return true; }, async prepare(request) {
          expect(request.modelId).toBe("judge-model");
          return { maximumChargeUsd: 0.004, async dispatch() { calls++; return { text: '{"score":1,"passed":true,"feedback":"Supported"}', modelId: "judge-model", modelRevision: null, responseId: "response", inputTokens: 10, outputTokens: 5, costUsd: 0.001 }; } };
        } },
      });
      const worker = createRewardCheckWorker(repository, executor, { workerId: "judge-worker" });
      const queue = async (operationId: string, maximumSpendUsd: number) => RewardCheckRunSchema.parse((await service.command(learningContext, { action: "queue_reward_check", operationId, draft: learningRef(saved), maximumSpendUsd })).resources[0]);
      const allowed = await worker.run(learningContext.scope, (await queue("allowed", 0.01)).id);
      expect(allowed.status).toBe("completed");
      expect(allowed.matchesExpectations).toBe(true);
      expect(allowed.results[0]?.result.graderEvidence?.modelJudgeReceipt?.costUsd).toBe(0.001);
      expect(allowed.judgeCalls?.[0]?.response?.costUsd).toBe(0.001);
      const denied = await worker.run(learningContext.scope, (await queue("denied", 0)).id);
      expect(denied.matchesExpectations).toBe(false);
      expect(denied.results[0]?.result.message).toContain("budget_exceeded");
      expect(calls).toBe(1);
    } finally { await store.close(); }
  });
});

// The budget must outlive a worker process and permit late settlement after
// cancellation without allowing any new provider dispatch.
test("judge reservations survive SQLite reopen and settle after cancellation", async () => {
  await withTempDirectory("openpond-judge-budget-", async home => {
    let store = new SqliteLearningStore(home);
    const scope = "judge-budget-workspace";
    const run = RewardCheckRunSchema.parse({ schemaVersion: "openpond.rewardCheckRun.v1", id: "check", revision: 1,
      draft: { id: "draft", revision: 1, contentHash: contentHash("draft") }, reward: { id: "reward", revision: 1, contentHash: contentHash("reward") }, snapshotHash: contentHash("snapshot"),
      fixtureRefs: [{ id: "fixture", contentHash: contentHash("fixture") }], status: "running", runtime: null, results: [], matchesExpectations: null, failure: null,
      timeoutMs: 30_000, maximumSpendUsd: 0.03, leaseOwner: "worker", leaseExpiresAt: "2099-01-01T00:00:00.000Z", attemptCount: 1,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    const request = { providerId: "openai", modelId: "judge", revision: null, temperature: 0, system: "Rubric", data: "{}" };
    let calls = 0;
    try {
      await store.learningRepository().transaction(scope, tx => tx.put("reward_check", run, 0, { parentId: "reward", status: "running" }));
      const budget = () => createRewardCheckJudgeBudgetStore({ repository: store.learningRepository(), scope, run });
      const lost = createBudgetedJudgeExecutor({ store: budget(), maximumCharge: () => 0.01, dispatch: async () => { calls++; throw new Error("Provider connection lost"); } });
      await expect(lost("first", request)).rejects.toThrow("Provider connection lost");
      await store.close();
      store = new SqliteLearningStore(home);
      const restarted = createBudgetedJudgeExecutor({ store: budget(), maximumCharge: () => 0.01, dispatch: async () => { calls++; throw new Error("Must not dispatch"); } });
      await expect(restarted("first", request)).rejects.toThrow("charge_unresolved");
      expect(calls).toBe(1);

      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const pending = new Promise<void>(resolve => { release = resolve; });
      const response = { text: "{}", modelId: "judge", modelRevision: null, responseId: "response", inputTokens: 10, outputTokens: 2, costUsd: 0.005 };
      const execute = createBudgetedJudgeExecutor({ store: budget(), maximumCharge: () => 0.01, dispatch: async () => { calls++; entered(); await pending; return response; } });
      const execution = execute("second", request);
      await started;
      await store.learningRepository().transaction(scope, async tx => {
        const current = (await tx.get("reward_check", run.id))!;
        await tx.put("reward_check", { ...current, revision: current.revision + 1, status: "cancelling" }, current.revision, { parentId: "reward", status: "cancelling" });
      });
      release();
      expect(await execution).toEqual(response);
      await expect(execute("third", request)).rejects.toThrow("owner_inactive");
      const retained = await store.learningRepository().transaction(scope, tx => tx.get("reward_check", run.id));
      expect(retained?.judgeCalls?.map(call => [call.id, call.status, call.response?.costUsd ?? null])).toEqual([["first", "reserved", null], ["second", "settled", 0.005]]);
      expect(calls).toBe(2);
    } finally { await store.close(); }
  });
});
