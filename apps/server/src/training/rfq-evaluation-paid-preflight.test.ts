import assert from "node:assert/strict";
import { test } from "vitest";

import { assertRfqEvaluationPaidDispatchQualified } from "./rfq-evaluation-paid-preflight.js";
import { createModelComparisonEvaluationService } from "./model-comparison-evaluation-service.js";

test("RFQ Profile evaluation cannot start before request-level budget proof", () => {
  assert.throws(() => assertRfqEvaluationPaidDispatchQualified("storage-scholars"));
  assert.doesNotThrow(() => assertRfqEvaluationPaidDispatchQualified("unrelated-profile"));
});

test("RFQ comparison admission stops before taskset loading or paid execution", async () => {
  let downstreamCalls = 0;
  const store = {
    getModelComparisonSeriesEntry: async () => ({ id: "entry", seriesId: "series", modelVersionId: "version" }),
    getModelComparisonSeries: async () => ({ id: "series", profileId: "storage-scholars" }),
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
