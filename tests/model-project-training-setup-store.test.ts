import { describe, expect, test } from "vitest";
import { ModelProjectSchema } from "../packages/contracts/src";

import { FIXED_TIME, withTrainingStore } from "./helpers/training-fixtures";

describe("Model Project training setup store", () => {
  test("persists one stable Model Project and updates its current training setup", async () =>
    withTrainingStore(async ({ store }) => {
      const project = ModelProjectSchema.parse({
        schemaVersion: "openpond.modelProject.v2",
        id: "model_fixture",
        profileId: "default",
        revision: 1,
        name: "Fixture Model",
        objective: null,
        defaultBaseModel: null,
        defaultDestinationId: null,
        trainingSetup: {
          tasksetRef: null,
          tasksetRelease: null,
          harnessRelease: null,
          baseModel: null,
          method: null,
          destinationId: null,
          managedRolloutPlacement: "remote",
          runPreset: null,
          recipe: null,
          preferredMaximumSpendUsd: null,
          preferredRetentionDays: null,
        },
        hosted: null,
        tasksetSyncs: [],
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      });
      await store.saveModelProject(project);
      await store.saveModelProject({
        ...project,
        revision: project.revision + 1,
        trainingSetup: {
          ...project.trainingSetup,
          tasksetRef: {
            id: "dataset_fixture",
            revision: 2,
            contentHash: "a".repeat(64),
          },
          method: "sft",
          destinationId: "local",
          runPreset: "small",
        },
        updatedAt: "2026-07-23T12:01:00.000Z",
      });

      expect(await store.getModelProject(project.id)).toMatchObject({
        name: "Fixture Model",
        revision: 2,
        trainingSetup: {
          tasksetRef: { id: "dataset_fixture", revision: 2 },
          method: "sft",
          runPreset: "small",
        },
      });
      expect(await store.listModelProjects("default")).toHaveLength(1);
    }));
});
