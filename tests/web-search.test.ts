import { afterEach, describe, expect, test } from "vitest";
import {
  createHostedWebSearchExecutor,
  createWebSearchExecutorFromEnv,
  normalizeSearchApiUrl,
  normalizeWebSearchRequest,
  resolveWebSearchEndpoint,
} from "../apps/server/src/openpond/web-search";

const ENV_NAMES = [
  "OPENPOND_WEB_SEARCH_ENDPOINT",
  "OPENPOND_WEB_SEARCH_API_KEY",
  "OPENPOND_SEARCH_API_URL",
  "OPENPOND_SEARCH_API_KEY",
  "OPENPOND_API_URL",
  "OPENPOND_PUBLIC_API_URL",
  "OPENPOND_OPCHAT_API_URL",
  "OPENPOND_CHAT_API_URL",
] as const;
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("hosted web search executor", () => {
  test("normalizes bounded web search requests", () => {
    expect(
      normalizeWebSearchRequest({
        query: "  openpond tools  ",
        limit: 100,
        recencyDays: 3.8,
        domains: [" openpond.ai ", "", "docs.openpond.ai"],
      }),
    ).toEqual({
      query: "openpond tools",
      limit: 10,
      recencyDays: 3,
      domains: ["openpond.ai", "docs.openpond.ai"],
    });
  });

  test("posts to a configured hosted endpoint and normalizes results", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const execute = createHostedWebSearchExecutor({
      endpoint: "https://search.example.test/v1/web",
      apiKey: "search-token",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)) as unknown,
        });
        return new Response(
          JSON.stringify({
            provider: "hosted-test",
            results: [
              {
                id: "r1",
                title: "OpenPond",
                url: "https://openpond.ai",
                text: "OpenPond result text",
                source_name: "OpenPond",
                favicon_url: "https://openpond.ai/icon.png",
                publishedDate: "2026-07-01T10:00:00.000Z",
                updated_at: "2026-07-02T10:00:00.000Z",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await execute({ query: "OpenPond", limit: 2 });

    expect(requests).toEqual([
      {
        url: "https://search.example.test/v1/web",
        authorization: "Bearer search-token",
        body: { query: "OpenPond", limit: 2 },
      },
    ]);
    expect(result).toMatchObject({
      query: "OpenPond",
      provider: "hosted-test",
      results: [
        {
          id: "r1",
          title: "OpenPond",
          url: "https://openpond.ai",
          snippet: "OpenPond result text",
          sourceName: "OpenPond",
          faviconUrl: "https://openpond.ai/icon.png",
          publishedAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-02T10:00:00.000Z",
        },
      ],
      truncated: false,
    });
  });

  test("resolves Search API endpoints from account and env bases", () => {
    expect(normalizeSearchApiUrl("https://api.example.test")).toBe(
      "https://api.example.test/v1/search",
    );
    expect(normalizeSearchApiUrl("https://api.example.test/opchat/v1")).toBe(
      "https://api.example.test/v1/search",
    );
    expect(normalizeSearchApiUrl("https://api.staging-api.openpond.ai")).toBe(
      "https://api-new.staging-api.openpond.ai/v1/search",
    );
    expect(
      resolveWebSearchEndpoint(
        {},
        {
          token: "opk_test",
          apiBaseUrl: "https://api.account.test",
          chatApiBaseUrl: "",
        },
      ),
    ).toBe("https://api.account.test/v1/search");
    expect(
      resolveWebSearchEndpoint({
        OPENPOND_WEB_SEARCH_ENDPOINT: "https://search.example.test/v1/web",
      }),
    ).toBe("https://search.example.test/v1/web");
  });

  test("uses the active account Search API by default", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      apiKey: string | null;
      body: unknown;
    }> = [];
    const execute = createWebSearchExecutorFromEnv(
      {},
      {
        loadAccountContext: async () => ({
          token: "opk_account_search",
          apiBaseUrl: "https://api-new.staging-api.openpond.ai",
          chatApiBaseUrl: "https://api-new.staging-api.openpond.ai/opchat/v1",
        }),
        fetchImpl: async (input, init) => {
          const headers = new Headers(init?.headers);
          requests.push({
            url: String(input),
            authorization: headers.get("authorization"),
            apiKey: headers.get("openpond-api-key"),
            body: JSON.parse(String(init?.body)) as unknown,
          });
          return new Response(
            JSON.stringify({
              provider: "exa",
              results: [
                {
                  title: "Result",
                  url: "https://openpond.ai",
                  text: "Snippet",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    await expect(execute({ query: "OpenPond Search", limit: 4 })).resolves.toMatchObject({
      provider: "exa",
      results: [{ title: "Result", sourceName: "openpond.ai" }],
    });

    expect(requests).toEqual([
      {
        url: "https://api-new.staging-api.openpond.ai/v1/search",
        authorization: "Bearer opk_account_search",
        apiKey: "opk_account_search",
        body: { query: "OpenPond Search", limit: 4 },
      },
    ]);
  });

  test("reports hosted failures", async () => {
    const execute = createHostedWebSearchExecutor({
      endpoint: "https://search.example.test/v1/web",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(execute({ query: "OpenPond" })).rejects.toThrow(
      "Hosted web search failed: 429 rate limited",
    );
  });

  test("normalizes Exa gateway result shape into bounded citation snippets", async () => {
    const execute = createHostedWebSearchExecutor({
      endpoint: "https://gateway.openpond.dev/search",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            requestId: "request_1",
            results: [
              {
                id: "https://www.inquirer.com/soccer/world-cup-usmnt.html",
                title: "World Cup: Malik Tillman heroics",
                url: "https://www.inquirer.com/soccer/world-cup-usmnt.html",
                publishedDate: "2026-07-02T14:01:00.000Z",
                text: "A ".repeat(1400),
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });

    const result = await execute({ query: "USMNT goals", limit: 1 });

    expect(result.provider).toBe("hosted");
    expect(result.results[0]).toMatchObject({
      title: "World Cup: Malik Tillman heroics",
      url: "https://www.inquirer.com/soccer/world-cup-usmnt.html",
      sourceName: "inquirer.com",
      faviconUrl: "https://www.inquirer.com/favicon.ico",
      publishedAt: "2026-07-02T14:01:00.000Z",
    });
    expect(result.results[0]?.snippet.length).toBeLessThanOrEqual(1200);
    expect(result.results[0]?.snippet.endsWith("…")).toBe(true);
  });
});
