import { describe, expect, test } from "vitest";

import { serverListenArgs } from "../apps/terminal/src/connection";

describe("terminal server connection", () => {
  test("starts an owned server on the requested host and port", () => {
    expect(serverListenArgs("http://127.0.0.1:0")).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ]);
    expect(serverListenArgs("http://localhost:17874")).toEqual([
      "--host",
      "localhost",
      "--port",
      "17874",
    ]);
  });

  test("rejects unsupported server URLs before spawning a process", () => {
    expect(() => serverListenArgs("file:///tmp/openpond.sock")).toThrow(
      "must use http or https",
    );
    expect(() => serverListenArgs("not a url")).toThrow(
      "Invalid OpenPond App server URL",
    );
  });
});
