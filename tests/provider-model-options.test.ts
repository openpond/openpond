import { describe, expect, test } from "vitest";

import { buildProviderSettings, getProviderPreset } from "../apps/server/src/openpond/provider-registry";
import { ProviderCatalogSchema, ProviderModelCacheSchema } from "@openpond/contracts";
import { composerModelGroups, modelSelectionForGroup } from "../apps/web/src/components/chat/composer-model-options";
import {
  defaultProviderCredentialTab,
  providerCredentialTabs,
  providerRowsForSubscriptionFilter,
  providerSupportsSubscription,
  visibleProviderModelOptions
} from "../apps/web/src/components/settings/ProviderSettingsSection";
import {
  defaultReasoningEffortForModel,
  effectiveReasoningEffortForModel,
  modelOptionsForProvider,
  modelRefForTurn,
  normalizeChatModel,
  providerOptionsFromSettings,
  reasoningEffortOptionsForModel,
} from "../apps/web/src/lib/app-models";

describe("provider model option capping", () => {

  // Failure story: a native provider with a lazy catalog is unreachable from the
  // picker, or presentation cleanup changes its exact advertised routing ID.
  test("selects a native provider before discovery and routes its later advertised models without changing defaults", () => {
    const settings = buildProviderSettings({ file: { version: 1, providers: {
      "claude-code": { enabled: true, baseUrl: null, defaultModel: null, modelOverrides: [], updatedAt: null },
      opencode: { enabled: true, baseUrl: null, defaultModel: null, modelOverrides: [], updatedAt: null },
    }, modelCaches: {} } });
    const defaults = JSON.stringify(settings.providers);
    const options = providerOptionsFromSettings(settings, { enabledOnly: true });
    const groups = (providerSettings = settings) => composerModelGroups({ currentProvider: "openpond",
      currentModelOptions: modelOptionsForProvider("openpond", providerSettings), providerOptions: options, providerSettings });
    const native = groups().find((group) => group.provider === "claude-code")!;
    expect(native.options).toEqual([]);
    const initial = modelSelectionForGroup(native)!;
    expect(initial).toEqual({ provider: "claude-code", model: "" });
    expect(modelRefForTurn(initial.provider, initial.model, settings)).toBeUndefined();
    const discovered = { ...settings, modelCaches: { ...settings.modelCaches,
      "claude-code": ProviderModelCacheSchema.parse({ providerId: "claude-code", source: "provider", models: [
        { providerId: "claude-code", id: "haiku", displayName: "Claude Haiku", source: "provider" },
      ] }),
      opencode: ProviderModelCacheSchema.parse({ providerId: "opencode", source: "provider", models: [
        { providerId: "opencode", id: "openai/gpt-5.4", displayName: "openai/gpt-5.4", source: "provider" },
      ] }),
    } };
    const selected = modelSelectionForGroup(groups(discovered).find((group) => group.provider === "claude-code")!)!;
    expect(modelRefForTurn(selected.provider, normalizeChatModel(selected.provider, selected.model, discovered), discovered))
      .toEqual({ providerId: "claude-code", modelId: "haiku" });
    const namespaced = modelSelectionForGroup(groups(discovered).find((group) => group.provider === "opencode")!)!;
    expect(modelRefForTurn(namespaced.provider, namespaced.model, discovered)).toEqual({ providerId: "opencode", modelId: "openai/gpt-5.4" });
    expect(modelOptionsForProvider("opencode", discovered)[0]?.label).not.toContain("openai/");
    expect(JSON.stringify(settings.providers)).toBe(defaults);
    expect(JSON.stringify(discovered.providers)).toBe(defaults);
  });

  test("uses hosted model capabilities for OpenPond's visible models and efforts", () => {
    const preset = getProviderPreset("openpond");
    const catalog = ProviderCatalogSchema.parse({
      version: 1,
      generatedAt: "2026-09-27T00:00:00.000Z",
      providers: [{
        ...preset,
        defaultModel: "gpt-6-sol",
        models: [
          { id: "gpt-6-sol", displayName: "GPT-6 Sol", capabilities: {
            reasoning: true,
            reasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
          } },
          { id: "accounts/fireworks/models/glm-5p3", displayName: "GLM-5.3", capabilities: {
            reasoning: true,
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
          } },
        ],
      }],
    });
    const settings = buildProviderSettings({
      catalog,
      file: {
        version: 1,
        providers: {},
        modelCaches: { openpond: {
          providerId: "openpond",
          models: [{
            id: "accounts/fireworks/models/deepseek-v4-pro",
            providerId: "openpond",
            displayName: "DeepSeek V4 Pro",
            source: "hosted",
            capabilities: { reasoning: true },
          }],
          fetchedAt: null,
          lastError: null,
          source: "hosted",
        } },
      },
    });

    expect(modelOptionsForProvider("openpond", settings).map((option) => option.value)).toEqual([
      "gpt-6-sol",
      "accounts/fireworks/models/glm-5p3",
    ]);
    expect(reasoningEffortOptionsForModel("openpond", "gpt-6-sol", settings).map((option) => option.value))
      .toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(reasoningEffortOptionsForModel("openpond", "accounts/fireworks/models/glm-5p3", settings).map((option) => option.value))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(defaultReasoningEffortForModel("openpond", "gpt-6-sol", settings)).toBe("medium");
    expect(effectiveReasoningEffortForModel("openpond", "accounts/fireworks/models/glm-5p3", "off", settings))
      .toBe("high");
  });

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
