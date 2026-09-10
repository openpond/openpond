import { expect, it } from "vitest";
import { createRewardBinding, executeRewardBinding } from "../src/rewards.js";
import { learningRef, sealLearningContent, sealTaskBatch, TaskDefinitionSchema } from "../src/learning/index.js";

// Importing attempts before selecting a scorer must never imply a passing
// grade or make those attempts eligible for reward training.
it("retains an unconfigured binding without producing a score or admitting training", async () => {
  const binding = createRewardBinding({ schemaVersion: "openpond.rewardBinding.v1", id: "unconfigured", revision: 1,
    sources: [], aggregation: "weighted_mean", unscorable: "exclude_optional_require_all_required" }, []);
  const composition = await executeRewardBinding({ binding, rewards: [],
    task: { id: "task", clusterKey: "family", split: "train", input: { prompt: "Help" }, expectedOutput: null, privilegedContextRef: null, policyVisibleContext: {}, artifactRefs: [], tags: [] },
    evidence: { output: { text: "An imported response" }, artifactRefs: [], runtimeEventRefs: [] } });
  expect(composition.results).toEqual([]);
  expect(composition.training).toEqual({ status: "not_configured", score: null, passed: null });
  expect(composition.evaluation).toEqual(composition.training);
  const definition = TaskDefinitionSchema.parse(sealLearningContent({
    schemaVersion: "openpond.taskDefinition.v1", id: "definition", revision: 1, name: "Imported attempts",
    description: "Awaiting a scorer", instructions: "Review imported context.", category: "custom", familyNamespace: "import",
    inputSchema: { type: "object" }, outputSchema: { type: "object" }, rewardBinding: learningRef(binding), harness: null,
    execution: { policy: { policyVisibleFields: ["input"], privilegedFields: ["expectedOutput"], hiddenGraderRefs: [], connectedAppScopes: [] },
      environment: { protocolVersion: "openpond.environment.v1", kind: "text", entrypoint: "openpond.text.v1", stateful: false,
        deterministicSeeds: true, lifecycle: ["create", "reset", "step", "collect", "destroy"], networkPolicy: "none", defaultTimeoutMs: 30_000 }, tools: [], capabilities: [] },
  }));
  expect(() => sealTaskBatch({ id: "batch", definition, binding, rewards: [], purpose: "reward_training", evidence: [],
    decisions: [], priorSplits: [], actorId: "reviewer", now: "2026-09-09T00:00:00.000Z" })).toThrow("training_reward_not_configured");
});
