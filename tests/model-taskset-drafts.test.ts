import path from "node:path";
import { readFile, writeFile, symlink, unlink } from "node:fs/promises";
import { expect, test } from "vitest";
import { createModelProjectSaveRequest, ModelProjectEditableSchema } from "openpond-sdk/model-projects";
import type { Taskset, TasksetDraft } from "@openpond/contracts";
import { tasksetDraftFromTaskset } from "@openpond/taskset-sdk";
import { createTrainingApi } from "../apps/server/src/training/training-api.js";
import { SqliteStore } from "../apps/server/src/store/store.js";
import { tasksetFixture, withTrainingStore } from "./helpers/training-fixtures.js";
import type { TasksetDraftFile } from "openpond-sdk/model-taskset-authoring";
import { openTestDatabase, closeTestDatabase } from "./helpers/sqlite-database.js";

// File edits must neither escape the draft nor overwrite a concurrent editor;
// a rejected SQLite commit must leave the original source bytes intact.
test("isolates draft file edits and serializes file CAS across reopened stores", async () => withTrainingStore(async ({ store, directory }) => {
  const api = createTrainingApi({ store } as never);
  const draft = await api.request("init_taskset_draft", { profileId: "default" }) as TasksetDraft;
  const workspace = (await store.getTasksetDraftWorkspace(draft.id))!;
  const request = { draftId: draft.id, expectedDraftRevision: draft.revision, path: "graders/custom.js", expectedFileHash: null,
    content: { encoding: "utf8" as const, data: "export const grade = () => 1;" } };
  const first = await store.saveTasksetDraftFile("default", request);
  const read = await store.tasksetDraftFiles("default", draft.id, request.path) as { draftRevision: number; file: TasksetDraftFile };
  expect(read.file.content.data).toBe(request.content.data);
  await expect(store.saveTasksetDraftFile("foreign", { ...request, expectedDraftRevision: first.revision })).rejects.toThrow("not found in this Profile");
  for (const relative of ["../outside.js", "nested/.env", "/outside.js", "nested\\outside.js"]) await expect(store.tasksetDraftFiles("default", draft.id, relative)).rejects.toThrow();
  await expect(store.saveTasksetDraftFile("default", { ...request, expectedDraftRevision: first.revision, path: "taskset.json" })).rejects.toThrow("managed");
  const outside = path.join(directory, "outside.js");
  await writeFile(outside, "private outside fixture");
  await symlink(outside, path.join(workspace.workspacePath, "linked.js"));
  await expect(store.tasksetDraftFiles("default", draft.id, "linked.js")).rejects.toThrow();
  const reopened = new SqliteStore(directory);
  const db = openTestDatabase(path.join(directory, "state", "state.sqlite"));
  try {
    // Restore the regular workspace before testing independent save conflicts.
    await unlink(path.join(workspace.workspacePath, "linked.js"));
    const mutation = { ...request, expectedDraftRevision: first.revision, expectedFileHash: read.file.contentHash, content: { encoding: "utf8" as const, data: "export const grade = () => 0;" } };
    db.exec("CREATE TRIGGER reject_file_pointer BEFORE UPDATE ON taskset_drafts BEGIN SELECT RAISE(ABORT, 'file pointer interrupted'); END");
    await expect(store.saveTasksetDraftFile("default", mutation)).rejects.toThrow("file pointer interrupted");
    expect(await readFile(path.join(workspace.workspacePath, request.path), "utf8")).toBe(request.content.data);
    db.exec("DROP TRIGGER reject_file_pointer");
    const results = await Promise.allSettled([store.saveTasksetDraftFile("default", mutation), reopened.saveTasksetDraftFile("default", { ...mutation, content: { encoding: "utf8", data: "competing edit" } })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const current = (await store.getTasksetDraft(draft.id))!;
    await expect(store.saveTasksetDraftFile("default", { ...mutation, expectedDraftRevision: current.revision })).rejects.toThrow("file changed");
    const binary = await store.saveTasksetDraftFile("default", { draftId: draft.id, expectedDraftRevision: current.revision, path: "assets/input.bin", expectedFileHash: null,
      content: { encoding: "base64", data: "AP8=" } });
    expect(await readFile(path.join(workspace.workspacePath, "assets/input.bin"))).toEqual(Buffer.from([0, 255]));
    const binaryFile = await store.tasksetDraftFiles("default", draft.id, "assets/input.bin") as typeof read;
    expect(binaryFile.file.content).toEqual({ encoding: "base64", data: "AP8=" });
    await store.saveTasksetDraftFile("default", { draftId: draft.id, expectedDraftRevision: binary.revision, path: "assets/input.bin", expectedFileHash: binaryFile.file.contentHash, content: null });
    await expect(readFile(path.join(workspace.workspacePath, "assets/input.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await closeTestDatabase(db); await reopened.close(); }
}));

// A route or edited workspace file must not be able to move an existing draft
// to another Model/Profile, including after reopening the database.
test("persists Model draft ownership independently of mutable workspace files", async () => withTrainingStore(async ({ store, directory }) => {
  const model = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: "draft-owner", profileId: "profile-a", name: "Draft owner",
    objective: null, defaultBaseModel: null, defaultDestinationId: null, trainingSetup: {} }, 0));
  const api = createTrainingApi({ store } as never);
  const draft = await api.request("init_taskset_draft", { profileId: model.profileId, modelId: model.id }) as TasksetDraft;
  expect(draft.modelScope).toEqual({ modelId: model.id, expectedModelRevision: model.revision });
  await expect(api.request("init_taskset_draft", { profileId: "foreign-profile", modelId: model.id })).rejects.toThrow("not found in this Profile");
  const workspace = (await store.getTasksetDraftWorkspace(draft.id))!;
  const manifestPath = path.join(workspace.workspacePath, "taskset.json");
  const manifest = await readFile(manifestPath, "utf8");
  await expect(store.saveTasksetDraft({ ...draft, modelScope: null, revision: draft.revision + 1 }, draft.revision)).rejects.toThrow("ownership cannot change");
  expect(await readFile(manifestPath, "utf8")).toBe(manifest);
  await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(manifest), modelScope: { modelId: "forged-model", expectedModelRevision: 99 } }));
  const reopened = new SqliteStore(directory);
  try {
    expect((await reopened.getTasksetDraft(draft.id))?.modelScope).toEqual(draft.modelScope);
    expect((await reopened.listTasksetDrafts(model.profileId)).map(value => value.modelScope)).toEqual([draft.modelScope]);
    const resumedApi = createTrainingApi({ store: reopened } as never);
    await expect(resumedApi.request("publish_taskset_draft", { draftId: draft.id, modelId: "other-model" })).rejects.toThrow("belongs to another Model");
  } finally { await reopened.close(); }
}));

