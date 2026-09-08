import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

import {
  createTasksetDraft,
  publishTasksetDraft,
  tasksetDraftFromTaskset,
  writeTasksetDraftPackage,
  materializePortableTasksetRelease,
} from "../packages/taskset-sdk/src/index.js";
import { attemptFixture, tasksetFixture, withTrainingStore } from "./helpers/training-fixtures.js";
import { createTasksetEvaluationVerifier } from "../apps/server/src/training/evaluation-custom-verifier.js";
import { createModelProjectSaveRequest } from "openpond-sdk/model-projects";
import { decodeTasksetPackageFile } from "openpond-sdk/taskset-packages";
import { exportLocalModelTasksetPackage } from "../apps/server/src/training/model-taskset-package-export.js";
import { prepareImportedTasksetPackage } from "../apps/server/src/training/taskset-package-import.js";
import { materializeImportedTasksetPackage } from "../apps/server/src/training/taskset-package-files.js";
import { materializeTasksetRevisionFromSource } from "../apps/server/src/training/generated-taskset-package.js";
import { tasksetPackageDirectoryId } from "../apps/server/src/training/taskset-package-path.js";
import { createTrainingApi } from "../apps/server/src/training/training-api.js";
import { SqliteStore } from "../apps/server/src/store/store.js";
import {
  closeTestDatabase,
  getTestSql,
  openTestDatabase,
} from "./helpers/sqlite-database.js";

