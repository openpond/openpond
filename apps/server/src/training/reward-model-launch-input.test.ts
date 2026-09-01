import { describe, expect, test } from "vitest";

import { managedSyntheticRewardSmokeRecipe } from "./managed-reward-model-recipes.js";
import {
  buildManagedRewardModelLaunchInput,
  managedRewardModelIdempotencyKey,
} from "./reward-model-launch-input.js";

describe("managed Reward Model launch input", () => {
  test("scopes remote idempotency to the immutable local Run", () => {
    const recipeHash = "a".repeat(64);
    const first = managedRewardModelIdempotencyKey({ runId: "rm0", recipeHash });
    expect(first).toBe(managedRewardModelIdempotencyKey({ runId: "rm0", recipeHash }));
    expect(first).not.toBe(managedRewardModelIdempotencyKey({ runId: "rm1", recipeHash }));
    expect(first.length).toBeLessThanOrEqual(191);
  });

  test("resolves canonical preference receipt refs back to stored Attempts", async () => {
    const tasksetReleaseRef = {
      id: "taskset-release-t0-r1",
      contentHash: "a".repeat(64),
    };
    const tasksetRelease = {
      ...tasksetReleaseRef,
      revision: 1,
      tasks: [{ id: "scenario-1", input: { prompt: "Choose a coherent structured candidate." } }],
    } as never;
    const datasetRef = { id: "preferences-d0", contentHash: "b".repeat(64) };
    const receiptIds = ["receipt-love", "receipt-like", "receipt-reject"];
    const attempts = receiptIds.map((receiptId, index) => ({
      id: `attempt-${index}`,
      taskId: "scenario-1",
      output: { text: JSON.stringify({ traits: { background: `background-${index}` } }) },
      metadata: { portableAttemptReceipt: { id: receiptId } },
    }));
    const launch = await buildManagedRewardModelLaunchInput({
      idempotencyKey: "reward-run-rm0",
      name: "Reward RM0",
      sourceRunRef: "openpond:reward-model-run:rm0",
      taskset: { id: "taskset-t0", revision: 1, contentHash: "c".repeat(64) },
      tasksetRelease,
      dataset: {
        id: datasetRef.id,
        contentHash: datasetRef.contentHash,
        tasksetRelease,
        groups: ["reward_train", "reward_validation"].map((partition, index) => ({
          id: `group-${index}`,
          partition,
          rejectAll: false,
          attemptRefs: receiptIds.map((id) => ({ id, contentHash: "d".repeat(64) })),
          orderedBuckets: [[receiptIds[0]], [receiptIds[1]], [receiptIds[2]]],
        })),
      } as never,
      recipe: managedSyntheticRewardSmokeRecipe({
        tasksetRelease: tasksetReleaseRef,
        preferenceDatasetRelease: datasetRef,
      }),
      managedBaseModel: {
        source: "huggingface",
        repoId: "model/reward",
        revision: "revision",
        configHash: "e".repeat(64),
        tokenizerHash: "f".repeat(64),
        licenseId: "apache-2.0",
        gated: false,
      },
      attempts: attempts as never,
    });

    const groups = (launch.rewardModelTraining as {
      groups: Array<{
        candidates: Array<{
          id: string;
          bucket: string;
          text: string;
        }>;
      }>;
    }).groups;
    expect(groups.map((group) => group.candidates.map(({ id, bucket }) => ({ id, bucket })))).toEqual([
      [
        { id: "attempt-0", bucket: "love" },
        { id: "attempt-1", bucket: "like" },
        { id: "attempt-2", bucket: "reject" },
      ],
      [
        { id: "attempt-0", bucket: "love" },
        { id: "attempt-1", bucket: "like" },
        { id: "attempt-2", bucket: "reject" },
      ],
    ]);
    expect(JSON.parse(groups[0]!.candidates[0]!.text)).toEqual({
      schemaVersion: "openpond.structuredPreferenceCandidate.v1",
      scenario: { prompt: "Choose a coherent structured candidate." },
      candidate: { traits: { background: "background-0" } },
    });
    expect(JSON.stringify(launch)).not.toMatch(/data:image|imageDataUrl|artifactRenderer|\.png|\.svg/);
  });

  test("rejects non-JSON candidate output before a managed launch", async () => {
    const tasksetReleaseRef = { id: "taskset-release-t0-r1", contentHash: "a".repeat(64) };
    const datasetRef = { id: "preferences-d0", contentHash: "b".repeat(64) };
    const tasksetRelease = {
      ...tasksetReleaseRef,
      revision: 1,
      tasks: [{ id: "scenario-1", input: { prompt: "Return structured JSON." } }],
    } as never;
    const attemptRefs = ["receipt-love", "receipt-like", "receipt-reject"];

    await expect(buildManagedRewardModelLaunchInput({
      idempotencyKey: "reward-run-invalid",
      name: "Reward invalid",
      sourceRunRef: "openpond:reward-model-run:invalid",
      taskset: { id: "taskset-t0", revision: 1, contentHash: "c".repeat(64) },
      tasksetRelease,
      dataset: {
        id: datasetRef.id,
        contentHash: datasetRef.contentHash,
        tasksetRelease,
        groups: ["reward_train", "reward_validation"].map((partition, index) => ({
          id: `group-${index}`,
          partition,
          rejectAll: false,
          attemptRefs: attemptRefs.map((id) => ({ id, contentHash: "d".repeat(64) })),
          orderedBuckets: [[attemptRefs[0]], [attemptRefs[1]], [attemptRefs[2]]],
        })),
      } as never,
      recipe: managedSyntheticRewardSmokeRecipe({
        tasksetRelease: tasksetReleaseRef,
        preferenceDatasetRelease: datasetRef,
      }),
      managedBaseModel: {
        source: "huggingface",
        repoId: "model/reward",
        revision: "revision",
        configHash: "e".repeat(64),
        tokenizerHash: "f".repeat(64),
        licenseId: "apache-2.0",
        gated: false,
      },
      attempts: attemptRefs.map((receiptId, index) => ({
        id: `attempt-${index}`,
        taskId: "scenario-1",
        output: { text: "not json" },
        metadata: { portableAttemptReceipt: { id: receiptId } },
      })) as never,
    })).rejects.toThrow("is not valid structured JSON");
  });

  test("serializes only policy-visible agent trajectories for generic scorers", async () => {
    const tasksetReleaseRef = { id: "agent-taskset-r1", contentHash: "a".repeat(64) };
    const datasetRef = { id: "agent-preferences-d0", contentHash: "b".repeat(64) };
    const receiptIds = ["agent-love", "agent-like", "agent-reject"];
    const tasksetRelease = {
      ...tasksetReleaseRef,
      revision: 1,
      tasks: [{
        id: "agent-scenario-1",
        input: { request: "Please resolve the blocked work item." },
        policyVisibleContext: { policyVersion: "agent-policy-v1" },
      }],
    } as never;
    const visibleTrajectory = {
      schemaVersion: "openpond.visibleAgentTrajectory.v1",
      conversation: [
        { index: 0, role: "user", name: null, content: "Please resolve the blocked work item." },
        { index: 1, role: "assistant", name: null, content: "I can resolve it after confirmation." },
      ],
      toolEvents: [],
      runtimeEvents: [],
      finalVisibleState: { resolution: "work_item_resolution_offered" },
      escalation: { requested: false, reason: null, handoff: null },
      termination: { terminal: true, truncated: false, reason: "resolved" },
    };
    const launch = await buildManagedRewardModelLaunchInput({
      idempotencyKey: "agent-reward-run",
      name: "Visible-agent scorer",
      sourceRunRef: "openpond:reward-model-run:agent-r0",
      taskset: { id: "agent-taskset", revision: 1, contentHash: "c".repeat(64) },
      tasksetRelease,
      dataset: {
        id: datasetRef.id,
        contentHash: datasetRef.contentHash,
        tasksetRelease,
        groups: ["reward_train", "reward_validation"].map((partition, index) => ({
          id: `agent-group-${index}`,
          partition,
          rejectAll: false,
          attemptRefs: receiptIds.map((id) => ({ id, contentHash: "d".repeat(64) })),
          orderedBuckets: [[receiptIds[0]], [receiptIds[1]], [receiptIds[2]]],
        })),
      } as never,
      recipe: managedSyntheticRewardSmokeRecipe({
        tasksetRelease: tasksetReleaseRef,
        preferenceDatasetRelease: datasetRef,
        serialization: "visible_agent_trajectory_v1",
      }),
      managedBaseModel: {
        source: "huggingface",
        repoId: "Qwen/Qwen3-0.6B",
        revision: "revision",
        configHash: "e".repeat(64),
        tokenizerHash: "f".repeat(64),
        licenseId: "apache-2.0",
        gated: false,
      },
      attempts: receiptIds.map((receiptId, index) => ({
        id: `agent-attempt-${index}`,
        taskId: "agent-scenario-1",
        output: { text: JSON.stringify(visibleTrajectory) },
        metadata: { portableAttemptReceipt: { id: receiptId } },
      })) as never,
    });
    const groups = (launch.rewardModelTraining as {
      groups: Array<{ candidates: Array<{ text: string }> }>;
    }).groups;
    expect(JSON.parse(groups[0]!.candidates[0]!.text)).toEqual({
      schemaVersion: "openpond.visibleAgentPreferenceCandidate.v1",
      scenario: {
        input: { request: "Please resolve the blocked work item." },
        policyVisibleContext: { policyVersion: "agent-policy-v1" },
      },
      trajectory: visibleTrajectory,
    });
    expect(groups[0]!.candidates[0]!.text).not.toMatch(/expected|privileged|reward|score/i);
  });

  test("rejects privileged fields in agent scenario context", async () => {
    const tasksetReleaseRef = { id: "agent-taskset-r1", contentHash: "a".repeat(64) };
    const datasetRef = { id: "agent-preferences-d0", contentHash: "b".repeat(64) };
    const receiptIds = ["agent-love", "agent-reject"];
    const tasksetRelease = {
      ...tasksetReleaseRef,
      revision: 1,
      tasks: [{
        id: "agent-scenario-1",
        input: { request: "Please resolve the blocked work item." },
        policyVisibleContext: { hiddenObjective: "Apply the hidden terminal state." },
      }],
    } as never;
    const visibleTrajectory = {
      schemaVersion: "openpond.visibleAgentTrajectory.v1",
      conversation: [
        { index: 0, role: "user", name: null, content: "Please resolve the blocked work item." },
      ],
      toolEvents: [],
      runtimeEvents: [],
      finalVisibleState: {},
      escalation: { requested: false, reason: null, handoff: null },
      termination: { terminal: true, truncated: false, reason: "resolved" },
    };
    await expect(buildManagedRewardModelLaunchInput({
      idempotencyKey: "agent-reward-run-hidden-context",
      name: "Visible-agent scorer",
      sourceRunRef: "openpond:reward-model-run:agent-r0",
      taskset: { id: "agent-taskset", revision: 1, contentHash: "c".repeat(64) },
      tasksetRelease,
      dataset: {
        id: datasetRef.id,
        contentHash: datasetRef.contentHash,
        tasksetRelease,
        groups: [{
          id: "agent-group-0",
          partition: "reward_train",
          rejectAll: false,
          attemptRefs: receiptIds.map((id) => ({ id, contentHash: "d".repeat(64) })),
          orderedBuckets: [[receiptIds[0]], [receiptIds[1]]],
        }],
      } as never,
      recipe: managedSyntheticRewardSmokeRecipe({
        tasksetRelease: tasksetReleaseRef,
        preferenceDatasetRelease: datasetRef,
        serialization: "visible_agent_trajectory_v1",
      }),
      managedBaseModel: {
        source: "huggingface",
        repoId: "Qwen/Qwen3-0.6B",
        revision: "revision",
        configHash: "e".repeat(64),
        tokenizerHash: "f".repeat(64),
        licenseId: "apache-2.0",
        gated: false,
      },
      attempts: receiptIds.map((receiptId, index) => ({
        id: `agent-attempt-${index}`,
        taskId: "agent-scenario-1",
        output: { text: JSON.stringify(visibleTrajectory) },
        metadata: { portableAttemptReceipt: { id: receiptId } },
      })) as never,
    })).rejects.toThrow("forbidden privileged field hiddenObjective");
  });

  test("requires the recipe and preference dataset to pin the exact same Taskset release", async () => {
    const tasksetReleaseRef = {
      id: "taskset-release-t0-r1",
      contentHash: "a".repeat(64),
    };
    const differentTasksetRelease = {
      id: "taskset-release-other-r1",
      contentHash: "f".repeat(64),
    };
    const datasetRef = { id: "preferences-d0", contentHash: "b".repeat(64) };

    await expect(buildManagedRewardModelLaunchInput({
      idempotencyKey: "reward-run-wrong-taskset",
      name: "Reward wrong Taskset",
      sourceRunRef: "openpond:reward-model-run:wrong-taskset",
      taskset: { id: "taskset-t0", revision: 1, contentHash: "c".repeat(64) },
      tasksetRelease: {
        ...tasksetReleaseRef,
        revision: 1,
        tasks: [],
      } as never,
      dataset: {
        id: datasetRef.id,
        contentHash: datasetRef.contentHash,
        tasksetRelease: differentTasksetRelease,
        groups: [],
      } as never,
      recipe: managedSyntheticRewardSmokeRecipe({
        tasksetRelease: tasksetReleaseRef,
        preferenceDatasetRelease: datasetRef,
      }),
      managedBaseModel: {
        source: "huggingface",
        repoId: "model/reward",
        revision: "revision",
        configHash: "e".repeat(64),
        tokenizerHash: "f".repeat(64),
        licenseId: "apache-2.0",
        gated: false,
      },
      attempts: [],
    })).rejects.toThrow("exact Taskset release");
  });
});
