import { describe, expect, test } from "vitest";
import type { RuntimeAccountContext } from "@openpond/runtime";
import {
  listHostedWorkSchedules,
  mutateHostedWorkSchedule,
} from "./hosted-work-schedules.js";

describe("hosted Work schedule client", () => {
  test("keeps credentials server-side and sends the explicit Team scope", async () => {
    let observed: { url: string; authorization: string | null; teamId: string | null } | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      observed = {
        url: String(input),
        authorization: headers.get("authorization"),
        teamId: headers.get("x-openpond-team-id"),
      };
      return Response.json({ definitions: [], runs: [], asOf: "2026-07-31T12:00:00.000Z" });
    }) as typeof fetch;

    await expect(
      listHostedWorkSchedules("team_customer", {
        fetchImpl,
        loadAccountContext: async () => accountContext("opk_user"),
      }),
    ).resolves.toMatchObject({ definitions: [], runs: [] });
    expect(observed).toEqual({
      url: "https://api.staging.test/v1/saved-work",
      authorization: "ApiKey opk_user",
      teamId: "team_customer",
    });
  });

  test("forwards only the bounded run mutation", async () => {
    let body = "";
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return Response.json({ runId: "run_1", conversationId: "conversation_1" });
    }) as typeof fetch;
    await mutateHostedWorkSchedule(
      {
        type: "run",
        input: {
          teamId: "team_customer",
          scheduleId: "schedule_1",
          clientRequestId: "request_1",
        },
      },
      {
        fetchImpl,
        loadAccountContext: async () => accountContext("opk_user"),
      },
    );
    expect(JSON.parse(body)).toEqual({ clientRequestId: "request_1" });
  });
});

function accountContext(token: string): RuntimeAccountContext {
  return {
    config: { apiBaseUrl: "https://api.staging.test" },
    profiles: [],
    account: null,
    token,
    apiBaseUrl: "https://api.staging.test",
    chatApiBaseUrl: "https://api.staging.test",
    accountState: {} as RuntimeAccountContext["accountState"],
  };
}
