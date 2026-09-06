import { expect, test } from "vitest";
import { createModelProjectSaveRequest, ModelProjectTrainingSetupSchema } from "openpond-sdk/model-projects";
import { SqliteStore } from "../apps/server/src/store/store";
import { withTempDirectory } from "./helpers/temp-directory";
import { tasksetFixture } from "./helpers/training-fixtures";

// A second window must not overwrite a stale Model, and retrying a lost response
// must return the committed receipt even if another window has edited it since.
test("saves model configuration with exact ownership, revisions, and durable retry identity", async () => withTempDirectory("model-authoring-", async (home) => {
  const first = new SqliteStore(home);
  await first.listModelProjects();
  const second = new SqliteStore(home);
  try {
    await second.listModelProjects();
    const taskset = await first.upsertTaskset(tasksetFixture());
    const project = {
      id: "model-authoring", profileId: "default", name: "Greeting model", objective: "Learn approved greetings",
      defaultBaseModel: null, defaultDestinationId: null,
      trainingSetup: ModelProjectTrainingSetupSchema.parse({ tasksetRef: { id: taskset.id, revision: taskset.revision, contentHash: taskset.contentHash } }),
    };
    const request = await createModelProjectSaveRequest(project, 0);
    const saved = await first.saveModelProjectConfiguration(request);
    expect(saved.revision).toBe(1);
    expect(saved.trainingSetup.tasksetRef).toEqual(project.trainingSetup.tasksetRef);
    expect(await second.saveModelProjectConfiguration(await createModelProjectSaveRequest(project, 0))).toEqual(saved);
    const edits = await Promise.allSettled([
      first.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...project, name: "First edit" }, 1)),
      second.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...project, name: "Second edit" }, 1)),
    ]);
    expect(edits.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(edits.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { status: 409, code: "model_revision_conflict" } });
    expect((await first.getModelProject(project.id))?.revision).toBe(2);
    expect(await second.saveModelProjectConfiguration(request)).toEqual(saved);
    await expect(second.saveModelProjectConfiguration({ ...request, project: { ...project, name: "Reused operation" } })).rejects.toMatchObject({ status: 409, code: "model_operation_conflict" });
    await expect(second.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...project, profileId: "other" }, 2))).rejects.toMatchObject({ status: 404, code: "model_not_found" });
    await expect(second.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...project, id: "other-model", profileId: "other" }, 0))).rejects.toMatchObject({ status: 404, code: "model_taskset_not_found" });
    expect(await second.getModelProject("other-model")).toBeNull();
    await expect(second.saveModelProjectConfiguration(await createModelProjectSaveRequest({ ...project, id: "wrong-hash", trainingSetup: { ...project.trainingSetup, tasksetRef: { ...project.trainingSetup.tasksetRef!, contentHash: "f".repeat(64) } } }, 0))).rejects.toMatchObject({ status: 409, code: "model_taskset_changed" });
    expect(await second.getModelProject("wrong-hash")).toBeNull();
  } finally {
    await second.close();
    await first.close();
  }
  const reopened = new SqliteStore(home);
  try {
    expect((await reopened.getModelProject("model-authoring"))?.revision).toBe(2);
    expect(await reopened.listModelProjects()).toHaveLength(1);
  } finally { await reopened.close(); }
}));
