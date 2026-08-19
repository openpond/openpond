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
