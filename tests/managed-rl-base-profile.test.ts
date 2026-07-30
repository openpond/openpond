import { describe, expect, test } from "vitest";

import {
  MANAGED_RL_BASE_PROFILE,
  managedRlBaseProfileForModel,
  resolveManagedRlBaseProfile,
} from "../apps/server/src/training/managed-rl-base-profile.ts";

describe("Managed RL exact base profile", () => {
  test("resolves only the qualified Qwen3-0.6B identity", () => {
    expect(managedRlBaseProfileForModel("Qwen/Qwen3-0.6B")).toEqual(MANAGED_RL_BASE_PROFILE);
    expect(
      resolveManagedRlBaseProfile({
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: MANAGED_RL_BASE_PROFILE.modelId,
        revision: MANAGED_RL_BASE_PROFILE.revision,
        tokenizerRevision: MANAGED_RL_BASE_PROFILE.tokenizerRevision,
        chatTemplateHash: MANAGED_RL_BASE_PROFILE.chatTemplateHash,
        modelAssetId: null,
        source: "managed",
      }),
    ).toEqual(MANAGED_RL_BASE_PROFILE);
  });

  test("rejects other models and changed revisions", () => {
    expect(managedRlBaseProfileForModel("Qwen/Qwen3-8B")).toBeNull();
    expect(
      resolveManagedRlBaseProfile({
        schemaVersion: "openpond.baseModelPreference.v1",
        modelId: MANAGED_RL_BASE_PROFILE.modelId,
        revision: "changed",
        tokenizerRevision: MANAGED_RL_BASE_PROFILE.tokenizerRevision,
        chatTemplateHash: MANAGED_RL_BASE_PROFILE.chatTemplateHash,
        modelAssetId: null,
        source: "managed",
      }),
    ).toBeNull();
  });
});
