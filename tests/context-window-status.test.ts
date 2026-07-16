import { describe, expect, test } from "vitest";
import { contextWindowStatusFromUsage } from "../apps/web/src/lib/context-window";

describe("context window status", () => {
  test("surfaces the auto compaction trigger for measured provider context", () => {
    const status = contextWindowStatusFromUsage({
      provider: "openrouter",
      preferences: {
        autoEnabled: true,
        triggerPercent: 85,
        summaryModel: "same_model",
      },
      snapshot: {
        provider: "openrouter",
        model: "test/model",
        usedTokens: 1250,
        maxContextTokens: 10000,
        usableContextTokens: 2000,
        percentFull: 13,
        source: "provider_usage",
        updatedAtEventId: "event_context",
      },
    });

    expect(status.summary).toBe("13% full");
    expect(status.detail).toBe("Auto compacts at 85% context when supported.");
    expect(status.tooltip).toContain("Auto compacts at 85%");
  });

  test("warns when measured context is high and auto compaction is off", () => {
    const status = contextWindowStatusFromUsage({
      provider: "openrouter",
      preferences: {
        autoEnabled: false,
        triggerPercent: 85,
        summaryModel: "same_model",
      },
      snapshot: {
        provider: "openrouter",
        model: "test/model",
        usedTokens: 9000,
        maxContextTokens: 10000,
        usableContextTokens: 2000,
        percentFull: 90,
        source: "provider_usage",
        updatedAtEventId: "event_context",
      },
    });

    expect(status.tone).toBe("high");
    expect(status.detail).toContain("Start a new chat or turn it on");
  });

  test("explains unknown local BYOK context limits", () => {
    const status = contextWindowStatusFromUsage({
      provider: "openrouter",
      snapshot: null,
    });

    expect(status.summary).toBe("Limit unknown");
    expect(status.tokensLabel).toBe("Provider metadata unavailable");
  });

  test("keeps Codex context marked externally managed", () => {
    const status = contextWindowStatusFromUsage({
      provider: "codex",
      snapshot: null,
    });

    expect(status.summary).toBe("Managed externally");
    expect(status.detail).toBe("Context is managed by Codex app-server.");
  });
});
