import type { Taskset, TrainingPlan } from "@openpond/contracts";
import { describe, expect, it } from "vitest";
import { createTrainingPlan } from "../packages/training-sdk/src/plan.js";
import { validateTrainingCompatibility } from "../packages/training-sdk/src/compatibility.js";
import { computeTasksetHash } from "@openpond/taskset-sdk";

import { resolveManagedValidationTaskSource } from "../apps/server/src/training/managed-training-validation-tasks.js";
import { dpoRecipeFixture, ppoRecipeFixture, sftRecipeFixture, tasksetFixture } from "./helpers/training-fixtures.js";
import { managedRftRecipe } from "./helpers/managed-training-fixtures.js";

const entryRef = {
  seriesId: "series-a",
  entryId: "entry-p1",
  scheduleEntryId: "schedule-p1",
  ordinal: 1,
  releaseHash: "a".repeat(64),
};

function taskset(id: string, splits: Array<"train" | "validation" | "frozen_eval">): Taskset {
  const base = tasksetFixture({ ready: true, profileId: "profile-a" });
  const result: Taskset = {
    ...base,
    id,
    revision: 1,
    profileId: "profile-a",
    contentHash: `${id === "train" ? "b" : "c"}`.repeat(64),
    tasks: splits.map((split, index) => ({ ...base.tasks[0], id: `${id}-${index}`, clusterKey: `${id}-family-${index}`, split })),
    environment: { ...base.environment, kind: "chat", entrypoint: "openpond.text.v1" },
    capabilities: { ...base.capabilities, requiresState: false, requiresTools: false },
    metadata: {},
  };
  return { ...result, contentHash: computeTasksetHash(result) };
}

function plan(comparisonSeriesEntry: typeof entryRef | null): TrainingPlan {
  return { comparisonSeriesEntry } as TrainingPlan;
}