describe("Taskset draft persistence", () => {
  test("retries interrupted readiness through the API using the published revision from a fresh store", async () => withTrainingStore(async ({ store, directory }) => {
    const draft = await store.saveTasksetDraft(tasksetDraftFromTaskset(tasksetFixture(), "2026-09-08T02:00:00.000Z"));
    const interrupted = createTrainingApi({ store, storeDir: directory, evaluation: { readiness: async () => { throw new Error("Readiness interrupted"); } } } as never);
    await expect(interrupted.request("publish_taskset_draft", { draftId: draft.id })).rejects.toThrow("Readiness interrupted");
    const published = (await store.getTasksetDraft(draft.id))!;
    expect(published.status).toBe("published");
    const ref = published.publishedTasksetRef!;
    const original = await store.getTasksetRevision(ref.id, ref.revision, ref.contentHash);
    const reloaded = new SqliteStore(directory);
    try {
      const checked: unknown[] = [];
      const retry = createTrainingApi({ store: reloaded, storeDir: directory, evaluation: { readiness: async (_id: string, reference: unknown) => { checked.push(reference); } } } as never);
      const result = await retry.request("publish_taskset_draft", { draftId: draft.id }) as { draft: typeof draft; taskset: typeof original };
      expect(result.draft.publishedTasksetRef).toEqual(ref);
      expect(result.taskset).toEqual(original);
      expect(checked).toEqual([original]);
    } finally { await reloaded.close(); }
  }));

  // Interrupted finalization must expose neither half of a publication, and
  // concurrent retries must return the one revision that actually committed.
  test("finalizes draft and Taskset atomically and replays the committed reference", async () => withTrainingStore(async ({ store, directory }) => {
    const source = tasksetFixture();
    const draft = await store.saveTasksetDraft(tasksetDraftFromTaskset(source, "2026-09-08T02:00:00.000Z"));
    const workspace = (await store.getTasksetDraftWorkspace(draft.id))!;
    const taskset = { ...source, metadata: { ...source.metadata, sourcePackageHash: workspace.packageHash } };
    const input = { draft, packageHash: workspace.packageHash, taskset };
    const db = openTestDatabase(path.join(directory, "state", "state.sqlite"));
    try {
      db.exec("CREATE TRIGGER reject_draft_finalization BEFORE UPDATE ON taskset_drafts BEGIN SELECT RAISE(ABORT, 'finalization interrupted'); END");
      await expect(store.finalizeTasksetDraftPublication(input)).rejects.toThrow("finalization interrupted");
      expect(await store.getTaskset(taskset.id)).toBeNull();
      expect(await store.getTasksetRevision(taskset.id, taskset.revision)).toBeNull();
      expect((await store.getTasksetDraft(draft.id))?.status).toBe(draft.status);
      db.exec("DROP TRIGGER reject_draft_finalization");
      const [first, retry] = await Promise.all([
        store.finalizeTasksetDraftPublication(input),
        store.finalizeTasksetDraftPublication({ ...input, taskset: { ...taskset, contentHash: "a".repeat(64) } }),
      ]);
      expect(retry).toEqual(first);
      expect(first.draft.status).toBe("published");
      const workspaceManifest = await readFile(path.join(workspace.workspacePath, "taskset.json"), "utf8");
      await expect(store.saveTasksetDraft({ ...draft, name: "Stale editor overwrite", revision: draft.revision + 1 }, draft.revision))
        .rejects.toThrow("Published Taskset drafts are immutable");
      expect(await readFile(path.join(workspace.workspacePath, "taskset.json"), "utf8")).toBe(workspaceManifest);
      expect((await store.getTasksetDraft(draft.id))?.publishedTasksetRef).toEqual(first.draft.publishedTasksetRef);
      expect(await store.getTasksetRevision(taskset.id, taskset.revision)).toEqual(first.taskset);
    } finally { db.close(); }
  }));

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
      const human = { id: "human-review", version: "1", label: "Human review", kind: "human" as const, weight: 1, hardGate: false, rewardEligible: false, privileged: true, rubric: "Assess clarity using only the supplied evidence.", reviewerRole: "reviewer", metadata: {} };
      const sourceTaskset = tasksetFixture({ profileId: "source-profile", graders: [grader, human] });
      sourceTaskset.policy.hiddenGraderRefs.push(human.id);
      // Publication must never replace missing executable bytes with a descriptor.
      expect(() => materializePortableTasksetRelease({ taskset: sourceTaskset, adapterId: "unprepared" }))
        .toThrow("requires its immutable executable asset");
      const draft = tasksetDraftFromTaskset(
        sourceTaskset,
        "2026-08-30T12:00:00.000Z",
      );
      draft.environment.resources = draft.tasks.map(task => ({ id: task.privilegedContextRef!, kind: "file", path: `assets/${task.id}-context.json`, mediaType: "application/json", visibility: "privileged", required: true, metadata: {} }));
      await writeTasksetDraftPackage(draft, packageDirectory);
      await mkdir(path.join(packageDirectory, "graders"), { recursive: true });
      await writeFile(path.join(packageDirectory, grader.module), "export function verify() { return { score: 1, passed: true, feedback: 'original' }; }");
      await mkdir(path.join(packageDirectory, "assets", "matter"), { recursive: true });
      for (const task of draft.tasks) await writeFile(path.join(packageDirectory, `assets/${task.id}-context.json`), JSON.stringify(task.expectedOutput));
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
      await store.upsertTaskset(firstPublished);
      const model = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: "ordinary-package-model", profileId: imported.profileId,
        name: "Ordinary package", objective: null, defaultBaseModel: null, defaultDestinationId: null,
        trainingSetup: { tasksetRef: { id: firstPublished.id, revision: firstPublished.revision, contentHash: firstPublished.contentHash } } }, 0));
      const exported = await exportLocalModelTasksetPackage({ store, storeDir: directory, profileId: imported.profileId, modelId: model.id });
      expect(exported.modelResources).toBeUndefined();
      const portableHuman = exported.taskset.graders.find(grader => grader.kind === "human")!;
      if (portableHuman.kind !== "human") throw new Error("Missing human rubric");
      expect(Buffer.from(decodeTasksetPackageFile(exported.files.find(file => file.asset.id === portableHuman.rubricRef.id)!)).toString("utf8")).toBe(human.rubric);
      const portableGrader = exported.taskset.graders[0]!;
      expect(portableGrader.kind).toBe("custom_verifier");
      if (portableGrader.kind !== "custom_verifier") throw new Error("Missing custom verifier");
      expect(Buffer.from(decodeTasksetPackageFile(exported.files.find(file => file.asset.id === portableGrader.verifierRef.id)!)).toString("utf8"))
        .toBe("export function verify() { return { score: 1, passed: true, feedback: 'original' }; }");
      const retained = exported.files.find(file => file.asset.path === "assets/matter/input.docx")!;
      expect(retained.asset.visibility).toBe("host_private");
      expect(Buffer.from(decodeTasksetPackageFile(retained))).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      for (const task of exported.taskset.tasks) expect(exported.files.find(file => file.asset.id === task.privilegedContextRef)?.asset.visibility).toBe("host_private");
      const importedHome = path.join(directory, "downloaded");
      const downloaded = prepareImportedTasksetPackage({ package: exported, profileId: "downloaded-profile", name: "Downloaded tasks", createdAt: "2026-09-08T01:00:00.000Z" });
      await materializeImportedTasksetPackage({ home: importedHome, ...downloaded });
      expect(materializePortableTasksetRelease({ taskset: downloaded.taskset, adapterId: "downloaded" }).tasksetRelease).toEqual(exported.taskset);
      const downloadedVerifier = await createTasksetEvaluationVerifier({ store, storeDir: importedHome }, downloaded.taskset);
      await expect(downloadedVerifier!({ grader: downloaded.taskset.graders[0] as typeof grader, task: downloaded.taskset.tasks[0]!, attempt: attemptFixture() })).resolves.toMatchObject({ score: 1, feedback: "original" });
      expect(downloaded.taskset.graderFixtures).toEqual(firstPublished.graderFixtures);
      const editedDownload = await materializeTasksetRevisionFromSource(path.join(importedHome, "training", "tasksets"), {
        ...downloaded.taskset, revision: downloaded.taskset.revision + 1,
        // This fixture contains only the literal test data above. Import itself
        // intentionally left its source review pending.
        sourceRefs: downloaded.taskset.sourceRefs.map(source => ({ ...source, licensingStatus: "approved", secretScanStatus: "passed", piiScanStatus: "passed" })),
        graders: downloaded.taskset.graders.map(item => item.kind === "human" ? { ...item, rubric: "Evaluate the revised instructions." } : item),
      }, path.join(importedHome, "training", "tasksets", tasksetPackageDirectoryId(downloaded.taskset)));
      expect(editedDownload.metadata.importedPackageHash).toBeUndefined();
      expect(editedDownload.metadata.sourceImportedPackageHash).toBe(exported.contentHash);
      await store.upsertTaskset(editedDownload);
      const downloadedModel = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: "downloaded-model", profileId: editedDownload.profileId,
        name: "Edited download", objective: null, defaultBaseModel: null, defaultDestinationId: null,
        trainingSetup: { tasksetRef: { id: editedDownload.id, revision: editedDownload.revision, contentHash: editedDownload.contentHash } } }, 0));
      const reexported = await exportLocalModelTasksetPackage({ store, storeDir: importedHome, profileId: editedDownload.profileId, modelId: downloadedModel.id });
      expect(reexported.contentHash).not.toBe(exported.contentHash);
      expect(reexported.verifierSet.contentHash).not.toBe(exported.verifierSet.contentHash);
      for (const task of reexported.taskset.tasks) expect(reexported.files.some(file => file.asset.id === task.privilegedContextRef)).toBe(true);
      const editedHuman = reexported.taskset.graders.find(item => item.kind === "human")!;
      if (editedHuman.kind !== "human") throw new Error("Missing revised rubric");
      expect(Buffer.from(decodeTasksetPackageFile(reexported.files.find(file => file.asset.id === editedHuman.rubricRef.id)!)).toString("utf8")).toBe("Evaluate the revised instructions.");

      // A later revision must not replace private files needed by an earlier
      // execution, and retrying publication must verify existing bytes.
      const firstManifest = await readFile(path.join(tasksetRoot, "taskset.json"), "utf8");
      await writeFile(path.join(workspace!.workspacePath, "assets", "matter", "input.docx"), Buffer.from("revised bytes"));
      await writeFile(path.join(workspace!.workspacePath, grader.module), "export function verify() { return { score: 0, passed: false, feedback: 'revised' }; }");
      await expect(store.materializePublishedTasksetPackage({ draftId: imported.id, taskset: firstPublished })).rejects.toThrow("changed before publication");
      const revised = publishTasksetDraft({ draft: { ...imported, publishedTasksetRef: { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash } }, now: "2026-09-07T20:00:00.000Z" });
      // A downloaded draft pins the original environment and verifier set.
      // Editing its verifier must retain the environment and seal new checks.
      revised.environment.metadata.portableExecutionResources = { environment: exported.environment, verifierSet: exported.verifierSet };
      const second = await store.materializePublishedTasksetPackage({ draftId: imported.id, taskset: revised });
      const revisedRelease = materializePortableTasksetRelease({ taskset: second.taskset, adapterId: "edited-draft" });
      expect(revisedRelease.environmentRelease).toEqual(exported.environment);
      expect(revisedRelease.verifierSetRelease.contentHash).not.toBe(exported.verifierSet.contentHash);
      expect(second.directory).not.toBe(tasksetRoot);
      expect(second.taskset.environment.metadata.runtimeSourceTasksetId).toBe(path.basename(second.directory));
      expect(await readFile(path.join(tasksetRoot, "taskset.json"), "utf8")).toBe(firstManifest);
      expect(await exportLocalModelTasksetPackage({ store, storeDir: directory, profileId: imported.profileId, modelId: model.id })).toEqual(exported);
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
      await writeFile(path.join(tasksetRoot, grader.module), "export function verify() { throw new Error('changed'); }");
      await expect(oldVerifier!(verification)).rejects.toThrow("differs from its immutable Taskset release");
      await expect(exportLocalModelTasksetPackage({ store, storeDir: directory, profileId: imported.profileId, modelId: model.id })).rejects.toThrow();

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
