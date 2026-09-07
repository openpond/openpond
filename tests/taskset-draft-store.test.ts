import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

import {
  createTasksetDraft,
  publishTasksetDraft,
  tasksetDraftFromTaskset,
  writeTasksetDraftPackage,
} from "../packages/taskset-sdk/src/index.js";
import { attemptFixture, tasksetFixture, withTrainingStore } from "./helpers/training-fixtures.js";
import { createTasksetEvaluationVerifier } from "../apps/server/src/training/evaluation-custom-verifier.js";
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

      const db = openTestDatabase(path.join(directory, "state", "state.sqlite"));
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
      const grader = { id: "expected_output", version: "1", label: "Private verifier", kind: "custom_verifier" as const, weight: 1, hardGate: true, rewardEligible: true, privileged: true, module: "graders/verify.js", exportName: "verify", timeoutMs: 1_000, networkPolicy: "none" as const, metadata: {} };
      const draft = tasksetDraftFromTaskset(
        tasksetFixture({ profileId: "source-profile", graders: [grader] }),
        "2026-08-30T12:00:00.000Z",
      );
      await writeTasksetDraftPackage(draft, packageDirectory);
      await mkdir(path.join(packageDirectory, "graders"), { recursive: true });
      await writeFile(path.join(packageDirectory, grader.module), "export function verify() { return { score: 1, passed: true, feedback: 'original' }; }");
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
      const { directory: tasksetRoot, taskset: firstPublished } = await store.materializePublishedTasksetPackage({
        draftId: imported.id,
        taskset,
      });
      expect(
        await readFile(path.join(tasksetRoot, "assets", "matter", "input.docx")),
      ).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(JSON.parse(await readFile(path.join(tasksetRoot, "taskset.json"), "utf8")))
        .toMatchObject({ schemaVersion: "openpond.taskset.v1", id: taskset.id });

      // A later revision must not replace private files needed by an earlier
      // execution, and retrying publication must verify existing bytes.
      const firstManifest = await readFile(path.join(tasksetRoot, "taskset.json"), "utf8");
      await writeFile(path.join(workspace!.workspacePath, "assets", "matter", "input.docx"), Buffer.from("revised bytes"));
      await writeFile(path.join(workspace!.workspacePath, grader.module), "export function verify() { return { score: 0, passed: false, feedback: 'revised' }; }");
      await expect(store.materializePublishedTasksetPackage({ draftId: imported.id, taskset: firstPublished })).rejects.toThrow("changed before publication");
      const revised = publishTasksetDraft({ draft: { ...imported, publishedTasksetRef: { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash } }, now: "2026-09-07T20:00:00.000Z" });
      const second = await store.materializePublishedTasksetPackage({ draftId: imported.id, taskset: revised });
      expect(second.directory).not.toBe(tasksetRoot);
      expect(second.taskset.environment.metadata.runtimeSourceTasksetId).toBe(path.basename(second.directory));
      expect(await readFile(path.join(tasksetRoot, "taskset.json"), "utf8")).toBe(firstManifest);
      expect(await readFile(path.join(tasksetRoot, "assets", "matter", "input.docx"))).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(await readFile(path.join(second.directory, "assets", "matter", "input.docx"), "utf8")).toBe("revised bytes");
      const oldVerifier = await createTasksetEvaluationVerifier({ store, storeDir: directory }, firstPublished);
      const newVerifier = await createTasksetEvaluationVerifier({ store, storeDir: directory }, second.taskset);
      const verification = { grader, task: firstPublished.tasks[1]!, attempt: attemptFixture() };
      await expect(oldVerifier!(verification)).resolves.toMatchObject({ score: 1, feedback: "original" });
      await expect(newVerifier!(verification)).resolves.toMatchObject({ score: 0, feedback: "revised" });
      expect(await readFile(path.join(tasksetRoot, "taskset.json"), "utf8")).toBe(firstManifest);
      await expect(store.materializePublishedTasksetPackage({ draftId: imported.id, taskset: revised })).resolves.toEqual(second);
      await writeFile(path.join(second.directory, "assets", "matter", "input.docx"), "tampered");
      await expect(store.materializePublishedTasksetPackage({ draftId: imported.id, taskset: revised })).rejects.toThrow("differs from the pinned creation attempt");

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
