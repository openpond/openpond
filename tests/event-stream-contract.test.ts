import { describe, expect, test } from "vitest";

import {
  runtimeEventReconnectDelayMs,
  runtimeEventStreamRequest,
  validateRuntimeEventResponse,
} from "../apps/web/src/api/event-stream";
import {
  terminalEventReconnectDelayMs,
  terminalEventStreamRequest,
  validateTerminalEventResponse,
} from "../apps/terminal/src/events";

describe.each([
  {
    surface: "web",
    request: () =>
      runtimeEventStreamRequest({
        serverUrl: "http://127.0.0.1:17876/",
        token: "local-token",
      }),
    expectedUrl: "http://127.0.0.1:17876/v1/events",
    validate: validateRuntimeEventResponse,
    reconnectDelay: runtimeEventReconnectDelayMs,
  },
  {
    surface: "terminal",
    request: () =>
      terminalEventStreamRequest("http://127.0.0.1:17874/", "local-token"),
    expectedUrl: "http://127.0.0.1:17874/v1/events",
    validate: validateTerminalEventResponse,
    reconnectDelay: terminalEventReconnectDelayMs,
  },
])("$surface event stream contract", ({
  request,
  expectedUrl,
  validate,
  reconnectDelay,
}) => {
  test("uses bearer authorization without query-string credentials", () => {
    const built = request();
    const headers = built.init.headers as Headers;

    expect(built.url).toBe(expectedUrl);
    expect(built.url).not.toContain("token=");
    expect(headers.get("Authorization")).toBe("Bearer local-token");
    expect(headers.get("Accept")).toBe("text/event-stream");
  });

  test("rejects unsuccessful or bodyless responses", () => {
    expect(() => validate(new Response(null, { status: 401 }))).toThrow(
      /event stream failed: 401/,
    );
    expect(() => validate(new Response(null, { status: 200 }))).toThrow(
      /response body/,
    );
  });

  test("caps exponential reconnect backoff", () => {
    expect([0, 1, 5, 20].map(reconnectDelay)).toEqual([
      500,
      1_000,
      10_000,
      10_000,
    ]);
  });
});
