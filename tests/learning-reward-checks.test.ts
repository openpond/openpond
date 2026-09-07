import { expect, test } from "vitest";
import {
  AuthoringDraftSchema, RewardCheckRunSchema, createLearningService, createRewardCheckWorker,
  compileRewardAuthoring, learningRef, rewardAuthoringFields, type RewardFixtureAuthoringFields,
} from "@openpond/evals/learning";
import { SqliteLearningStore } from "../apps/server/src/store/store-learning";
import { createLocalRewardCheckExecutor } from "../apps/server/src/training/learning-reward-check-executor";
import { withTempDirectory } from "./helpers/temp-directory";
import { learningContext } from "./helpers/learning-fixtures";

const fixture = (id: string, output: string, score: string): RewardFixtureAuthoringFields => ({
  id, name: id, input: "{}", output, expectedOutput: '{"answer":"yes"}', evaluatorContext: '{"private":true}',
  artifactRefs: [], runtimeEventRefs: [], infrastructureError: "", expectedStatus: "scored", minimumScore: score, maximumScore: score, expectedPassed: score === "1" ? "true" : "false",
});

// Failure story: editing a draft after queuing must not change its check inputs;
// restart/retry must preserve the exact results without publishing test-only resources.
test("Reward fixtures execute exact private draft inputs and retain independent results across restart and publication", async () => {
  await withTempDirectory("openpond-reward-checks-", async home => {
    let store = new SqliteLearningStore(home);
    try {
      let service = createLearningService(store.learningRepository());
      let serial = 0;
      const command = (value: Record<string, unknown>) => service.command(learningContext, { operationId: `op-${++serial}`, ...value });
      const fields = { ...rewardAuthoringFields(null, null), name: "Answer checker", kind: "custom_verifier" as const,
        fixtures: [fixture("positive", '{"answer":"yes"}', "1"), fixture("negative", '{"answer":"no"}', "0"), { ...fixture("infrastructure", "{}", "0"), expectedStatus: "unavailable" as const, infrastructureError: "Fixture infrastructure failure" }],
      };
      const draftInput = { id: "draft", targetId: "fixture-reward", targetKind: "reward", baseRelease: null, editorVersion: "openpond.modelsEditor.v1", fields };
      const saved = AuthoringDraftSchema.parse((await command({ action: "save_draft", expectedRevision: 0, draft: draftInput })).resources[0]);
      const queue = { action: "queue_reward_check", operationId: "queue-original", draft: learningRef(saved), timeoutMs: 10_000, maximumSpendUsd: 0 };
      const queued = RewardCheckRunSchema.parse((await command(queue)).resources[0]);
      expect(RewardCheckRunSchema.parse((await command(queue)).resources[0])).toEqual(queued);
      await expect(command({ ...queue, timeoutMs: 20_000 })).rejects.toThrow("learning_idempotency_conflict");
      const updatedFields = { ...fields, code: "export function verify() { return {score: 1, passed: true, feedback: 'Always passes'}; }" };
      const updated = AuthoringDraftSchema.parse((await command({ action: "save_draft", expectedRevision: 1, draft: { ...draftInput, fields: updatedFields } })).resources[0]);
      await expect(command({ action: "queue_reward_check", draft: learningRef(saved) })).rejects.toThrow("authoring_draft_revision_stale");
      await expect(service.command({ ...learningContext, actor: { id: "source", role: "source", sourceId: "source" } }, queue)).rejects.toThrow("learning_source_not_authorized");
      await expect(service.get({ ...learningContext, scope: "another-scope" }, "reward_check", queued.id)).rejects.toThrow("learning_resource_not_found");

      await store.close();
      store = new SqliteLearningStore(home);
      service = createLearningService(store.learningRepository());
      const execution = createLocalRewardCheckExecutor();
      let executions = 0;
      const executor = { ...execution, execute: (input: Parameters<typeof execution.execute>[0]) => { executions++; return execution.execute(input); } };
      const worker = createRewardCheckWorker(store.learningRepository(), executor, { workerId: "restarted-owner" });
      const competing = createRewardCheckWorker(store.learningRepository(), executor, { workerId: "competing-owner" });
      await Promise.all([worker.run(learningContext.scope, queued.id), competing.run(learningContext.scope, queued.id)]);
      const checked = await service.get(learningContext, "reward_check", queued.id);
      expect(executions).toBe(3);
      expect(checked.attemptCount).toBe(1);
      expect(checked.status).toBe("completed");
      expect(checked.matchesExpectations).toBe(true);
      expect(checked.results.map(row => [row.fixture.id, row.result.status, row.result.rawScore])).toEqual([["positive", "scored", 1], ["negative", "scored", 0], ["infrastructure", "unavailable", null]]);
      expect(checked.runtime?.packageVersion).toBeTruthy();
      expect(await worker.run(learningContext.scope, queued.id)).toEqual(checked);
      expect(await service.get(learningContext, "reward_check", checked.id)).toEqual(checked);
      for (const kind of ["reward", "asset", "definition", "source", "evidence", "grade"] as const) expect((await service.list(learningContext, kind)).items).toHaveLength(0);

      const second = RewardCheckRunSchema.parse((await command({ action: "queue_reward_check", draft: learningRef(updated) })).resources[0]);
      const secondResult = await worker.run(learningContext.scope, second.id);
      expect(secondResult.matchesExpectations).toBe(false);
      expect(secondResult.snapshotHash).not.toBe(checked.snapshotHash);
      expect(secondResult.results.find(row => row.fixture.id === "negative")?.matchesExpectation).toBe(false);
      const compiled = compileRewardAuthoring({ id: draftInput.targetId, fields: updatedFields, base: null });
      const { contentHash: _hash, ...content } = compiled.reward;
      await command({ action: "publish_resources", resources: [
        ...compiled.assets.map(({ contentHash: _assetHash, ...content }) => ({ kind: "asset", expectedRevision: 0, content })),
        { kind: "reward", expectedRevision: 0, content },
      ], finalizeDraft: { draft: learningRef(updated), targetKind: "reward", release: learningRef(compiled.reward) } });
      const published = await service.get(learningContext, "reward", draftInput.targetId);
      expect(published.fixtureSetRef?.visibility).toBe("verifier");
      const source = await service.get(learningContext, "asset", published.implementation.kind === "custom_verifier" ? published.implementation.verifierRef.id : "missing");
      const fixtureAsset = await service.get(learningContext, "asset", published.fixtureSetRef!.id);
      expect(rewardAuthoringFields(published, source, fixtureAsset).fixtures).toEqual(updatedFields.fixtures);
      expect(await service.get(learningContext, "reward_check", checked.id)).toEqual(checked);
    } finally { await store.close(); }
  });
});

