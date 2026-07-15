import { describe, expect, test } from "bun:test";

import {
  openEventStream,
  readRuntimeEventStream,
  runtimeEventReconnectDelayMs,
  runtimeEventStreamRequest,
  validateRuntimeEventResponse,
} from "../apps/web/src/api/event-stream";

function eventStreamResponse(frames: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frames));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("web runtime event stream helpers", () => {
  test("uses Authorization headers instead of query-string tokens", () => {
    const request = runtimeEventStreamRequest({
      serverUrl: "http://127.0.0.1:17876/",
      token: "local-token",
    });
    const headers = request.init.headers as Headers;

    expect(request.url).toBe("http://127.0.0.1:17876/v1/events");
    expect(request.url).not.toContain("token=");
    expect(headers.get("Authorization")).toBe("Bearer local-token");
    expect(headers.get("Accept")).toBe("text/event-stream");
  });

  test("starts after the bootstrap event window instead of replaying all history", () => {
    const request = runtimeEventStreamRequest(
      {
        serverUrl: "http://127.0.0.1:17876/",
        token: "local-token",
      },
      undefined,
      95_874,
    );

    expect(request.url).toBe("http://127.0.0.1:17876/v1/events?afterSequence=95874");
  });

  test("validates event stream response status and body", () => {
    expect(() => validateRuntimeEventResponse(new Response(null, { status: 401 }))).toThrow(
      /event stream failed: 401/,
    );
    expect(() => validateRuntimeEventResponse(new Response(null, { status: 200 }))).toThrow(
      /response body/,
    );
  });

  test("parses ready and runtime SSE frames while ignoring comments and malformed frames", async () => {
    const ready: boolean[] = [];
    const events: Array<{ name: string; sessionId?: string }> = [];

    await readRuntimeEventStream(
      eventStreamResponse(
        [
          "event: ready",
          'data: {"ok":true}',
          "",
          ": heartbeat 1",
          "",
          "event: runtime",
          'data: {"name":"turn.started","sessionId":"active"}',
          "",
          "event: runtime",
          "data: not-json",
          "",
          "event: other",
          'data: {"name":"ignored"}',
          "",
          "event: runtime",
          'data: {"name":"assistant.delta"}',
          "",
        ].join("\n"),
      ),
      (event) => events.push({ name: event.name, sessionId: event.sessionId }),
      () => ready.push(true),
    );

    expect(ready.length).toBe(1);
    expect(events).toEqual([
      { name: "turn.started", sessionId: "active" },
      { name: "assistant.delta", sessionId: undefined },
    ]);
  });

  test("caps reconnect backoff", () => {
    expect(runtimeEventReconnectDelayMs(0)).toBe(500);
    expect(runtimeEventReconnectDelayMs(1)).toBe(1000);
    expect(runtimeEventReconnectDelayMs(5)).toBe(10000);
    expect(runtimeEventReconnectDelayMs(20)).toBe(10000);
  });

  test("reports failed fetch-stream responses without marking the stream open", async () => {
    const opened: boolean[] = [];
    const errors: string[] = [];
    let handle: ReturnType<typeof openEventStream> | null = null;

    await new Promise<void>((resolve) => {
      handle = openEventStream(
        { serverUrl: "http://127.0.0.1:17876", token: "local-token" },
        () => undefined,
        (error) => {
          errors.push(error instanceof Error ? error.message : String(error));
          handle?.close();
          resolve();
        },
        () => opened.push(true),
        {
          fetchImpl: async () => new Response(null, { status: 401, statusText: "Unauthorized" }),
          reconnectDelayMs: () => 1,
        },
      );
    });

    expect(opened).toEqual([]);
    expect(handle?.isOpen()).toBe(false);
    expect(errors[0]).toContain("event stream failed: 401");
  });

  test("resumes reconnects after the last event already applied", async () => {
    const urls: string[] = [];
    const sequences: number[] = [];
    const responses = [
      eventStreamResponse(
        [
          "event: ready",
          'data: {"ok":true}',
          "",
          "event: runtime",
          'data: {"id":"event-41","name":"assistant.delta","sequence":41}',
          "",
        ].join("\n"),
      ),
      eventStreamResponse(
        [
          "event: ready",
          'data: {"ok":true}',
          "",
          "event: runtime",
          'data: {"id":"event-42","name":"tool.started","sequence":42}',
          "",
        ].join("\n"),
      ),
    ];
    let handle: ReturnType<typeof openEventStream> | null = null;

    await new Promise<void>((resolve) => {
      handle = openEventStream(
        { serverUrl: "http://127.0.0.1:17876", token: "local-token" },
        (event) => {
          sequences.push(event.sequence ?? 0);
          if (event.sequence === 42) {
            handle?.close();
            resolve();
          }
        },
        () => undefined,
        undefined,
        {
          afterSequence: 40,
          fetchImpl: async (input) => {
            urls.push(String(input));
            const response = responses.shift();
            if (!response) throw new Error("unexpected reconnect");
            return response;
          },
          reconnectDelayMs: () => 0,
        },
      );
    });

    expect(sequences).toEqual([41, 42]);
    expect(urls).toEqual([
      "http://127.0.0.1:17876/v1/events?afterSequence=40",
      "http://127.0.0.1:17876/v1/events?afterSequence=41",
    ]);
  });
});
