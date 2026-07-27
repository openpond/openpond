import { describe, expect, test } from "vitest";
import {
  CROSS_SYSTEM_LOCAL_TOOL_SYSTEM_PROMPT,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CrossSystemTrajectorySchema,
  DEFAULT_CROSS_SYSTEM_WORLD_SPECS,
} from "@openpond/contracts";
import {
  buildCrossSystemBootstrapDataset,
  buildExpertCrossSystemTrajectories,
  CrossSystemEnvironment,
  CrossSystemToolError,
  crossSystemAdversarialAnswers,
  crossSystemGeneratedTaskFiles,
  generateCrossSystemSuite,
  generateCrossSystemTasks,
  generateCrossSystemWorld,
  verifyCrossSystemTrajectory,
} from "../apps/server/src/training/cross-system-operations";

describe("Cross-System Operations environment", () => {
  test("generates deterministic, balanced, split-isolated worlds", () => {
    const first = generateCrossSystemWorld({
      seed: 41,
      split: "train",
      difficulty: "hard",
    });
    const repeated = generateCrossSystemWorld({
      seed: 41,
      split: "train",
      difficulty: "hard",
    });
    const frozen = generateCrossSystemWorld({
      seed: 77,
      split: "frozen_eval",
      difficulty: "hard",
    });
    expect(repeated).toEqual(first);
    expect(first.toolContractHash).toBe(CROSS_SYSTEM_TOOL_CONTRACT_HASH);
    expect(generateCrossSystemTasks(first)).toHaveLength(15);
    expect(
      new Set(first.accounts.map((account) => account.accountId))
        .intersection(
          new Set(frozen.accounts.map((account) => account.accountId)),
        ).size,
    ).toBe(0);
    expect(() =>
      generateCrossSystemSuite({
        trainSeeds: [1],
        validationSeeds: [1],
        frozenEvalSeeds: [2],
      })
    ).toThrow("reused");
  });

  test("keeps the portable suite below the Taskset file limit", () => {
    const worlds = DEFAULT_CROSS_SYSTEM_WORLD_SPECS.map(
      generateCrossSystemWorld,
    );
    const files = crossSystemGeneratedTaskFiles({
      worlds,
      tasks: worlds.flatMap(generateCrossSystemTasks),
    });
    expect(
      files.every((file) => file.content.length <= 250_000),
    ).toBe(true);
    expect(files.map((file) => file.path)).toContain(
      "environment/worlds.json",
    );
  });

  test("enforces tool schemas, cursors, and the Python sandbox", async () => {
    const world = generateCrossSystemWorld({
      seed: 9,
      split: "train",
      difficulty: "easy",
    });
    const task = generateCrossSystemTasks(world)[0]!;
    const environment = new CrossSystemEnvironment({
      attemptId: "attempt_bounds",
      world,
      task,
    });
    try {
      const first = await environment.execute("search_crm", {
        query: "*",
        fields: ["account_id", "name"],
        cursor: null,
        limit: 2,
      });
      expect(first.items).toHaveLength(2);
      await expect(
        environment.execute("search_crm", {
          query: "*",
          fields: ["account_id"],
          cursor: "tampered",
          limit: 2,
        }),
      ).rejects.toMatchObject({ code: "cursor_invalid" });
      expect(
        await environment.execute("run_python", {
          code: "counter = 4\n_result = counter",
        }),
      ).toMatchObject({ result: 4 });
      await expect(
        environment.execute("run_python", {
          code: "import socket\n_result = socket.socket()",
        }),
      ).rejects.toBeInstanceOf(CrossSystemToolError);
    } finally {
      await environment.close();
    }
  });

  test("separates exact reward from parse and infrastructure outcomes", () => {
    const world = generateCrossSystemWorld({
      seed: 12,
      split: "frozen_eval",
      difficulty: "medium",
    });
    const task = generateCrossSystemTasks(world)[0]!;
    const base = {
      schemaVersion: "openpond.crossSystemOperations.v1" as const,
      id: "trajectory_exact",
      worldId: world.id,
      taskId: task.id,
      toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      modelRef: null,
      status: "completed" as const,
      steps: [
        {
          kind: "final" as const,
          turn: 1,
          content: `ANSWER: ${JSON.stringify(task.expectedAnswer)}`,
        },
      ],
      startedAt: "2026-07-13T00:00:00.000Z",
      completedAt: "2026-07-13T00:00:01.000Z",
      infrastructureError: null,
      metadata: {},
    };
    expect(
      verifyCrossSystemTrajectory({
        task,
        trajectory: CrossSystemTrajectorySchema.parse(base),
      }),
    ).toMatchObject({
      outcome: "correct",
      exactAnswer: true,
      rewardEligible: true,
    });
    expect(crossSystemAdversarialAnswers(task)).toHaveLength(5);
  });

  test("materializes only approved exact expert trajectories", async () => {
    const suite = generateCrossSystemSuite({
      trainSeeds: [11],
      validationSeeds: [],
      frozenEvalSeeds: [29],
      difficulties: ["hard"],
    });
    const expert = await buildExpertCrossSystemTrajectories({
      worlds: suite.worlds,
      tasks: suite.tasks,
    });
    const records = buildCrossSystemBootstrapDataset({
      tasks: suite.tasks,
      trajectories: expert.trajectories,
      results: expert.results,
      approvedTrajectoryIds: expert.trajectories.map(
        (trajectory) => trajectory.id,
      ),
      approvedBy: "local_user",
      approvedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(records).toHaveLength(expert.results.length);
    expect(
      records.every(
        (record) =>
          record.messages[0]?.role === "system"
          && record.messages[0].content
            === CROSS_SYSTEM_LOCAL_TOOL_SYSTEM_PROMPT,
      ),
    ).toBe(true);
    expect(
      records.every((record) =>
        record.messages.some((message) => message.role === "tool")
      ),
    ).toBe(true);
  });
});
