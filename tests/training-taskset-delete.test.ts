import { describe, expect, test } from "vitest";
import { TasksetSchema } from "@openpond/contracts";
import { computeTasksetHash } from "../packages/taskset-sdk/src";
import { tasksetFixture, withTrainingStore } from "./helpers/training-fixtures";

describe("Training Taskset deletion", () => {
  test("preserves immutable Taskset revisions by id, revision, and hash", async () => withTrainingStore(async ({ store }) => {
    const first = tasksetFixture();
    await store.upsertTaskset(first);
    const secondDraft = TasksetSchema.parse({
      ...first,
      revision: 2,
      objective: "Reproduce the approved greeting style after reviewed feedback.",
      contentHash: "00000000",
      updatedAt: "2026-07-16T12:00:00.000Z",
    });
    const second = TasksetSchema.parse({
      ...secondDraft,
      contentHash: computeTasksetHash(secondDraft),
    });
    await store.upsertTaskset(second);

    expect(await store.getTaskset(first.id)).toMatchObject({ revision: 2, contentHash: second.contentHash });
    expect(await store.getTasksetRevision(first.id, 1, first.contentHash)).toMatchObject({ revision: 1 });
    expect(await store.getTasksetRevision(second.id, 2, second.contentHash)).toMatchObject({ revision: 2 });
    await expect(store.upsertTaskset({ ...first, contentHash: "forged_hash" })).rejects.toThrow("immutable");
  }));

  test("removes the Taskset record and its readiness projection", async () => withTrainingStore(async ({ store }) => {
    const taskset = tasksetFixture({ ready: true });
    await store.upsertTaskset(taskset);
    await store.saveReadinessReport(taskset.readiness!);

    await store.deleteTasksetData(taskset.id);

    expect(await store.getTaskset(taskset.id)).toBeNull();
    expect(await store.getTasksetRevision(taskset.id, taskset.revision)).toBeNull();
    expect(await store.getReadinessReport(taskset.id)).toBeNull();
  }));
});
