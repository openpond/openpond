import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { DatasetBuildSpecification } from "@openpond/contracts";
import { contentHash, validateTaskset } from "../packages/taskset-sdk/src";
import { createTaskCreatorService } from "../apps/server/src/training/task-creator";
import { withTrainingStore } from "./helpers/training-fixtures";

describe("Task Creator typed signal materialization", () => {
  test.each([
    {
      intent: "demonstrations" as const,
      specification: {
        kind: "demonstrations" as const,
        behavior: "Answer arithmetic questions correctly.",
        examples: [{ id: "demo_1", prompt: "What is 2 + 2?", response: "4" }],
      },
      signal: "demonstrations" as const,
      method: "sft",
    },
    {
      intent: "preferences" as const,
      specification: {
        kind: "preferences" as const,
        preference: "Prefer correct, direct answers.",
        pairs: [{ id: "pair_1", prompt: "What is 2 + 2?", chosen: "4", rejected: "Probably 5.", rationale: "The chosen response is correct." }],
      },
      signal: "preferences" as const,
      method: "dpo",
    },
    {
      intent: "verifiable_reward" as const,
      specification: {
        kind: "verifiable_reward" as const,
        task: "Produce a valid SQL query.",
        rules: [
          { id: "executes", points: 1, condition: "The query executes." },
          { id: "rows", points: 1, condition: "The query returns the expected rows." },
        ],
        otherwisePoints: 0,
      },
      signal: "rewards" as const,
      method: "none",
    },
    {
      intent: "rubric" as const,
      specification: {
        kind: "rubric" as const,
        task: "Review an evidence-grounded answer.",
        criteria: [{ id: "grounded", label: "Grounded", description: "Every material claim is supported by the supplied context." }],
        positiveExample: "Every claim cites the supplied context.",
        negativeExample: "The answer invents an unsupported source.",
        boundaryExample: "The answer is correct but omits one citation.",
      },
      signal: "labels" as const,
      method: "none",
    },
  ])("materializes $intent as canonical $signal", async ({
    intent,
    specification,
    signal,
    method,
  }) => withTrainingStore(async ({ store, directory }) => {
    const profileSource = path.join(directory, "profile");
    const tasksetRootDir = path.join(directory, "training", "tasksets");
    await mkdir(profileSource, { recursive: true });
    const service = createTaskCreatorService({
      store,
      tasksetRootDir,
      authoringSkillHash: contentHash("skill"),
      loadProfileState: async () => ({
        mode: "local",
        activeProfile: "default",
        sourcePath: profileSource,
        git: { head: "commit_signal_materialization" },
      } as never),
    });

    const reviewed = await service.start({
      profileId: "default",
      sourceIds: [],
      surface: "training_page",
      mode: "defaults",
      resourceIntent: "dataset",
      objective: "Build a typed signal Dataset.",
      buildIntent: intent,
      buildSpecification: specification as DatasetBuildSpecification,
      targetIntent: {
        kind: null,
        id: null,
        displayName: null,
        operation: "create",
      },
    });
    expect(reviewed.state).toBe("awaiting_materialization_approval");

    const completed = await service.approveMaterialization(reviewed.id, true);
    expect(completed.state).toBe("ready");
    const taskset = await store.getTaskset(completed.materializedTasksetId!);
    expect(taskset).not.toBeNull();
    expect(taskset!.learningSignals[signal]).toHaveLength(1);
    expect(taskset!.capabilities.compatibleMethods).toContain(method);
    expect(taskset!.authoringProvenance.buildSpecification?.kind).toBe(intent);
    expect(validateTaskset(taskset).issues.filter((issue) => issue.severity === "error")).toEqual([]);
  }));
});
