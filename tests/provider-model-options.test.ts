import { describe, expect, test } from "bun:test";

import {
  providerRowsForSubscriptionFilter,
  providerSupportsSubscription,
  visibleProviderModelOptions,
} from "../apps/web/src/components/settings/ProviderSettingsSection";
import { buildProviderSettings } from "../apps/server/src/openpond/provider-registry";

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

  test("filters providers to subscription-capable credential modes", () => {
    const settings = buildProviderSettings({
      file: { version: 1, providers: {}, modelCaches: {} },
    });

    expect(providerSupportsSubscription(settings.statuses.openai)).toBe(true);
    expect(providerSupportsSubscription(settings.statuses.xai)).toBe(false);
    expect(providerRowsForSubscriptionFilter(settings, true)).toEqual(["openai"]);
    expect(providerRowsForSubscriptionFilter(settings, false)).toContain("xai");
  });
});
