import { expect, it, vi } from "vitest";
import { createDatasetTrainingReviewClient, DatasetTrainingReviewRequestSchema } from "../src/dataset-training-review.js";

// A review schema supported by generic JSON but rejected by task definitions
// must fail locally, rather than become an opaque server400 after import work.
it("rejects unsupported task-schema keywords before a dataset review is dispatched", async () => {
  const schema = (items: Record<string, unknown>) => ({ type: "object", properties: { paths: { type: "array", items } } });
  const request = {
    schemaVersion: "openpond.datasetTrainingReviewRequest.v1" as const,
    teamId: "team", operationId: "review", dataset: { id: "dataset", revision: 1, contentHash: "a".repeat(64) },
    packageHash: "b".repeat(64), taskIds: ["task"], purpose: "supervised_training" as const,
    rewardBindingRef: null, targetSource: "expected_output" as const, shareWithWorkspace: true as const,
    definition: { outputSchema: schema({ type: "string", pattern: "^/" }) },
  };
  const transport = vi.fn();
  await expect(createDatasetTrainingReviewClient(transport).reviewDataset(request)).rejects.toMatchObject({
    issues: [expect.objectContaining({ path: ["definition", "outputSchema"] })],
  });
  expect(transport).not.toHaveBeenCalled();
  const supported = { ...request, definition: { outputSchema: schema({ type: "string", minLength: 1 }) } };
  expect(DatasetTrainingReviewRequestSchema.safeParse(supported).success).toBe(true);
});