describe("managed continual-learning validation source", () => {
  // Separate held-out selection must unblock compatibility without hiding missing training evidence.
  it("uses the pinned evaluation source for DPO and PPO compatibility", () => {
    const training = taskset("train", ["train"]);
    for (const recipe of [dpoRecipeFixture(), ppoRecipeFixture()]) {
      const draft = createTrainingPlan({ modelId: "model-a", taskset: training, destinationId: "openpond_managed", recipe });
      const capabilities = { schemaVersion: "openpond.trainingDestinationCapabilities.v1" as const,
        destinationId: "openpond_managed" as const, available: true, methods: ["dpo", "ppo"] as const,
        parameterizations: ["lora"] as const, modelAllowlist: [], maxDatasetBytes: null,
        environmentPlacements: ["none", "local"] as const, nonProduction: true, unavailableReason: null,
        checkedAt: "2026-09-08T00:00:00.000Z" };
      const check = (plan: TrainingPlan) => validateTrainingCompatibility({ taskset: training, plan, capabilities });
      const missingCode = `${recipe.method}_frozen_eval_missing`;
      expect(check(draft).issues.some(issue => issue.code === missingCode)).toBe(true);
      const selected = check({ ...draft, evaluationTasksetRef: { id: "held-out", revision: 1, contentHash: "a".repeat(64) } });
      expect(selected.issues.some(issue => issue.code === missingCode)).toBe(false);
      expect(selected.compatible).toBe(false);
      expect(selected.issues.some(issue => issue.code === (recipe.method === "dpo" ? "dpo_preferences_missing" : "ppo_executable_reward_missing"))).toBe(true);
    }
  });
  // Approvals reference plan identity; changing evaluation cannot reuse it.
  it("gives different evaluation revisions different preparation identities", () => {
    const input = { modelId: "model-a", taskset: taskset("train", ["train"]), destinationId: "openpond_managed" as const, recipe: sftRecipeFixture(),
      evaluationTasksetRef: { id: "held-out", revision: 1, contentHash: "a".repeat(64) } };
    const first = createTrainingPlan(input);
    const changed = createTrainingPlan({ ...input, evaluationTasksetRef: { ...input.evaluationTasksetRef, revision: 2, contentHash: "b".repeat(64) } });
    expect(changed.id).not.toBe(first.id);
    expect(first.evaluationTasksetRef).toEqual(input.evaluationTasksetRef);
  });
  // Ordinary reviewed batches must not require an advanced Comparison Series.
  it("resolves a direct immutable held-out source and rejects substitutions or leakage", async () => {
    const training = taskset("train", ["train"]);
    const heldOut = taskset("held-out", ["validation"]);
    const reference = { id: heldOut.id, revision: heldOut.revision, contentHash: heldOut.contentHash };
    const resolve = (selected: Taskset | null, selectedReference = reference) => resolveManagedValidationTaskSource({
      store: { getTasksetRevision: async () => selected } as never,
      trainingPlan: { evaluationTasksetRef: selectedReference }, trainingTaskset: training,
    });
    expect((await resolve(heldOut)).tasks).toEqual(heldOut.tasks);
    const withRecipe = (recipe: ReturnType<typeof sftRecipeFixture>) => resolveManagedValidationTaskSource({
      store: { getTasksetRevision: async () => heldOut } as never,
      trainingPlan: { evaluationTasksetRef: reference, recipe }, trainingTaskset: training,
    });
    const frozenRecipe = sftRecipeFixture();
    await expect(withRecipe(frozenRecipe)).rejects.toThrow(/declared frozen_eval split/);
    expect((await withRecipe({ ...frozenRecipe, dataset: { ...frozenRecipe.dataset, validationSplit: "validation" } })).tasks).toEqual(heldOut.tasks);
    for (const invalid of [null, { ...heldOut, revision: 3 }, { ...heldOut, profileId: "other-workspace" },
      { ...heldOut, tasks: [{ ...heldOut.tasks[0], clusterKey: training.tasks[0].clusterKey }] },
      { ...heldOut, graders: [{ ...heldOut.graders[0], id: "different-grader" }] },
    ]) await expect(resolve(invalid)).rejects.toThrow();
    for (const changed of [
      { ...heldOut, tasks: [{ ...heldOut.tasks[0], clusterKey: training.tasks[0].clusterKey }] },
      { ...heldOut, graders: [{ ...heldOut.graders[0], id: "different-grader" }] },
    ]) {
      const contentHash = computeTasksetHash(changed);
      await expect(resolve({ ...changed, contentHash }, { ...reference, contentHash })).rejects.toThrow(/overlap|Reward composition/);
    }
    await expect(resolveManagedValidationTaskSource({ store: {} as never, trainingPlan: {}, trainingTaskset: training })).rejects.toThrow("Select a held-out");
  });
  // A declared evaluation split must not silently absorb another held-out panel.
  it("uses the declared evaluation split without changing the immutable training Taskset", async () => {
    const training = taskset("train", ["train", "validation", "frozen_eval"]);
    const result = await resolveManagedValidationTaskSource({
      store: {} as never,
      trainingPlan: plan(null),
      trainingTaskset: training,
    });
    expect(result.taskset.id).toBe("train");
    expect(result.tasks.map((task) => task.id)).toEqual(["train-1", "train-2"]);
    for (const recipe of [sftRecipeFixture(), dpoRecipeFixture(), managedRftRecipe()]) {
      const selected = await resolveManagedValidationTaskSource({ store: {} as never,
        trainingPlan: { recipe }, trainingTaskset: training });
      expect(selected.taskset).toBe(training);
      expect(computeTasksetHash(selected.taskset)).toBe(training.contentHash);
      expect(selected.tasks).toEqual([training.tasks[2]]);
      const validation = await resolveManagedValidationTaskSource({ store: {} as never,
        trainingPlan: { recipe: { ...recipe, dataset: { ...recipe.dataset, validationSplit: "validation" } } }, trainingTaskset: training });
      expect(validation.tasks).toEqual([training.tasks[1]]);
    }
    const ppo = await resolveManagedValidationTaskSource({ store: {} as never,
      trainingPlan: { recipe: ppoRecipeFixture() }, trainingTaskset: training });
    expect(ppo.tasks).toEqual(result.tasks);
    await expect(resolveManagedValidationTaskSource({ store: {} as never,
      trainingPlan: { recipe: { dataset: { validationSplit: "frozen_eval" } } }, trainingTaskset: training })).rejects.toThrow();
  });

  it("resolves the exact sealed development panel for a train-only series release", async () => {
    const training = taskset("train", ["train"]);
    const development = taskset("development", ["train", "validation", "frozen_eval"]);
    const store = {
      getModelComparisonSeriesEntry: async () => ({ ...entryRef, id: entryRef.entryId }),
      getModelComparisonSeries: async () => ({
        profileId: "profile-a",
        scheduleSealedAt: "2026-09-01T00:00:00.000Z",
        evaluationTasksets: {
          development: {
            id: development.id,
            revision: development.revision,
            contentHash: development.contentHash,
          },
        },
      }),
      getTasksetRevision: async () => development,
    };
    const result = await resolveManagedValidationTaskSource({
      store: store as never,
      trainingPlan: plan(entryRef),
      trainingTaskset: training,
    });
    expect(result.taskset.id).toBe("development");
    expect(result.tasks.map((task) => task.id)).toEqual([
      "development-1",
      "development-2",
    ]);
    const selected = await resolveManagedValidationTaskSource({ store: store as never,
      trainingPlan: { ...plan(entryRef), recipe: managedRftRecipe() }, trainingTaskset: training });
    expect(selected.taskset).toBe(development);
    expect(selected.tasks).toEqual([development.tasks[2]]);
  });
});
