import { expect, test } from "vitest";
import { contentHash } from "@openpond/harness";
import { HarnessExperimentPolicySchema, PrepareHarnessExperimentSchema, resolveHarnessExperimentSampling } from "../src/experiments.js";

// Failure story: parsing a reviewed request must neither erase stochastic
// sampling nor insert defaults into old immutable policies, changing their hash.
test("preserves reviewed sampling through public preparation and policy contracts", () => {
  const request = {
    operationId: "sampling-1", profileRepositoryId: "profile", definitionId: "quote", modelId: "model", maximumCostUsd: 1,
  };
  const sampling = { maxOutputTokens: 2048, temperature: 0.7, topP: 0.9 };
  expect(PrepareHarnessExperimentSchema.parse({ ...request, ...sampling })).toMatchObject(sampling);
  const hash = "a".repeat(64);
  const policy = {
    kind: "hosted_harness", modelId: "model", profileRepositoryId: "profile", modelConfigurationHash: hash, packageHash: hash,
    source: {
      profileId: "profile", sourceRevision: "revision-1", harnessRelease: { id: "release-1", contentHash: hash },
      catalogHash: hash, definitionId: "quote", definitionHash: hash,
      target: { kind: "workflow", workflowId: "quote" }, environmentHash: hash,
    },
  };
  const parsed = HarnessExperimentPolicySchema.parse(policy);
  expect(contentHash(parsed)).toBe(contentHash(policy));
  expect(parsed).not.toHaveProperty("temperature");
  expect(resolveHarnessExperimentSampling(parsed)).toEqual({ maxOutputTokens: 4096, temperature: 0, topP: 1 });
  expect(HarnessExperimentPolicySchema.parse({ ...policy, ...sampling })).toMatchObject(sampling);
  for (const invalid of [{ maxOutputTokens: 0 }, { maxOutputTokens: 1.5 }, { temperature: -0.1 }, { temperature: 2.1 }, { topP: 0 }, { topP: 1.1 }]) {
    expect(PrepareHarnessExperimentSchema.safeParse({ ...request, ...sampling, ...invalid }).success).toBe(false);
    expect(HarnessExperimentPolicySchema.safeParse({ ...policy, ...sampling, ...invalid }).success).toBe(false);
  }
});
