import { expect, test } from "vitest";
import type { loadOpenPondHostedModels } from "@openpond/runtime";
import { PrepareHarnessExperimentSchema, type HarnessExperimentPolicy } from "openpond-sdk/experiments";
import { prepareLocalExperimentModel } from "./local-experiment-model.js";

const catalog = (supportsSampling = true): typeof loadOpenPondHostedModels => async () => ({
  error: null,
  models: [{
    id: "qualified-model", displayName: "Qualified model", ownedBy: "test", streaming: true,
    raw: {
      id: "qualified-model", object: "model", created: 0, owned_by: "test", context_window: 8192, output_limit: 4096,
      capabilities: { samplingParameters: supportsSampling },
      metadata: { billing: { pricing: {
        version: "1", source: "owner", effectiveAt: "2026-10-12T00:00:00.000Z",
        inputUsdPerMillionTokens: 1, cachedInputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1,
      } } },
    },
  }],
});

// Repeated Harness attempts were silently changed to greedy sampling and a
// 4096-token ceiling. This admission boundary must preserve reviewed parameters
// and reject a provider that cannot honor them before any paid model dispatch.
test("Harness preparation sampling reaches model admission and changes its immutable configuration", async () => {
  const request = PrepareHarnessExperimentSchema.parse({
    operationId: "sampling-review", profileRepositoryId: "profile", definitionId: "quote", modelId: "qualified-model",
    maximumCostUsd: 1, maxOutputTokens: 2048, temperature: 0.7, topP: 0.9,
  });
  // Source authority is exercised by the native Profile workflow suites. This
  // boundary only consumes the already parsed policy's model selection fields.
  const hash = "a".repeat(64);
  const policy: HarnessExperimentPolicy = {
    kind: "hosted_harness", ...request, modelConfigurationHash: hash, packageHash: hash,
    source: {
      profileId: "profile", sourceRevision: "revision-1", harnessRelease: { id: "release-1", contentHash: hash },
      catalogHash: hash, definitionId: "quote", definitionHash: hash,
      target: { kind: "workflow", workflowId: "quote" }, environmentHash: hash,
    },
  };
  const sampled = await prepareLocalExperimentModel(policy, catalog());
  expect(sampled.model).toMatchObject({ maxOutputTokens: 2048, temperature: 0.7, topP: 0.9 });
  const greedy = await prepareLocalExperimentModel({ ...policy, temperature: 0 }, catalog());
  expect(sampled.model.configurationHash).not.toBe(greedy.model.configurationHash);
  await expect(prepareLocalExperimentModel(policy, catalog(false))).rejects.toMatchObject({ code: "local_sampling_unsupported" });
  await expect(prepareLocalExperimentModel({ ...policy, maxOutputTokens: 8193 }, catalog())).rejects.toMatchObject({ code: "local_model_output_limit" });
});
