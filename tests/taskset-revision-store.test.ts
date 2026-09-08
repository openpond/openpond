import path from "node:path";
import { describe, expect, test } from "vitest";
import { computeTasksetHash } from "../packages/taskset-sdk/src";
import { tasksetFixture, withTrainingStore } from "./helpers/training-fixtures";
import { openTestDatabase } from "./helpers/sqlite-database";

describe("Taskset revision publication", () => {
  // Two authors racing for one revision must not overwrite its admitted bytes.
  test("commits one concurrent revision and rejects the conflicting author", async () => withTrainingStore(async ({ store }) => {
    const first = tasksetFixture();
    const changed = { ...first, name: "Competing authored tasks" };
    const second = { ...changed, contentHash: computeTasksetHash(changed) };
    const outcomes = await Promise.allSettled([store.upsertTaskset(first), store.upsertTaskset(second)]);
    expect(outcomes.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const winner = outcomes[0]!.status === "fulfilled" ? first : second;
    expect(await store.getTaskset(first.id)).toEqual(winner);
    expect(await store.getTasksetRevision(first.id, first.revision)).toEqual(winner);
    await expect(store.upsertTaskset(winner)).resolves.toEqual(winner);
  }));

  // A pointer-write failure must leave neither half of a publication visible.
  test.each(["tasksets", "taskset_revisions"])("rolls back a failed %s write, then retries", async (table) => withTrainingStore(async ({ store, directory }) => {
    const taskset = tasksetFixture();
    await store.getTaskset(taskset.id);
    const db = openTestDatabase(path.join(directory, "state", "state.sqlite"));
    try {
      db.exec(`CREATE TRIGGER reject_taskset_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'publication write rejected'); END`);
      await expect(store.upsertTaskset(taskset)).rejects.toThrow("publication write rejected");
      expect(await store.getTaskset(taskset.id)).toBeNull();
      expect(await store.getTasksetRevision(taskset.id, taskset.revision)).toBeNull();
      db.exec("DROP TRIGGER reject_taskset_write");
      await expect(store.upsertTaskset(taskset)).resolves.toEqual(taskset);
      expect(await store.getTasksetRevision(taskset.id, taskset.revision)).toEqual(taskset);
    } finally { db.close(); }
  }));

  // Late readiness results belong to history and cannot retarget newer work.
  test("retains the latest revision during historical updates and rejects ownership changes", async () => withTrainingStore(async ({ store }) => {
    const first = tasksetFixture();
    const changed = { ...first, revision: first.revision + 1, name: "New authored revision" };
    const second = { ...changed, contentHash: computeTasksetHash(changed) };
    await store.upsertTaskset(first);
    await store.upsertTaskset(second);
    const historical = { ...first, status: "needs_review" as const };
    await store.upsertTaskset(historical);
    expect(await store.getTaskset(first.id)).toEqual(second);
    expect(await store.getTasksetRevision(first.id, first.revision)).toEqual(historical);
    await expect(store.upsertTaskset({ ...second, profileId: "another-profile" })).rejects.toThrow("another Profile");
    expect(await store.getTaskset(first.id)).toEqual(second);
  }));
});
