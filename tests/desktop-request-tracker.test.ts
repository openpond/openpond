import { describe, expect, test } from "vitest";

import { DesktopRequestTracker } from "../apps/desktop/src/desktop-request-tracker";

describe("desktop request tracker", () => {
  test("records slow local RPC acknowledgements without keeping fast requests", async () => {
    let now = 1_000;
    const tracker = new DesktopRequestTracker({
      slowThresholdMs: 100,
      stuckThresholdMs: 500,
      now: () => now,
      dateNow: () => "2026-07-01T00:00:00.000Z",
    });

    await tracker.wrap("openpond:fast", () => {
      now += 20;
      return "fast";
    })();
    await tracker.wrap("openpond:slow", () => {
      now += 125;
      return "slow";
    })();

    expect(tracker.snapshot()).toEqual({
      slowThresholdMs: 100,
      stuckThresholdMs: 500,
      pendingCount: 0,
      recentSlowRequests: [
        {
          id: 2,
          channel: "openpond:slow",
          startedAt: "2026-07-01T00:00:00.000Z",
          durationMs: 125,
          status: "ok",
        },
      ],
      stuckRequests: [],
    });
  });

  test("surfaces stuck pending local RPC requests", () => {
    let now = 2_000;
    const tracker = new DesktopRequestTracker({
      slowThresholdMs: 100,
      stuckThresholdMs: 300,
      now: () => now,
      dateNow: () => "2026-07-01T00:00:01.000Z",
    });
    void tracker.wrap("openpond:browser:navigate", () => new Promise(() => undefined))();

    now += 350;

    expect(tracker.snapshot()).toMatchObject({
      pendingCount: 1,
      stuckRequests: [
        {
          id: 1,
          channel: "openpond:browser:navigate",
          startedAt: "2026-07-01T00:00:01.000Z",
          durationMs: 350,
          status: "pending",
        },
      ],
    });
  });

  test("keeps slow request diagnostics bounded and records errors", async () => {
    let now = 3_000;
    const tracker = new DesktopRequestTracker({
      slowThresholdMs: 10,
      stuckThresholdMs: 100,
      maxRecentSlowRequests: 2,
      now: () => now,
      dateNow: () => "2026-07-01T00:00:02.000Z",
    });

    for (const channel of ["openpond:first", "openpond:second"]) {
      await tracker.wrap(channel, () => {
        now += 15;
      })();
    }
    await expect(
      tracker.wrap("openpond:third", () => {
        now += 15;
        throw new Error("failed with secret payload that should be truncated".repeat(20));
      })(),
    ).rejects.toThrow("failed");

    const snapshot = tracker.snapshot();
    expect(snapshot.recentSlowRequests.map((request) => request.channel)).toEqual([
      "openpond:second",
      "openpond:third",
    ]);
    expect(snapshot.recentSlowRequests[1]).toMatchObject({
      status: "error",
      durationMs: 15,
    });
    expect(snapshot.recentSlowRequests[1]?.error?.length).toBeLessThanOrEqual(503);
  });

  test("can exclude diagnostics export from pending and slow request snapshots", async () => {
    let now = 4_000;
    const tracker = new DesktopRequestTracker({
      slowThresholdMs: 10,
      stuckThresholdMs: 50,
      now: () => now,
      dateNow: () => "2026-07-01T00:00:03.000Z",
    });

    await tracker.wrap("openpond:diagnostics:export", () => {
      now += 20;
    })();
    void tracker.wrap("openpond:diagnostics:export", () => new Promise(() => undefined))();
    now += 60;

    const snapshot = tracker.snapshot({ excludeChannels: ["openpond:diagnostics:export"] });

    expect(snapshot.pendingCount).toBe(0);
    expect(snapshot.recentSlowRequests).toEqual([]);
    expect(snapshot.stuckRequests).toEqual([]);
  });
});
