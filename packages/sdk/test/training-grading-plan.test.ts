import { expect, it } from "vitest";
import { createRewardBinding, createRewardRelease } from "@openpond/evals/rewards";
import { deterministicTrainingRewardSource } from "../src/training.js";

// A change beyond the first grader must invalidate the approved input identity.
it("identifies the whole ordered grader set", async () => {
  const graders = [{ id: "answer", kind: "content", config: { operator: "exact_equals" } }, { id: "format", kind: "schema", config: { required: ["answer"] } }];
  const source = await deterministicTrainingRewardSource({ graders });
  expect(source).toEqual(await deterministicTrainingRewardSource({ graders: structuredClone(graders) }));
  expect(source.composer).toBeNull();
  for (const changed of [graders.slice(0, 1), [...graders].reverse(), [graders[0], { ...graders[1], config: { required: [] } }]]) {
    expect((await deterministicTrainingRewardSource({ graders: changed })).grader).not.toEqual(source.grader);
  }
  await expect(deterministicTrainingRewardSource({ graders: [graders[0], graders[0]] })).rejects.toThrow("unique");
});

// Composition changes can preserve compiled grader code; they still change admission identity.
it("pins the executed bound graders and exact composer", async () => {
  const reward = createRewardRelease({ schemaVersion: "openpond.rewardRelease.v1", id: "answer", revision: 1, name: "Answer", description: "Exact answer",
    implementation: { kind: "content", config: { operator: "exact_equals" } }, rawScore: { minimum: 0, maximum: 1 }, assets: [] });
  const content = { schemaVersion: "openpond.rewardBinding.v1" as const, id: "answer-binding", revision: 1,
    sources: [{ graderId: "answer", reward: { id: reward.id, revision: reward.revision, contentHash: reward.contentHash }, role: "training" as const,
      normalization: { kind: "identity" as const }, weight: 1, required: true, hardGate: false, privileged: false, fixtureRefs: [] }],
    aggregation: "weighted_mean" as const, unscorable: "exclude_optional_require_all_required" as const };
  const binding = createRewardBinding(content, [reward]);
  const source = await deterministicTrainingRewardSource({ graders: [], rewardExecution: { binding, rewards: [reward] } });
  expect(source.composer).toEqual({ id: binding.id, contentHash: binding.contentHash });
  const changed = createRewardBinding({ ...content, sources: content.sources.map(item => ({ ...item, required: false })) }, [reward]);
  const next = await deterministicTrainingRewardSource({ graders: [], rewardExecution: { binding: changed, rewards: [reward] } });
  expect(next.grader).toEqual(source.grader);
  expect(next.composer).not.toEqual(source.composer);
  await expect(deterministicTrainingRewardSource({ graders: [], rewardExecution: { binding: { ...binding, revision: 2 }, rewards: [reward] } })).rejects.toThrow("hash");
});
