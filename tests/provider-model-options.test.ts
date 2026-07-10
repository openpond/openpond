import { describe, expect, test } from "bun:test";

import {
  defaultProviderCredentialTab,
  providerCredentialLabel,
  providerCredentialTabs,
  providerRowsForSubscriptionFilter,
  providerSupportsSubscription,
  visibleProviderModelOptions,
} from "../apps/web/src/components/settings/ProviderSettingsSection";
import {
  modelOptionsForProvider,
  providerModelSupportsReasoning,
} from "../apps/web/src/lib/app-models";
import { buildProviderSettings } from "../apps/server/src/openpond/provider-registry";
import type { ProviderSecrets } from "../apps/server/src/openpond/provider-secrets";

describe("provider model option capping", () => {
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

  test("labels Z.ai Coding Plan credentials as plan keys", () => {
    const secrets: ProviderSecrets = {
      version: 1,
      providers: {
        zai: {
          source: "local_secret",
          value: "zai-test-key",
          envVar: null,
          oauth: null,
          createdAt: "2026-07-08T00:00:00.000Z",
          updatedAt: "2026-07-08T00:00:00.000Z",
          lastValidatedAt: null,
          lastError: null,
        },
      },
    };
    const settings = buildProviderSettings({
      file: { version: 1, providers: {}, modelCaches: {} },
      secrets,
    });

    expect(providerCredentialLabel(settings.statuses.zai!, settings)).toBe("Coding Plan key");
  });

  test("keeps current OpenAI subscription models visible with reasoning effort support", () => {
    const settings = buildProviderSettings({
      file: {
        version: 1,
        providers: {},
        modelCaches: {
          openai: {
            providerId: "openai",
            models: [
              {
                id: "gpt-5.5",
                providerId: "openai",
                displayName: "GPT-5.5",
                contextWindow: null,
                outputLimit: null,
                lifecycleStatus: "active",
                source: "curated",
                capabilities: { reasoning: true },
              },
            ],
            fetchedAt: "2026-07-08T10:00:00.000Z",
            lastError: null,
            source: "curated",
          },
        },
      },
    });
    const options = modelOptionsForProvider("openai", settings).map((option) => option.value);

    expect(options.slice(0, 3)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(options).toContain("gpt-5.5");
    expect(options).toContain("gpt-5.3-codex-spark");
    expect(providerModelSupportsReasoning("openai", "gpt-5.6-sol", settings)).toBe(true);
    expect(providerModelSupportsReasoning("openai", "gpt-5.3-codex-spark", settings)).toBe(true);
  });
});
