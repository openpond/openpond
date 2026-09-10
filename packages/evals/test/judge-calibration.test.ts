import { expect, it } from "vitest";
import { compileRewardAuthoring, rewardAuthoringFields } from "../src/learning/reward-authoring.js";
import { executeRewardFixture } from "../src/learning/reward-checks.js";
import { composeBoundRewards, createRewardBinding, executeRewardBinding } from "../src/rewards.js";
import { learningRef } from "../src/learning/contracts.js";
import { contentHash } from "@openpond/harness";
import { TaskRecordSchema } from "../src/tasksets.js";

// A draft judge must be testable before qualification, without the fixture
// exception allowing it to score real training or silently changing its release.
it("calibrates a pending judge only through evaluation fixtures and preserves its pending release", async () => {
  const { reward } = compileRewardAuthoring({ id: "draft-judge", base: null, fields: {
    ...rewardAuthoringFields(null, null), name: "Judge", kind: "model_judge",
    rubric: "Score whether the response answers the request.", providerId: "openai", modelId: "test-judge",
  } });
  const original = structuredClone(reward);
  let calls = 0;
  const modelJudgeReceipt = { schemaVersion: "openpond.modelJudgeReceipt.v1" as const, providerId: "openai", modelId: "test-judge", modelRevision: null, responseId: "response-1", requestHash: contentHash("request"), responseHash: contentHash("response"), inputTokens: 10, outputTokens: 5, costUsd: 0.001 };
  const modelJudge = async () => { calls++; return { score: 1, passed: true, rewardEligible: true, failureClass: null, feedback: ["Answers the request."], visibleEvidenceRefs: [], privilegedEvidenceRefs: [], modelJudgeReceipt }; };
  const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: "judge-binding", revision: 1,
    sources: [{ graderId: reward.id, reward: learningRef(reward), role: "training", normalization: { kind: "identity" }, weight: 1, required: true, hardGate: false, privileged: true, fixtureRefs: [] }],
    aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required",
  }, [reward]);
  const input = { binding, rewards: [reward], task: TaskRecordSchema.parse({ id: "task", clusterKey: "task", split: "validation", input: {}, expectedOutput: null, privilegedContextRef: null }), evidence: { output: {}, artifactRefs: [], runtimeEventRefs: [] }, modelJudge };
  expect((await executeRewardBinding(input)).results[0]?.status).toBe("unavailable");
  expect(calls).toBe(0);
  await expect(executeRewardBinding({ ...input, purpose: "fixture_calibration" })).rejects.toThrow("reward_calibration_requires_evaluation_binding");
  const result = await executeRewardFixture({ reward, modelJudge, fixture: {
    id: "positive", name: "Positive", input: {}, output: {}, expectedOutput: null, evaluatorContext: {}, artifactRefs: [], runtimeEventRefs: [], infrastructureError: null,
    expected: { status: "scored", minimum: 1, maximum: 1, passed: true },
  } });
  expect(result.status).toBe("scored");
  expect(result.graderEvidence?.modelJudgeReceipt).toEqual(modelJudgeReceipt);
  expect(result.graderEvidence?.rewardEligible).toBe(false);
  expect(result.evidenceHashes).toEqual([result.graderEvidence?.contentHash]);
  const { contentHash: _bindingHash, ...bindingContent } = binding;
  const evaluationBinding = createRewardBinding({ ...bindingContent, sources: binding.sources.map(source => ({ ...source, role: "evaluation" as const })) }, [reward]);
  const composition = { binding: evaluationBinding, taskHash: contentHash(input.task), outputHash: contentHash(input.evidence), results: [result] };
  expect(() => composeBoundRewards(composition)).not.toThrow();
  const corrupted = structuredClone(result);
  corrupted.graderEvidence!.modelJudgeReceipt!.costUsd = 0;
  expect(() => composeBoundRewards({ ...composition, results: [corrupted] })).toThrow("reward_grader_evidence_mismatch");
  expect(calls).toBe(1);
  expect(reward).toEqual(original);
  expect((await executeRewardBinding(input)).results[0]?.status).toBe("unavailable");
  expect(calls).toBe(1);
});
