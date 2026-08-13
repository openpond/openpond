import { describe, expect, test, vi } from "vitest";

import { runHostedProjectAction } from "./hosted-project-actions.js";

describe("runHostedProjectAction", () => {
  test("calls the pinned hosted action release", async () => {
    const fetch = vi.fn(async (
      _baseUrl: string,
      _token: string | null,
      _path: string,
      _init?: RequestInit,
    ) => Response.json({
      invocation: {
        id: "invocation_1",
        releaseId: "release_1",
        actionId: "analytics.get_summary",
        status: "succeeded",
        resultJson: { activeMoves: 42 },
        traceJson: [],
        outputJson: [],
      },
    }));

    const result = await runHostedProjectAction({
      projectId: "project_1",
      teamId: "team_1",
      releaseId: "release_1",
      actionId: "analytics.get_summary",
      value: { businessId: "relocation" },
      idempotencyKey: "turn_1:call_1",
    }, {
      resolveAccess: async () => ({ apiBaseUrl: "https://api.example.test", token: "opk_test" }),
      fetch,
    });

    expect(result.resultJson).toEqual({ activeMoves: 42 });
    expect(fetch).toHaveBeenCalledOnce();
    const init = fetch.mock.calls[0]![3];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      releaseId: "release_1",
      callerType: "work",
    });
  });

  test("turns a failed invocation into a tool error", async () => {
    await expect(runHostedProjectAction({
      projectId: "project_1",
      teamId: "team_1",
      releaseId: "release_1",
      actionId: "analytics.get_summary",
      value: {},
    }, {
      resolveAccess: async () => ({ apiBaseUrl: "https://api.example.test", token: "opk_test" }),
      fetch: async () => Response.json({
        invocation: {
          id: "invocation_1",
          releaseId: "release_1",
          actionId: "analytics.get_summary",
          status: "failed",
          resultJson: {},
          traceJson: [],
          outputJson: [],
          failureMessage: "provider unavailable",
        },
      }),
    })).rejects.toThrow("provider unavailable");
  });
});
