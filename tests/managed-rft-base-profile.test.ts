import { describe, expect, test } from "vitest";

import {
  MANAGED_RFT_BASE_PROFILE,
  managedRftBaseProfileForModel,
  resolveManagedRftBaseProfile,
} from "../apps/server/src/training/managed-rft-base-profile.ts";

describe("Managed RFT exact base profile", () => {
  test("resolves only the qualified Qwen3-0.6B identity", () => {
    expect(
      managedRftBaseProfileForModel("Qwen/Qwen3-0.6B"),
    ).toEqual(MANAGED_RFT_BASE_PROFILE);
    expect(
      resolveManagedRftBaseProfile({
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: MANAGED_RFT_BASE_PROFILE.modelId,
        revision: MANAGED_RFT_BASE_PROFILE.revision,
        tokenizerRevision: MANAGED_RFT_BASE_PROFILE.tokenizerRevision,
        chatTemplateHash: MANAGED_RFT_BASE_PROFILE.chatTemplateHash,
        modelAssetId: null,
        source: "managed",
      }),
    ).toEqual(MANAGED_RFT_BASE_PROFILE);
  });

  test("rejects other models and changed revisions", () => {
    expect(managedRftBaseProfileForModel("Qwen/Qwen3-8B")).toBeNull();
    expect(
      resolveManagedRftBaseProfile({
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: MANAGED_RFT_BASE_PROFILE.modelId,
        revision: "changed",
        tokenizerRevision: MANAGED_RFT_BASE_PROFILE.tokenizerRevision,
        chatTemplateHash: MANAGED_RFT_BASE_PROFILE.chatTemplateHash,
        modelAssetId: null,
        source: "managed",
      }),
    ).toBeNull();
  });
});
