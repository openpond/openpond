import assert from "node:assert/strict";
import { test } from "vitest";

import { assertRfqEvaluationPaidDispatchQualified } from "./rfq-evaluation-paid-preflight.js";
import { createModelComparisonEvaluationService } from "./model-comparison-evaluation-service.js";

test("Paid comparison evaluation cannot start before request-level budget proof", () => {
  assert.throws(() => assertRfqEvaluationPaidDispatchQualified());
});

test.each(["example-rfq", "another-profile"])("comparison admission for %s stops before taskset loading or paid execution", async (profileId) => {
  let downstreamCalls = 0;
  const store = {
    getModelComparisonSeriesEntry: async () => ({ id: "entry", seriesId: "series", modelVersionId: "version" }),
    getModelComparisonSeries: async () => ({ id: "series", profileId }),
    getTasksetRevision: async () => { downstreamCalls += 1; return null; },
  };
  const service = createModelComparisonEvaluationService({
    store: store as never, storeDir: "/tmp", comparisonSeries: {} as never,
    modelStream: (() => { downstreamCalls += 1; throw new Error("provider reached"); }) as never,
  });
  await assert.rejects(service.start({ entryId: "entry", cohortRole: "development" }));
  await assert.rejects(service.startReference({
    seriesId: "series", cohortRole: "development", targetKind: "external_reference",
    label: "reference", model: { providerId: "openpond", modelId: "model" },
  }));
  assert.equal(downstreamCalls, 0);
});
