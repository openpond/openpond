import { expect, test } from "vitest";
import { createModelProjectSaveRequest } from "openpond-sdk/model-projects";
import { computeTasksetHash, createTasksetDraft } from "openpond-sdk/taskset-drafts";
import { createTaskInventoryService } from "../apps/server/src/training/task-inventory-service.js";
import { SqliteStore } from "../apps/server/src/store/store.js";
import { tasksetFixture, withTrainingStore } from "./helpers/training-fixtures.js";

// A searchable task list must not leak private answers or cross Profile/Model
// boundaries, and paging must never silently continue after a draft changed.
test("indexes scoped saved tasks, pages without duplicates, and invalidates edited drafts", async () => withTrainingStore(async ({ store, directory }) => {
  const base = tasksetFixture();
  const release = { ...base, tasks: Array.from({ length: 65 }, (_, index) => ({ ...base.tasks[0]!, id: `task-${index}`, input: { prompt: `Public task ${index}` }, expectedOutput: { text: `private-answer-${index}` } })) };
  release.contentHash = computeTasksetHash(release);
  await store.upsertTaskset(release);
  const model = await store.saveModelProjectConfiguration(await createModelProjectSaveRequest({ id: "inventory-model", profileId: base.profileId, name: "Inventory", objective: null,
    defaultBaseModel: null, defaultDestinationId: null, trainingSetup: { tasksetRef: { id: release.id, revision: release.revision, contentHash: release.contentHash } } }, 0));
  const artifacts = { rows: async () => { throw new Error("Inline inventory must not invoke the dataset worker."); } } as never;
  const inventory = createTaskInventoryService(store, artifacts);
  const first = await inventory.list(base.profileId, { projectId: model.id });
  expect(first.items).toHaveLength(30);
  const second = await inventory.list(base.profileId, { projectId: model.id, after: first.nextCursor });
  const third = await inventory.list(base.profileId, { projectId: model.id, after: second.nextCursor });
  expect(new Set([...first.items, ...second.items, ...third.items].map(item => item.taskId)).size).toBe(65);
  expect(third.nextCursor).toBeNull();
  expect(JSON.stringify(first)).not.toContain("private-answer");
  expect((await inventory.list(base.profileId, { query: "private-answer" })).items).toHaveLength(0);
  expect((await inventory.list("other-profile", {})).items).toHaveLength(0);
  await expect(inventory.list("other-profile", { projectId: model.id })).rejects.toThrow("Model not found");
  await expect(inventory.list(base.profileId, { projectId: model.id, query: "changed", after: first.nextCursor })).rejects.toThrow("cursor");
  const detail = await inventory.detail(base.profileId, { projectId: model.id, tasksetId: release.id, taskId: "task-0" });
  expect(detail.task.expectedOutput).toEqual({ text: "private-answer-0" });
  const blank = createTasksetDraft({ profileId: base.profileId, id: "inventory-draft", modelScope: { modelId: model.id, expectedModelRevision: model.revision } });
  const draft = await store.saveTasksetDraft({ ...blank, tasks: [base.tasks[0]!] });
  const withDraft = await inventory.list(base.profileId, { projectId: model.id });
  expect(withDraft.items.find(item => item.draftId === draft.id)?.configuration).toBe("needs_reward");
  expect((await inventory.detail(base.profileId, { tasksetId: draft.id, draftId: draft.id, taskId: draft.tasks[0]!.id })).item.draftId).toBe(draft.id);
  const reopened = new SqliteStore(directory);
  try {
    const saved = await reopened.saveTasksetDraft({ ...draft, revision: draft.revision + 1, tasks: [{ ...draft.tasks[0]!, input: { prompt: "Edited draft input" } }] }, draft.revision);
    const resumed = createTaskInventoryService(reopened, artifacts);
    await expect(resumed.list(base.profileId, { projectId: model.id, after: withDraft.nextCursor })).rejects.toThrow("cursor");
    expect((await resumed.list(base.profileId, { query: "Edited draft input" })).items[0]?.tasksetRevision).toBe(saved.revision);
    await reopened.deleteTasksetDraft(saved.id);
    expect((await resumed.list(base.profileId, { query: "Edited draft input" })).items).toHaveLength(0);
  } finally { await reopened.close(); }
}));
