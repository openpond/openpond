import { describe, expect, test } from "vitest";
import { TaskDataRecordSchema, TasksetEnvironmentContractSchema } from "../packages/contracts/src";
import { computeTasksetHash, validatePortability, validateTaskset } from "../packages/taskset-sdk/src";
import { tasksetFixture } from "./helpers/training-fixtures";

describe("Taskset SDK contracts", () => {
  test("validates provider-neutral serialized tasks, environments, and hashes", () => {
    const taskset = tasksetFixture();
    expect(validateTaskset(taskset)).toMatchObject({ valid: true, computedHash: taskset.contentHash });
    expect(computeTasksetHash(taskset)).toBe(taskset.contentHash);
    expect(TaskDataRecordSchema.safeParse(taskset.tasks[0]).success).toBe(true);
    expect(TasksetEnvironmentContractSchema.safeParse(taskset.environment).success).toBe(true);
    expect(validatePortability(taskset.capabilities)).toEqual([]);
  });

  test("rejects source-cluster contamination", () => {
    const taskset = tasksetFixture();
    const contaminated = { ...taskset, tasks: taskset.tasks.map((task, index) => ({ ...task, clusterKey: index ? taskset.tasks[0]!.clusterKey : task.clusterKey })) };
    contaminated.contentHash = computeTasksetHash(contaminated);
    expect(validateTaskset(contaminated).issues).toContainEqual(expect.objectContaining({ code: "split_cluster_contamination", severity: "error" }));
  });
});
