import { createServerStartupDeadline, isStorageStartupProgress, STORAGE_STARTUP_PROGRESS_PREFIX } from "../packages/runtime/src/ready-line-parser";
import { describe, expect, test, vi } from "vitest";

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

  // A valid large upgrade can outlive ordinary startup; once ready or failed,
  // no leftover timer may terminate the child process later.
  test("extends startup only for valid storage progress and releases its deadline", () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const deadline = createServerStartupDeadline(60_000, expired);
    const parser = createReadyLineParser<unknown>(STORAGE_STARTUP_PROGRESS_PREFIX, value => {
      if (isStorageStartupProgress(value)) deadline.progress(value);
    });
    try {
      vi.advanceTimersByTime(50_000);
      parser.push(`${STORAGE_STARTUP_PROGRESS_PREFIX}${JSON.stringify({ phase: "backup", message: "Saving", percent: 10 })}\n`);
      vi.advanceTimersByTime(120_000);
      expect(expired).not.toHaveBeenCalled();
      parser.push(`${STORAGE_STARTUP_PROGRESS_PREFIX}${JSON.stringify({ phase: "complete", message: "Ready" })}\n`);
      vi.advanceTimersByTime(59_000);
      expect(expired).not.toHaveBeenCalled();
      parser.push(`${STORAGE_STARTUP_PROGRESS_PREFIX}${JSON.stringify({ phase: "other", message: "invalid" })}\n`);
      vi.advanceTimersByTime(1_000);
      expect(expired).toHaveBeenCalledTimes(1);
      deadline.stop();
      deadline.progress({ phase: "backup", message: "Late" });
      vi.advanceTimersByTime(31 * 60_000);
      expect(expired).toHaveBeenCalledTimes(1);
      const bounded = createServerStartupDeadline(60_000, expired);
      bounded.progress({ phase: "migrate", message: "Working" });
      vi.advanceTimersByTime(30 * 60_000);
      expect(expired).toHaveBeenCalledTimes(2);
      bounded.stop();
    } finally { deadline.stop(); vi.useRealTimers(); }
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
