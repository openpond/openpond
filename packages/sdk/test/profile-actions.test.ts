import { afterEach, describe, expect, test, vi } from "vitest";

import {
  OpenPondProfileActionsClient,
  createOpenPondClient,
} from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

describe("OpenPondProfileActionsClient", () => {
  test("reads the selected Profile's safe action catalog", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        catalog: {
          profileId: "profile_1",
          profileName: "ducky-capital",
          catalogVersion: "profile-catalog-v1:test",
          sourceCommitSha: "source_sha",
          actions: [],
        },
      }),
    );
    const client = new OpenPondProfileActionsClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.test/",
    });

    const catalog = await client.catalog({
      teamId: "team_1",
      profileId: "profile_1",
      profileName: "ducky-capital",
    });

    expect(catalog.catalogVersion).toBe("profile-catalog-v1:test");
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://api.example.test/v1/profile/actions?teamId=team_1&profileId=profile_1&profileName=ducky-capital",
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "ApiKey opk_test",
    );
  });

  test("is available from the root OpenPond client", () => {
    const client = createOpenPondClient({
      apiKey: "opk_test",
      baseUrl: "https://api.example.test/",
    });

    expect(client.profileActions).toBeInstanceOf(OpenPondProfileActionsClient);
  });

  test("runs a published Profile action through its explicit action entrypoint", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        run: {
          id: "agent_run_1",
          status: "succeeded",
          conversationId: "conversation_1",
          resultJson: { tradeCount: 3 },
        },
      }),
    );
    const client = new OpenPondProfileActionsClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.test",
    });

    const result = await client.run<{ tradeCount: number }>({
      teamId: "team_1",
      agentId: "agent_1",
      actionId: "review-recent-hyperliquid-trades",
      value: { lookbackHours: 24 },
      idempotencyKey: "task_1:turn_1",
      catalogVersion: "profile-catalog-v1:test",
    });

    expect(result.run.resultJson?.tradeCount).toBe(3);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://api.example.test/v1/agents/agent_1/run?teamId=team_1",
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      entrypoint: { scope: "action", name: "review-recent-hyperliquid-trades" },
      input: { lookbackHours: 24 },
      idempotencyKey: "task_1:turn_1",
      runtimeSourcePolicy: { requirePublishedSnapshot: true, source: "manual" },
      metadata: { profileCatalogVersion: "profile-catalog-v1:test" },
    });
  });

  test("rejects a missing workspace before making a request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const client = new OpenPondProfileActionsClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.test",
    });

    await expect(client.catalog({ teamId: " " })).rejects.toThrow(
      "teamId is required",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
