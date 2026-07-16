import { describe, expect, test } from "vitest";

import { createTerminalExitLatch } from "../apps/terminal/src/exit-latch";

describe("terminal exit latch", () => {
  test("does not lose an exit requested before startup begins waiting", async () => {
    const latch = createTerminalExitLatch();

    latch.request();

    await expect(latch.wait()).resolves.toBeUndefined();
    expect(latch.requested).toBe(true);
  });

  test("releases an active startup wait and tolerates repeated requests", async () => {
    const latch = createTerminalExitLatch();
    const waiting = latch.wait();

    latch.request();
    latch.request();

    await expect(waiting).resolves.toBeUndefined();
    expect(latch.requested).toBe(true);
  });
});