// Failure story: a cancelled runaway verifier must finish worker cleanup before
// terminal cancellation, while incomplete fixture JSON remains saveable but uncheckable.
test("Reward check cancellation terminates isolated work and malformed fixture drafts remain editable", async () => {
  await withTempDirectory("openpond-reward-cancel-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      const service = createLearningService(store.learningRepository());
      let serial = 0;
      const command = (value: Record<string, unknown>) => service.command(learningContext, { operationId: `op-${++serial}`, ...value });
      const fields = { ...rewardAuthoringFields(null, null), name: "Runaway", kind: "custom_verifier" as const,
        code: "export function verify() { while (true) {} }", fixtures: [fixture("runaway", "{", "1")],
      };
      const input = { id: "draft", targetId: "reward", targetKind: "reward", baseRelease: null, editorVersion: "openpond.modelsEditor.v1", fields };
      const unfinished = AuthoringDraftSchema.parse((await command({ action: "save_draft", expectedRevision: 0, draft: input })).resources[0]);
      await expect(command({ action: "queue_reward_check", draft: learningRef(unfinished) })).rejects.toThrow("output must be a JSON object");
      expect((await service.list(learningContext, "reward_check")).items).toHaveLength(0);
      const saved = AuthoringDraftSchema.parse((await command({ action: "save_draft", expectedRevision: 1, draft: { ...input, fields: { ...fields, fixtures: [fixture("runaway", "{}", "1")] } } })).resources[0]);
      const queued = RewardCheckRunSchema.parse((await command({ action: "queue_reward_check", draft: learningRef(saved) })).resources[0]);
      const execution = createLocalRewardCheckExecutor();
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      let settled = false;
      const worker = createRewardCheckWorker(store.learningRepository(), { ...execution, async execute(input) { started(); try { return await execution.execute(input); } finally { settled = true; } } }, { workerId: "cancel-owner" });
      const running = worker.run(learningContext.scope, queued.id);
      await ready;
      const current = await service.get(learningContext, "reward_check", queued.id);
      await command({ action: "cancel_reward_check", checkId: current.id, expectedRevision: current.revision });
      worker.requestCancellation(learningContext.scope, current.id);
      const cancelled = await running;
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.matchesExpectations).toBeNull();
      expect(settled).toBe(true);
      expect(await worker.run(learningContext.scope, queued.id)).toEqual(cancelled);
    } finally { await store.close(); }
  });
});