// Publication must never expose a Taskset without its intended selection, and
// an uncertain-response retry must not overwrite a later Model edit.
test("publishes Model drafts atomically with CAS and retains the original retry result", async () => withTrainingStore(async ({ store, directory }) => {
  const source = tasksetFixture();
  await store.upsertTaskset(source);
  const sourceRef = { id: source.id, revision: source.revision, contentHash: source.contentHash };
  const model = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: "draft-publication-owner", profileId: source.profileId,
    name: "Draft publication owner", objective: null, defaultBaseModel: null, defaultDestinationId: null, trainingSetup: { tasksetRef: sourceRef } }, 0));
  const api = createTrainingApi({ store, storeDir: directory, evaluation: { readiness: async () => undefined } } as never);
  async function author(id: string) {
    const empty = await api.request("init_taskset_draft", { profileId: model.profileId, modelId: model.id }) as TasksetDraft;
    return api.request("save_taskset_draft", { draft: { ...tasksetDraftFromTaskset(source), id: empty.id,
      name: id, revision: empty.revision, modelScope: empty.modelScope, publishedTasksetRef: null } }) as Promise<TasksetDraft>;
  }
  const stale = await author("Stale draft");
  const changed = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...ModelProjectEditableSchema.strip().parse(model), name: "Concurrent Model edit" }, model.revision));
  await expect(api.request("publish_taskset_draft", { draftId: stale.id })).rejects.toMatchObject({ code: "model_revision_conflict" });
  expect((await store.getTasksetDraft(stale.id))?.status).toBe("draft");
  expect(await store.getTaskset(stale.id)).toBeNull();
  expect(await store.getModelProject(model.id)).toEqual(changed);

  await expect(api.request("refresh_taskset_draft_model", { draftId: stale.id, expectedDraftRevision: stale.revision,
    expectedModelRevision: model.revision })).rejects.toThrow("Model changed");
  const draft = await api.request("refresh_taskset_draft_model", { draftId: stale.id, expectedDraftRevision: stale.revision,
    expectedModelRevision: changed.revision }) as TasksetDraft;
  expect(draft.id).toBe(stale.id);
  expect(draft.tasks).toEqual(stale.tasks);
  await expect(api.request("refresh_taskset_draft_model", { draftId: stale.id, expectedDraftRevision: stale.revision,
    expectedModelRevision: changed.revision })).rejects.toThrow("draft changed");
  const published = await api.request("publish_taskset_draft", { draftId: draft.id }) as { draft: TasksetDraft; taskset: Taskset };
  const selected = (await store.getModelProject(model.id))!;
  expect(selected.revision).toBe(changed.revision + 1);
  expect(selected.trainingSetup.tasksetRef).toEqual(published.draft.publishedTasksetRef);
  expect(selected.trainingSetup.rewardBindingRef).toBeNull();
  expect(await store.getTasksetRevision(source.id, source.revision, source.contentHash)).toEqual(source);
  const later = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...ModelProjectEditableSchema.strip().parse(selected),
    trainingSetup: { ...selected.trainingSetup, tasksetRef: sourceRef } }, selected.revision));
  const reopened = new SqliteStore(directory);
  try {
    const retryApi = createTrainingApi({ store: reopened, storeDir: directory, evaluation: { readiness: async () => undefined } } as never);
    const retry = await retryApi.request("publish_taskset_draft", { draftId: draft.id }) as typeof published;
    expect(retry.draft).toEqual(published.draft);
    expect(retry.taskset).toEqual(published.taskset);
    expect(await reopened.getModelProject(model.id)).toEqual(later);
  } finally { await reopened.close(); }
}));
