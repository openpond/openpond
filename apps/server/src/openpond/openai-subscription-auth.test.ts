import { afterEach, describe, expect, test, vi } from "vitest";
import { refreshOpenAiSubscriptionToken } from "./openai-subscription-auth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI subscription token refresh", () => {
  test("explains how to reconnect when OpenAI rejects the saved login", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));

    await expect(refreshOpenAiSubscriptionToken("stale-refresh-token")).rejects.toThrow(
      "Your OpenAI ChatGPT sign-in has expired or was invalidated. Reconnect it in Settings > Providers > OpenAI > Subscription by selecting Connect ChatGPT. This is an authentication issue, not a billing or model-access error.",
    );
  });

  test("keeps the status code for other refresh failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));

    await expect(refreshOpenAiSubscriptionToken("refresh-token")).rejects.toThrow(
      "OpenAI token refresh failed: 503",
    );
  });
});
