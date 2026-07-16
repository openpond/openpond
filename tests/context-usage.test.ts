import { describe, expect, test } from "vitest";
import { ProviderSettingsSchema } from "../packages/contracts/src";
import { trustedProviderContextLimit } from "../apps/server/src/openpond/context-usage";

describe("provider context usage", () => {
  test("resolves trusted Z.ai context windows from provider model metadata", () => {
    const settings = ProviderSettingsSchema.parse({
      modelCaches: {
        zai: {
          providerId: "zai",
          source: "curated",
          models: [
            {
              id: "glm-5.2",
              providerId: "zai",
              displayName: "GLM-5.2",
              contextWindow: 1_000_000,
              source: "curated",
            },
            {
              id: "glm-5.1",
              providerId: "zai",
              displayName: "GLM-5.1",
              contextWindow: 200_000,
              source: "curated",
            },
          ],
        },
      },
    });

    expect(trustedProviderContextLimit({ provider: "zai", model: "glm-5.2", settings })).toBe(1_000_000);
    expect(trustedProviderContextLimit({ provider: "zai", model: "glm-5.1", settings })).toBe(200_000);
    expect(trustedProviderContextLimit({ provider: "zai", model: "unknown", settings })).toBeNull();
  });
});
