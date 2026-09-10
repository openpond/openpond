import { expect, test } from "vitest";
import { createRewardRelease, RewardReleaseSchema } from "@openpond/evals/rewards";
import {
  AuthoringDraftSchema, compileRewardAuthoring, createRewardCheckWorker, createTaskGradeWorker, learningRef, rewardAuthoringFields,
  RewardCheckRunSchema, TaskGradeRunSchema, type BoundJudgeProvider,
} from "@openpond/evals/learning";
import { SqliteLearningStore } from "../apps/server/src/store/store-learning";
import { createLocalRewardCheckExecutor } from "../apps/server/src/training/learning-reward-check-executor";
import { createLocalTaskGradeExecutor } from "../apps/server/src/training/learning-grade-executor";
import { learningContext, learningFixture } from "./helpers/learning-fixtures";
import { withTempDirectory } from "./helpers/temp-directory";

// A completed check must promote only its exact model/rubric/fixtures. The
// resulting immutable release must then grade through the same budgeted runner.
test("checked judges publish exact calibration evidence and grade bound examples", async () => {
  await withTempDirectory("openpond-calibrated-reward-", async home => {
    const store = new SqliteLearningStore(home);
    try {
      const repository = store.learningRepository();
      const setup = await learningFixture(repository);
      let calls = 0;
      const provider: BoundJudgeProvider = {
        async cancel() { return true; },
        async prepare(request, context) {
          expect(request).toMatchObject({ providerId: "openpond", modelId: "judge", temperature: 0 });
          expect(context).toMatchObject({ scope: learningContext.scope, run: { requestedBy: learningContext.actor.id } });
          return { maximumChargeUsd: 0.004, async dispatch() {
            calls++;
            const passed = JSON.parse(request.data).attempt.output.answer === "yes";
            return { text: JSON.stringify({ score: passed ? 1 : 0, passed, feedback: passed ? "Supported" : "Unsupported" }),
              modelId: "judge", modelRevision: null, responseId: `response-${calls}`, inputTokens: 20, outputTokens: 10, costUsd: 0.001 };
          } };
        },
      };
      const fields = { ...rewardAuthoringFields(null, null), name: "Checked judge", kind: "model_judge" as const,
        rubric: "Require the answer yes.", providerId: "openpond", modelId: "judge", fixtures: [true, false].map(passed => ({
          id: passed ? "positive" : "negative", name: passed ? "Positive" : "Negative", input: "{}", output: JSON.stringify({ answer: passed ? "yes" : "no" }),
          expectedOutput: '{"answer":"yes"}', evaluatorContext: "{}", artifactRefs: [], runtimeEventRefs: [], infrastructureError: "",
          expectedStatus: "scored" as const, minimumScore: passed ? "1" : "0", maximumScore: passed ? "1" : "0", expectedPassed: passed ? "true" as const : "false" as const,
        })) };
      const draft = AuthoringDraftSchema.parse((await setup.command({ action: "save_draft", expectedRevision: 0,
        draft: { id: "judge-draft", targetId: "judge", targetKind: "reward", baseRelease: null, editorVersion: "openpond.modelsEditor.v1", fields } })).resources[0]);
      const queued = RewardCheckRunSchema.parse((await setup.command({ action: "queue_reward_check", draft: learningRef(draft), maximumSpendUsd: 0.01 })).resources[0]);
      await expect(setup.command({ action: "publish_checked_reward", draft: learningRef(draft), checkId: queued.id, checkRevision: queued.revision })).rejects.toThrow("check_incomplete");
      const check = await createRewardCheckWorker(repository, createLocalRewardCheckExecutor(repository, provider), { workerId: "calibration" }).run(learningContext.scope, queued.id);
      expect(check.matchesExpectations).toBe(true);
      const publication = await setup.command({ action: "publish_checked_reward", draft: learningRef(draft), checkId: check.id, checkRevision: check.revision });
      const reward = RewardReleaseSchema.parse(publication.resources.find(value => value.schemaVersion === "openpond.rewardRelease.v1"));
      expect(reward.implementation).toMatchObject({ calibrationStatus: "passed", model: { providerId: "openpond", modelId: "judge" } });
      expect(reward.calibrationCheckRef).toMatchObject({ id: check.id, revision: check.revision });
      expect(publication.resources.find(value => value.schemaVersion === "openpond.authoringDraft.v1")).toMatchObject({ status: "published" });
      if (reward.implementation.kind !== "model_judge") throw new Error("Missing judge implementation");
      const { contentHash: _hash, ...rewardContent } = reward;
      const forged = createRewardRelease({ ...rewardContent, revision: 2,
        implementation: { ...reward.implementation, kind: "model_judge", temperature: 0.5 } });
      const { contentHash: _forgedHash, ...forgedContent } = forged;
      await expect(setup.command({ action: "publish", kind: "reward", expectedRevision: 1, content: forgedContent })).rejects.toThrow("configuration_changed");
      const changed = compileRewardAuthoring({ id: reward.id, base: reward, fields: { ...fields, rubric: "A different scoring rule." } }).reward;
      expect(changed.implementation).toMatchObject({ calibrationStatus: "pending" });
      expect(changed.calibrationCheckRef).toBeUndefined();
      const renamed = compileRewardAuthoring({ id: reward.id, base: reward, fields: { ...fields, name: "Renamed judge" } }).reward;
      const { contentHash: _renamedHash, ...renamedContent } = renamed;
      expect((await setup.command({ action: "publish", kind: "reward", expectedRevision: 1, content: renamedContent })).resources[0]).toMatchObject({ revision: 2, calibrationCheckRef: reward.calibrationCheckRef });
      const { contentHash: _bindingHash, ...bindingContent } = setup.binding;
      const binding = (await setup.command({ action: "publish", kind: "binding", expectedRevision: 1,
        content: { ...bindingContent, revision: 2, sources: bindingContent.sources.map(source => ({ ...source, reward: learningRef(reward) })) } })).resources[0]!;
      if (!("contentHash" in binding)) throw new Error("Missing binding release");
      const { contentHash: _definitionHash, ...definitionContent } = setup.definition;
      const definition = (await setup.command({ action: "publish", kind: "definition", expectedRevision: 1,
        content: { ...definitionContent, revision: 2, rewardBinding: learningRef(binding) } })).resources[0]!;
      if (!("contentHash" in definition)) throw new Error("Missing task release");
      const { contentHash: _sourceHash, ...sourceContent } = setup.source;
      await setup.command({ action: "publish", kind: "source", expectedRevision: 1, content: { ...sourceContent, revision: 2, taskDefinition: learningRef(definition) } });
      const evidence = await setup.submit({ taskDefinition: learningRef(definition), observedOutput: { answer: "yes" } });
      const grade = TaskGradeRunSchema.parse((await setup.command({ action: "queue_grade", evidence: learningRef(evidence), target: "observed", proposedTarget: null, maximumSpendUsd: 0.01 })).resources[0]);
      const result = await createTaskGradeWorker(repository, createLocalTaskGradeExecutor(repository, provider), { workerId: "grade" }).run(learningContext.scope, grade.id);
      expect(result).toMatchObject({ status: "completed", composition: { training: { status: "scored", passed: true } }, judgeCalls: [{ status: "settled", response: { costUsd: 0.001 } }] });
      expect(calls).toBe(3);
    } finally { await store.close(); }
  });
});
