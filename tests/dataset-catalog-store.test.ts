import { describe, expect, test } from "vitest";
import {
  tasksetFixture,
  withTrainingStore,
} from "./helpers/training-fixtures";

describe("Dataset catalog store projection", () => {
  test("returns Dataset metadata without deserializing Taskset row payloads", async () =>
    withTrainingStore(async ({ store }) => {
      const taskset = tasksetFixture({ ready: true });
      await store.upsertTaskset(taskset);

      const datasets = await store.listDatasetCatalogTasksets(
        taskset.profileId,
      );

      expect(datasets).toEqual([{
        tasksetId: taskset.id,
        tasksetRevision: taskset.revision,
        artifactId: null,
        name: taskset.name,
        status: taskset.status,
        storageKind: "inline",
        rowCount: taskset.tasks.length,
        splitCounts: {
          train: taskset.tasks.filter((task) => task.split === "train").length,
          validation: taskset.tasks.filter(
            (task) => task.split === "validation",
          ).length,
          test: taskset.tasks.filter((task) => task.split === "test").length,
          frozen_eval: taskset.tasks.filter(
            (task) => task.split === "frozen_eval",
          ).length,
        },
        createdAt: taskset.createdAt,
        updatedAt: taskset.updatedAt,
      }]);
      expect(datasets[0]).not.toHaveProperty("tasks");
      expect(datasets[0]).not.toHaveProperty("sourceRefs");
    }));
});
