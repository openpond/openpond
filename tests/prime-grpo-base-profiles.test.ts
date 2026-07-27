import { describe, expect, test } from "vitest";

import {
  PRIME_GRPO_QWEN3_0_6B_PROFILE,
  PRIME_GRPO_QWEN3_8B_PROFILE,
  primeGrpoBaseProfileForModel,
  resolvePrimeGrpoBaseProfile,
} from "../apps/server/src/training/prime-grpo-base-profiles.ts";

describe("Prime GRPO exact base profiles", () => {
  test("resolves the exact qualified 0.6B and 8B identities", () => {
    expect(
      primeGrpoBaseProfileForModel("Qwen/Qwen3-0.6B"),
    ).toEqual(PRIME_GRPO_QWEN3_0_6B_PROFILE);
    expect(
      resolvePrimeGrpoBaseProfile({
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: PRIME_GRPO_QWEN3_8B_PROFILE.modelId,
        revision: PRIME_GRPO_QWEN3_8B_PROFILE.revision,
        tokenizerRevision:
          PRIME_GRPO_QWEN3_8B_PROFILE.tokenizerRevision,
        chatTemplateHash:
          PRIME_GRPO_QWEN3_8B_PROFILE.chatTemplateHash,
        modelAssetId: null,
        source: "managed",
      }),
    ).toEqual(PRIME_GRPO_QWEN3_8B_PROFILE);
  });

  test("rejects near-match revisions and templates", () => {
    expect(
      resolvePrimeGrpoBaseProfile({
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: PRIME_GRPO_QWEN3_8B_PROFILE.modelId,
        revision: PRIME_GRPO_QWEN3_8B_PROFILE.revision,
        tokenizerRevision: "main",
        chatTemplateHash:
          PRIME_GRPO_QWEN3_8B_PROFILE.chatTemplateHash,
        modelAssetId: null,
        source: "managed",
      }),
    ).toBeNull();
  });
});
