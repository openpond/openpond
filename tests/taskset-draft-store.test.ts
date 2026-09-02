import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

import {
  createTasksetDraft,
  publishTasksetDraft,
  tasksetDraftFromTaskset,
  writeTasksetDraftPackage,
} from "../packages/taskset-sdk/src/index.js";
import { tasksetFixture, withTrainingStore } from "./helpers/training-fixtures.js";
import {
  closeTestDatabase,
  getTestSql,
  openTestDatabase,
} from "./helpers/sqlite-database.js";

describe("Taskset draft persistence", () => {
  test("stores editable drafts separately from immutable Taskset revisions", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const draft = createTasksetDraft({
        id: "taskset-draft-store-proof",
        profileId: "profile-a",
        name: "Store proof",
        now: "2026-08-24T12:00:00.000Z",
      });

      await store.saveTasksetDraft(draft);

      expect(await store.getTasksetDraft(draft.id)).toEqual(draft);
      expect(await store.listTasksetDrafts("profile-a")).toEqual([draft]);
      expect(await store.listTasksetDrafts("profile-b")).toEqual([]);
      expect(await store.getTaskset(draft.id)).toBeNull();

      const workspace = await store.getTasksetDraftWorkspace(draft.id);
      expect(workspace).toMatchObject({ draftId: draft.id });
      expect(workspace?.workspacePath).toContain(path.join("workspaces", "tasksets"));
      expect(await readFile(path.join(workspace!.workspacePath, "taskset.json"), "utf8"))
        .toContain("Store proof");

      const db = openTestDatabase(path.join(directory, "state.sqlite"));
      try {
        const row = await getTestSql<{ payload: string }>(
          db,
          "SELECT payload FROM taskset_drafts WHERE id = ?",
          [draft.id],
        );
        const pointer = JSON.parse(row.payload) as Record<string, unknown>;
        expect(pointer.schemaVersion).toBe("openpond.tasksetDraftPointer.v1");
        expect(pointer.workspacePath).toBe(workspace?.workspacePath);
        expect(pointer).not.toHaveProperty("tasks");
        expect(pointer).not.toHaveProperty("objective");
      } finally {
        await closeTestDatabase(db);
      }

      await store.deleteTasksetDraft(draft.id);
      expect(await store.getTasksetDraft(draft.id)).toBeNull();
      await expect(
        readFile(path.join(workspace!.workspacePath, "taskset.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }));

  test("imports portable packages with assets without bypassing the draft store", async () =>
    withTrainingStore(async ({ store, directory }) => {
      const packageDirectory = path.join(directory, "portable-taskset");
      const draft = tasksetDraftFromTaskset(
        tasksetFixture({ profileId: "source-profile" }),
        "2026-08-30T12:00:00.000Z",
      );
      await writeTasksetDraftPackage(draft, packageDirectory);
      await mkdir(path.join(packageDirectory, "assets", "matter"), { recursive: true });
      await writeFile(
        path.join(packageDirectory, "assets", "matter", "input.docx"),
        new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      );

      const imported = await store.importTasksetDraftPackage({
        packagePath: packageDirectory,
        profileId: "target-profile",
      });
      expect(imported).toMatchObject({
        id: draft.id,
        profileId: "target-profile",
        status: "draft",
        revision: 1,
      });
      const workspace = await store.getTasksetDraftWorkspace(imported.id);
      expect(
        await readFile(path.join(workspace!.workspacePath, "assets", "matter", "input.docx")),
      ).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      const taskset = publishTasksetDraft({ draft: imported });
      const tasksetRoot = await store.materializePublishedTasksetPackage({
        draftId: imported.id,
        taskset,
      });
      expect(
        await readFile(path.join(tasksetRoot, "assets", "matter", "input.docx")),
      ).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(JSON.parse(await readFile(path.join(tasksetRoot, "taskset.json"), "utf8")))
        .toMatchObject({ schemaVersion: "openpond.taskset.v1", id: taskset.id });

      await expect(store.importTasksetDraftPackage({
        packagePath: packageDirectory,
        profileId: "target-profile",
      })).resolves.toEqual(imported);
      await expect(store.importTasksetDraftPackage({
        packagePath: packageDirectory,
        profileId: "another-profile",
      })).rejects.toThrow("already exists");
    }));
});
