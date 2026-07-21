import { describe, expect, test } from "vitest";
import { parseDatasetPageRows } from "../apps/server/src/training/dataset-artifact-service";

describe("dataset artifact row projection", () => {
  test("accepts requested column projections without requiring a full task record", () => {
    expect(parseDatasetPageRows([{ id: "task_1" }], ["id"]))
      .toEqual([{ id: "task_1" }]);
  });

  test("retains full task validation for unprojected rows", () => {
    expect(() => parseDatasetPageRows([{ id: "task_1" }], []))
      .toThrow();
  });
});
