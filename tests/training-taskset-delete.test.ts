import { describe, expect, test } from "vitest";
import { tasksetFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("Training Taskset deletion", () => {
  test("removes the Taskset record and its readiness projection", async () => withTrainingStore(async ({ store }) => {
    const taskset = tasksetFixture({ ready: true });
    await store.upsertTaskset(taskset);
    await store.saveReadinessReport(taskset.readiness!);

    await store.deleteTasksetData(taskset.id);

    expect(await store.getTaskset(taskset.id)).toBeNull();
    expect(await store.getReadinessReport(taskset.id)).toBeNull();
  }));
});
