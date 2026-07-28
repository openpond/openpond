import { describe, expect, test } from "vitest";
import { ModelProjectSchema, ModelRunDraftSchema } from "../packages/contracts/src";
import { withTrainingStore } from "./helpers/training-fixtures";

describe("Model run draft store", () => {
  test("persists a stable Model and updates, restores, and deletes its draft", async () =>
    withTrainingStore(async ({ store }) => {
      const timestamp = "2026-07-23T12:00:00.000Z";
      const project = ModelProjectSchema.parse({
        schemaVersion: "openpond.modelProject.v1",
        id: "model_fixture",
        profileId: "default",
        name: "Fixture model",
        objective: null,
        defaultBaseModel: null,
        defaultDestinationId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const draft = ModelRunDraftSchema.parse({
        schemaVersion: "openpond.modelRunDraft.v1",
        id: "run_draft_fixture",
        profileId: "default",
        modelId: "model_fixture",
        status: "draft",
        title: "Run draft",
        datasetMode: null,
        tasksetRef: null,
        datasetCreationId: null,
        buildIntent: null,
        buildSpecification: null,
        baseModel: null,
        method: null,
        destinationId: null,
        runPreset: null,
        recipe: null,
        createdAt: "2026-07-23T12:00:00.000Z",
        updatedAt: "2026-07-23T12:00:00.000Z",
      });

      await store.saveModelProject(project);
      await store.saveModelRunDraft(draft);
      await store.saveModelRunDraft({
        ...draft,
        datasetMode: "existing",
        tasksetRef: {
          id: "dataset_fixture",
          revision: 2,
          contentHash: "a".repeat(64),
        },
        updatedAt: "2026-07-23T12:01:00.000Z",
      });

      expect(await store.getModelProject(project.id)).toMatchObject({ name: "Fixture model" });
      expect(await store.getModelRunDraft(draft.id)).toMatchObject({
        modelId: "model_fixture",
        tasksetRef: { id: "dataset_fixture", revision: 2 },
      });
      expect(await store.listModelRunDrafts("default")).toHaveLength(1);

      await store.deleteModelRunDraft(draft.id);
      expect(await store.getModelRunDraft(draft.id)).toBeNull();
    }));
});
