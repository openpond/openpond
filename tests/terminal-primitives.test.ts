import { describe, expect, test } from "vitest";

import { createReadyLineParser } from "../apps/desktop/src/child-process-ready";
import { serverListenArgs } from "../apps/terminal/src/connection";
import { createTerminalExitLatch } from "../apps/terminal/src/exit-latch";

describe("terminal startup primitives", () => {
  test("parses ready payloads across chunks and without a final newline", () => {
    const payloads: Array<{ url?: string }> = [];
    const parser = createReadyLineParser<{ url?: string }>(
      "OPENPOND_APP_SERVER_READY ",
      (payload) => payloads.push(payload),
    );
    parser.push("noise before\nOPENPOND_APP_");
    parser.push('SERVER_READY {"url":"http://127.0.0.1:17874"}\n');
    parser.push('OPENPOND_APP_SERVER_READY {"url":"http://127.0.0.1:17875"}');
    parser.flush();
    expect(payloads).toEqual([
      { url: "http://127.0.0.1:17874" },
      { url: "http://127.0.0.1:17875" },
    ]);
  });

  test("converts owned HTTP server URLs into listen arguments", () => {
    expect(serverListenArgs("http://127.0.0.1:0")).toEqual(["--host", "127.0.0.1", "--port", "0"]);
    expect(serverListenArgs("http://localhost:17874"))
      .toEqual(["--host", "localhost", "--port", "17874"]);
    expect(() => serverListenArgs("file:///tmp/openpond.sock")).toThrow("must use http or https");
    expect(() => serverListenArgs("not a url")).toThrow("Invalid OpenPond App server URL");
  });

  test("does not lose early or repeated exit requests", async () => {
    const early = createTerminalExitLatch();
    early.request();
    await expect(early.wait()).resolves.toBeUndefined();
    expect(early.requested).toBe(true);

    const active = createTerminalExitLatch();
    const waiting = active.wait();
    active.request();
    active.request();
    await expect(waiting).resolves.toBeUndefined();
    expect(active.requested).toBe(true);
  });
});
