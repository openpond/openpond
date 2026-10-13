import { expect, test, vi } from "vitest";
import { createCodexHistoryLiveRefreshCoordinator } from "./codex-history-live-refresh";

// Background windows must stop polling; two mounted surfaces must share one
// request on return, and unmounting must release the visibility listener.
test("pauses hidden history polling, coalesces resume, and releases subscriptions", async () => {
  vi.useFakeTimers();
  let visible = false;
  let notify = () => {};
  const remove = vi.fn();
  const load = vi.fn(async () => {
    throw new Error("offline");
  });
  const coordinator = createCodexHistoryLiveRefreshCoordinator({
    isVisible: () => visible,
    onVisibilityChange: (callback) => {
      notify = callback;
      return remove;
    },
    cachedPayload: () => null,
    loadPayload: load,
  });
  const subscription = {
    connection: { serverUrl: "http://localhost", token: "test", platform: "linux" },
    sessionId: "history",
    locallyActive: true,
    reportedActive: true,
    onPayload: () => {},
    surface: "sidebar" as const,
  };
  const first = coordinator.subscribe(subscription);
  const second = coordinator.subscribe(subscription);
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).not.toHaveBeenCalled();
    visible = true;
    notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    visible = false;
    notify();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(1);
    visible = true;
    notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    first();
    expect(remove).not.toHaveBeenCalled();
    second();
    expect(remove).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    first();
    second();
    vi.useRealTimers();
  }
});
