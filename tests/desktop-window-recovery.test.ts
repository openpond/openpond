import { expect, test, vi } from "vitest";
import { DesktopWindowRecovery } from "../apps/desktop/src/desktop-window-recovery.js";

// Repeated crash events must never produce an infinite reload loop.
test("shares concurrent recovery, retries once, and allows a fresh manual attempt", async () => {
  let release!: () => void;
  const load = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); });
  const showError = vi.fn(async () => {});
  const recovery = new DesktopWindowRecovery(load, showError);
  const first = recovery.failed(new Error("crashed"));
  expect(recovery.failed(new Error("duplicate"))).toBe(first);
  await Promise.resolve();
  release();
  await first;
  await recovery.failed(new Error("crashed again"));
  expect(load).toHaveBeenCalledTimes(1);
  expect(showError).toHaveBeenCalledTimes(1);
  const manual = recovery.retry();
  await Promise.resolve();
  release();
  await manual;
  expect(load).toHaveBeenCalledTimes(2);
});

test("failed navigation gets one retry before showing the recovery page", async () => {
  const error = new Error("server unavailable");
  const load = vi.fn(async () => { throw error; });
  const showError = vi.fn(async () => {});
  await new DesktopWindowRecovery(load, showError).retry();
  expect(load).toHaveBeenCalledTimes(2);
  expect(showError).toHaveBeenCalledWith(error);
});
