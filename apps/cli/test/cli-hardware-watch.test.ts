import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { runHardwareObservations } from "../src/cli/training-hardware";

vi.mock("@openpond/runtime", () => ({
  loadOpenPondAccountContext: async () => ({
    token: "opk_private_fixture",
    apiBaseUrl: "https://api.fixture.test",
  }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A slow companion must not queue reads, leak error details, or leave the
// authenticated watch running after cancellation.
test("hardware watch honors backpressure, preserves scope and stops its single session", async () => {
  const snapshot = {
    schemaVersion: 1,
    teamId: "team-fixture",
    observedAt: "2026-01-01T00:00:00Z",
    nextCursor: null,
    workers: [
      {
        workerId: "worker-fixture",
        provider: "test",
        state: "idle",
        jobIds: [],
        receivedAt: null,
        observation: null,
        freshness: "missing",
      },
    ],
  };
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(
      "https://api.fixture.test/v1/managed-rl/hardware-observations?limit=25",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe("ApiKey opk_private_fixture");
    expect(new Headers(init?.headers).get("x-openpond-team-id")).toBe("team-fixture");
    expect(init?.redirect).toBe("error");
    const failed = request.mock.calls.length > 1;
    return new Response(
      JSON.stringify(
        failed
          ? {
              schemaVersion: "openpond.trainingApiError.v2",
              code: "fixture_rejected",
              message: "Fixture unavailable",
              retryable: false,
              requestId: "fixture-request",
              details: { secret: "must-not-leak" },
            }
          : snapshot,
      ),
      { status: failed ? 409 : 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", request);
  const records: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    records.push(String(chunk));
    return records.length !== 1;
  });
  const running = runHardwareObservations(
    { watch: true, json: true, teamId: "team-fixture", intervalMs: "100" },
    ["hosted-hardware"],
  );
  try {
    await vi.waitFor(() => expect(records).toHaveLength(1));
    await delay(150);
    expect(request).toHaveBeenCalledTimes(1);
    process.stdout.emit("drain");
    await vi.waitFor(() => expect(records.length).toBeGreaterThan(1));
    expect(JSON.parse(records[0]!)).toMatchObject({
      schemaVersion: "openpond.hardwareWatch.v1",
      kind: "snapshot",
      snapshot: { teamId: "team-fixture" },
    });
    expect(JSON.parse(records[1]!)).toMatchObject({
      kind: "error",
      error: { code: "fixture_rejected", status: 409 },
    });
    expect(records.join("")).not.toMatch(/opk_private_fixture|must-not-leak/);
  } finally {
    process.emit("SIGTERM");
    await running;
  }
  const count = request.mock.calls.length;
  await delay(120);
  expect(request).toHaveBeenCalledTimes(count);
});
