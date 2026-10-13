import { afterEach, expect, test, vi } from "vitest";
import { scheduleGettingStarted } from "./onboarding-lifecycle";

afterEach(() => vi.useRealTimers());

// A late bootstrap or another modal must not produce a surprise dialog after
// disconnect/unmount, and normal startup must get exactly one delayed prompt.
test("delays the prompt, waits for other dialogs, and cancels pending retries", () => {
  vi.useFakeTimers();
  const open = vi.fn();
  let blocked = false;
  const cancel = scheduleGettingStarted(open, () => blocked);
  vi.advanceTimersByTime(4_999);
  expect(open).not.toHaveBeenCalled();
  blocked = true;
  vi.advanceTimersByTime(1_001);
  expect(open).not.toHaveBeenCalled();
  cancel();
  blocked = false;
  vi.advanceTimersByTime(5_000);
  expect(open).not.toHaveBeenCalled();

  const finish = scheduleGettingStarted(open, () => blocked);
  vi.advanceTimersByTime(5_000);
  expect(open).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(10_000);
  expect(open).toHaveBeenCalledOnce();
  finish();
});
