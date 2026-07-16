import { describe, expect, test } from "vitest";

import {
  openUrlWithSystemBrowser,
  resolveSystemBrowserCommand,
} from "../packages/runtime/src/system-browser";

const url = "http://127.0.0.1:4317/#openpondServerUrl=http%3A%2F%2F127.0.0.1%3A4317&openpondToken=secret";

describe("system browser handoff", () => {
  test("uses argument arrays for each supported platform", () => {
    expect(resolveSystemBrowserCommand(url, "darwin")).toEqual({
      command: "open",
      args: [url],
    });
    expect(resolveSystemBrowserCommand(url, "linux")).toEqual({
      command: "xdg-open",
      args: [url],
    });
    expect(resolveSystemBrowserCommand(url, "win32")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });

  test("reports a successful launcher process", async () => {
    await expect(openUrlWithSystemBrowser(url, {
      command: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      handoffTimeoutMs: 2_000,
    })).resolves.toEqual({ opened: true });
  });

  test("reports launcher exit failures without throwing", async () => {
    const result = await openUrlWithSystemBrowser(url, {
      command: { command: process.execPath, args: ["-e", "process.exit(7)"] },
      handoffTimeoutMs: 2_000,
    });

    expect(result.opened).toBe(false);
    if (!result.opened) expect(result.error).toContain("code 7");
  });

  test("reports a missing launcher without exposing the URL", async () => {
    const result = await openUrlWithSystemBrowser(url, {
      command: { command: "openpond-browser-command-that-does-not-exist", args: [url] },
      handoffTimeoutMs: 2_000,
    });

    expect(result.opened).toBe(false);
    if (!result.opened) {
      expect(result.error).toContain("ENOENT");
      expect(result.error).not.toContain("openpondToken");
    }
  });
});
