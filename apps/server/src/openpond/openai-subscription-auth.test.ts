import { afterEach, describe, expect, test, vi } from "vitest";
import { refreshOpenAiSubscriptionToken } from "./openai-subscription-auth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI subscription token refresh", () => {
  test("explains how to reconnect when OpenAI rejects the saved login", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));

    await expect(refreshOpenAiSubscriptionToken("stale-refresh-token")).rejects.toThrow(
      /sign-in.*expired|invalidated/i,
    );
  });

  test("keeps the status code for other refresh failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));

    await expect(refreshOpenAiSubscriptionToken("refresh-token")).rejects.toThrow(
      "OpenAI token refresh failed: 503",
    );
  });
});
