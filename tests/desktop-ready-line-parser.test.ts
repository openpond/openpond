import { describe, expect, test } from "bun:test";

import { createReadyLineParser } from "../apps/desktop/src/child-process-ready";

describe("desktop child process ready line parser", () => {
  test("parses ready payloads split across stdout chunks", () => {
    const payloads: Array<{ url?: string }> = [];
    const parser = createReadyLineParser<{ url?: string }>("OPENPOND_APP_SERVER_READY ", (payload) => payloads.push(payload));

    parser.push("noise before\nOPENPOND_APP_");
    parser.push('SERVER_READY {"url":"http://127.0.0.1:17874"}\nmore output\n');

    expect(payloads).toEqual([{ url: "http://127.0.0.1:17874" }]);
  });

  test("flushes a final ready line without a trailing newline", () => {
    const payloads: Array<{ url?: string }> = [];
    const parser = createReadyLineParser<{ url?: string }>("OPENPOND_APP_SERVER_READY ", (payload) => payloads.push(payload));

    parser.push('OPENPOND_APP_SERVER_READY {"url":"http://127.0.0.1:17875"}');
    parser.flush();

    expect(payloads).toEqual([{ url: "http://127.0.0.1:17875" }]);
  });
});
