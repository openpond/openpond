import { describe, expect, test } from "vitest";
import { ModelBuildDraftSchema } from "../packages/contracts/src";
import { withTrainingStore } from "./helpers/training-fixtures";

describe("Model build draft store", () => {
  test("persists, updates, restores, and deletes a durable draft", async () =>
    withTrainingStore(async ({ store }) => {
      const draft = ModelBuildDraftSchema.parse({
        schemaVersion: "openpond.modelBuildDraft.v1",
        id: "model_build_fixture",
        profileId: "default",
        modelId: "model_fixture",
        name: "Fixture model",
        objective: null,
        status: "draft",
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

      await store.saveModelBuildDraft(draft);
      await store.saveModelBuildDraft({
        ...draft,
        datasetMode: "existing",
        tasksetRef: {
          id: "dataset_fixture",
          revision: 2,
          contentHash: "a".repeat(64),
        },
        updatedAt: "2026-07-23T12:01:00.000Z",
      });

      expect(await store.getModelBuildDraft(draft.id)).toMatchObject({
        modelId: "model_fixture",
        tasksetRef: { id: "dataset_fixture", revision: 2 },
      });
      expect(await store.listModelBuildDrafts("default")).toHaveLength(1);

      await store.deleteModelBuildDraft(draft.id);
      expect(await store.getModelBuildDraft(draft.id)).toBeNull();
    }));
});
