import { describe, expect, test } from "vitest";

import { shouldCollectPortableTrainingArtifacts } from "./portable-model-run-terminal.js";

describe("portable Model Run terminal handling", () => {
  test("collects artifacts only for successful executions", () => {
    expect(shouldCollectPortableTrainingArtifacts("succeeded")).toBe(true);
    expect(shouldCollectPortableTrainingArtifacts("failed")).toBe(false);
    expect(shouldCollectPortableTrainingArtifacts("cancelled")).toBe(false);
  });
});
