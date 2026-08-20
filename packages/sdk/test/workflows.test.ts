import { afterEach, describe, expect, test, vi, type MockInstance } from "vitest";

import { createOpenPondClient } from "../src/index.js";
import { OpenPondWorkflowsClient } from "../src/workflows.js";

afterEach(() => vi.restoreAllMocks());

const recurrence = {
  version: 1,
  kind: "weekdays",
  timeZone: "America/New_York",
  startDate: "2026-08-18",
  localTime: "08:30",
  end: { kind: "never" },
} as const;

describe("OpenPondWorkflowsClient", () => {
  test("manages Saved Work through the public workflow routes", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ definitions: [], runs: [], asOf: "2026-08-18T00:00:00.000Z" }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            created: true,
            definitionId: "definition_1",
            scheduleId: "schedule/1",
            name: "Morning market brief",
            enabled: true,
            nextRunAt: "2026-08-18T12:30:00.000Z",
            recurrence,
            timeZone: recurrence.timeZone,
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          schedule: {
            id: "schedule/1",
            enabled: false,
            nextRunAt: null,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { runId: "run_1", conversationId: "conversation_1" },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ schedule: { id: "schedule/1", archived: true } }),
      );
    const client = new OpenPondWorkflowsClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.test/",
    });

    await client.list();
    const created = await client.create({
      clientRequestId: "create_1",
      name: "Morning market brief",
      prompt: "Summarize the overnight market.",
      recurrence,
      enabled: false,
      target: {
        kind: "external_callback",
        callbackUrl: "https://customer.example.test/workflows/callback",
        externalReference: "binding_1",
      },
    });
    await client.update(created.scheduleId, { enabled: false });
    await client.runNow(created.scheduleId, { clientRequestId: "run_1" });
    await client.delete(created.scheduleId);

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(request(fetch, 0)).toMatchObject({
      url: "https://api.example.test/v1/saved-work",
      method: "GET",
    });
    expect(request(fetch, 1)).toMatchObject({
      url: "https://api.example.test/v1/saved-work",
      method: "POST",
      body: {
        clientRequestId: "create_1",
        name: "Morning market brief",
        prompt: "Summarize the overnight market.",
        recurrence,
        enabled: false,
        target: {
          kind: "external_callback",
          callbackUrl: "https://customer.example.test/workflows/callback",
          externalReference: "binding_1",
        },
      },
    });
    expect(request(fetch, 2)).toMatchObject({
      url: "https://api.example.test/v1/saved-work/schedules/schedule%2F1",
      method: "PATCH",
      body: { enabled: false },
    });
    expect(request(fetch, 3)).toMatchObject({
      url: "https://api.example.test/v1/saved-work/schedules/schedule%2F1/run",
      method: "POST",
      body: { clientRequestId: "run_1" },
    });
    expect(request(fetch, 4)).toMatchObject({
      url: "https://api.example.test/v1/saved-work/schedules/schedule%2F1",
      method: "DELETE",
    });
    expect(request(fetch, 0).authorization).toBe("ApiKey opk_test");
  });

  test("is available from the root OpenPond client", () => {
    const client = createOpenPondClient({
      apiKey: "opk_test",
      baseUrl: "https://api.example.test/",
    });

    expect(client.workflows).toBeInstanceOf(OpenPondWorkflowsClient);
  });

  test("rejects an empty schedule id before making a request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const client = new OpenPondWorkflowsClient({
      apiKey: "opk_test",
      apiBaseUrl: "https://api.example.test",
    });

    await expect(client.runNow(" ")).rejects.toThrow("scheduleId is required");
    expect(fetch).not.toHaveBeenCalled();
  });
});

function request(
  fetch: MockInstance<typeof globalThis.fetch>,
  index: number,
) {
  const [url, init] = fetch.mock.calls[index]!;
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const headers = new Headers(init?.headers);
  return {
    url: String(url),
    method: init?.method ?? "GET",
    body,
    authorization: headers.get("Authorization"),
  };
}
