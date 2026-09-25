import { describe, expect, test } from "vitest";

import { buildProviderSettings } from "../apps/server/src/openpond/provider-registry";
import {
  defaultProviderCredentialTab,
  providerCredentialTabs,
  providerRowsForSubscriptionFilter,
  providerSupportsSubscription,
  visibleProviderModelOptions
} from "../apps/web/src/components/settings/ProviderSettingsSection";
import {
  modelOptionsForProvider
} from "../apps/web/src/lib/app-models";

describe("provider model option capping", () => {

  test("keeps the retired OpenPond Chat alias out of saved defaults and caches", () => {
    const settings = buildProviderSettings({
      file: {
        version: 1,
        providers: {
          openpond: {
            enabled: true,
            baseUrl: null,
            defaultModel: "openpond-chat",
            modelOverrides: ["openpond-chat"],
            updatedAt: null,
          },
        },
        modelCaches: {
          openpond: {
            providerId: "openpond",
            models: [
              {
                id: "openpond-chat",
                providerId: "openpond",
                displayName: "DeepSeek V4 Pro",
                contextWindow: 1_048_576,
                outputLimit: 393_216,
                lifecycleStatus: "active",
                source: "hosted",
                capabilities: { reasoning: true },
              },
            ],
            fetchedAt: "2026-09-03T00:00:00.000Z",
            lastError: null,
            source: "hosted",
          },
        },
      },
    });

    expect(settings.providers.openpond?.defaultModel).toBe(
      "accounts/fireworks/models/deepseek-v4-pro",
    );
    expect(settings.providers.openpond?.modelOverrides).not.toContain("openpond-chat");
    expect(modelOptionsForProvider("openpond", settings).map((option) => option.value)).not.toContain(
      "openpond-chat",
    );
  });

  test("caps large provider model lists", () => {
    const options = Array.from({ length: 200 }, (_, index) => ({
      value: `model-${index}`,
      label: `Model ${index}`,
    }));

    expect(visibleProviderModelOptions(options, [], 50)).toHaveLength(50);
    expect(visibleProviderModelOptions(options, [], 50).at(-1)?.value).toBe("model-49");
  });

  test("keeps pinned current and manual models visible", () => {
    const options = Array.from({ length: 200 }, (_, index) => ({
      value: `model-${index}`,
      label: `Model ${index}`,
    }));
    const visible = visibleProviderModelOptions(options, ["model-199", "model-150"], 10).map((option) => option.value);

    expect(visible).toContain("model-199");
    expect(visible).toContain("model-150");
    expect(visible).toHaveLength(10);
  });

  test("filters providers to subscription providers", () => {
    const settings = buildProviderSettings({
      file: { version: 1, providers: {}, modelCaches: {} },
    });

    expect(providerSupportsSubscription(settings.statuses.openai)).toBe(true);
    expect(providerSupportsSubscription(settings.statuses.xai)).toBe(true);
    expect(providerSupportsSubscription(settings.statuses.zai)).toBe(true);
    expect(providerRowsForSubscriptionFilter(settings, true)).toEqual(["openai", "xai", "zai"]);
    expect(providerRowsForSubscriptionFilter(settings, false)).toContain("xai");
    expect(providerCredentialTabs(settings.statuses.openai)).toEqual(["api", "subscription"]);
    expect(providerCredentialTabs(settings.statuses.openrouter)).toEqual(["api"]);
    expect(defaultProviderCredentialTab(settings.statuses.xai, settings)).toBe("api");
    expect(defaultProviderCredentialTab(settings.statuses.zai, settings)).toBe("subscription");
  });
});
