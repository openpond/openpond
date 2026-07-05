import type { IncomingMessage } from "node:http";
import { describe, expect, test } from "bun:test";
import { createBrowserControlQueue } from "../apps/server/src/openpond/browser-control-queue";

describe("browser control queue", () => {
  test("gates executor availability on desktop registration and heartbeat freshness", async () => {
    let now = Date.UTC(2026, 6, 4, 12, 0, 0);
    const queue = createBrowserControlQueue({ now: () => now, timeoutMs: 50 });

    expect(queue.executor.available(browserSession())).toBe(false);
    await expect(queue.executor.snapshot({
      ...browserBaseInput(),
      includeScreenshot: false,
      maxTargets: 50,
    })).resolves.toMatchObject({
      ok: false,
      output: "Desktop browser executor is not connected.",
    });

    expect(queue.registerDesktopExecutor({ executorToken: "desktop-token", instanceId: "desktop-1" })).toEqual({
      ok: true,
      registered: true,
      instanceId: "desktop-1",
    });
    expect(queue.executor.available(browserSession())).toBe(true);

    now += 36_000;
    expect(queue.executor.available(browserSession())).toBe(false);
    expect(queue.status()).toMatchObject({
      connected: false,
      instanceId: "desktop-1",
      pendingCount: 0,
      inFlightCount: 0,
    });

    queue.close();
  });

  test("lets the desktop executor claim and complete queued browser requests", async () => {
    const queue = createBrowserControlQueue({ timeoutMs: 500 });
    queue.registerDesktopExecutor({ executorToken: "desktop-token", instanceId: "desktop-1" });

    const resultPromise = queue.executor.click({
      ...browserBaseInput({ callId: "call-click" }),
      target: { kind: "ref", snapshotId: "browser_snap_1", targetRef: "button_1" },
      button: "left",
      clickCount: 1,
    });

    const claimed = await queue.claimNext(desktopRequest("desktop-token"));
    expect(claimed.request).toMatchObject({
      operation: "click",
      toolName: "openpond_browser_click",
      input: {
        sessionId: "session_1",
        turnId: "turn_1",
        conversationId: "conversation_1",
        callId: "call-click",
        target: { kind: "ref", snapshotId: "browser_snap_1", targetRef: "button_1" },
        button: "left",
        clickCount: 1,
      },
    });
    expect(queue.status()).toMatchObject({ pendingCount: 0, inFlightCount: 1 });

    queue.completeRequest(desktopRequest("desktop-token"), claimed.request!.id, {
      ok: true,
      output: "Clicked button.",
      data: { clicked: true },
      metadata: {
        activeTabId: "tab_1",
        title: "Example",
        url: "https://example.com/",
        cursor: { x: 120, y: 34 },
        snapshotId: "browser_snap_1",
      },
    });

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      action: "openpond_browser_click",
      output: "Clicked button.",
      data: { clicked: true },
      metadata: {
        activeTabId: "tab_1",
        title: "Example",
        url: "https://example.com/",
        cursor: { x: 120, y: 34 },
        snapshotId: "browser_snap_1",
      },
    });
    expect(queue.status()).toMatchObject({ pendingCount: 0, inFlightCount: 0 });

    queue.close();
  });

  test("rejects wrong desktop executor tokens", async () => {
    const queue = createBrowserControlQueue({ timeoutMs: 500 });
    queue.registerDesktopExecutor({ executorToken: "desktop-token", instanceId: "desktop-1" });

    await expect(queue.claimNext(desktopRequest("wrong-token"))).rejects.toThrow(
      "Unauthorized desktop browser executor.",
    );

    const resultPromise = queue.executor.snapshot({
      ...browserBaseInput(),
      includeScreenshot: false,
      maxTargets: 10,
    });
    const claimed = await queue.claimNext(desktopRequest("desktop-token"));
    expect(claimed.request?.toolName).toBe("openpond_browser_snapshot");
    expect(() =>
      queue.completeRequest(desktopRequest("wrong-token"), claimed.request!.id, { ok: true }),
    ).toThrow("Unauthorized desktop browser executor.");

    queue.completeRequest(desktopRequest("desktop-token"), claimed.request!.id, {
      ok: true,
      output: "Snapshot captured.",
    });
    await expect(resultPromise).resolves.toMatchObject({ ok: true, output: "Snapshot captured." });

    queue.close();
  });
});

function browserSession() {
  return {
    sessionId: "session_1",
    conversationId: "conversation_1",
  };
}

type BrowserBaseTestInput = {
  sessionId: string;
  turnId: string;
  conversationId: string;
  callId: string;
  signal: AbortSignal;
};

function browserBaseInput(overrides: Partial<BrowserBaseTestInput> = {}): BrowserBaseTestInput {
  const controller = new AbortController();
  return {
    sessionId: "session_1",
    turnId: "turn_1",
    conversationId: "conversation_1",
    callId: "call_1",
    signal: controller.signal,
    ...overrides,
  };
}

function desktopRequest(token: string): IncomingMessage {
  return {
    headers: {
      "x-openpond-desktop-executor-token": token,
    },
  } as IncomingMessage;
}
