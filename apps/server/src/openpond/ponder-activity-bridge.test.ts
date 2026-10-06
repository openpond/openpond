import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import { createPonderActivityBridge } from "./ponder-activity-bridge.js";

const account = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@openpond/runtime", () => ({ loadOpenPondAccountContext: account.load }));

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Failure story: event-time account lookup rejects while an earlier sync blocks
// the queue. An unobserved rejection kills the local server before queue retry
// handling can run, and later task activity never reaches its durable outbox.
test("handles a rejected captured scope before its queue turn and continues syncing subsequent activity", async () => {
  const storeDir = await mkdtemp(path.join(tmpdir(), "ponder-activity-rejection-"));
  const firstRequest = gate(), releaseFirstRequest = gate();
  const onUnhandled = vi.fn();
  const warn = vi.fn(), unsubscribe = vi.fn();
  let listener!: (event: RuntimeEvent) => void;
  let settingsRequests = 0;
  const signedIn = { accountState: { state: "signed_in", baseUrl: "https://fixture.invalid", activeProfile: { slug: "fixture-profile" } } };
  account.load.mockResolvedValue(signedIn);
  const delivered: Array<{ bindingId: unknown; items: Array<{ id: string; resourceId: string }> }> = [];
  process.on("unhandledRejection", onUnhandled);
  const bridge = createPonderActivityBridge({ storeDir, deviceId: "fixture-device", teamId: async () => "fixture-team",
    subscribe: (handler) => { listener = handler; return unsubscribe; },
    sessionTitle: async () => "Fixture task", workflows: async () => ({ workflows: [], runs: [] }), warn,
    request: async (request) => {
      if (request.path === "/ponder/settings") {
        settingsRequests++;
        if (settingsRequests === 1) { firstRequest.resolve(); await releaseFirstRequest.promise; }
        return { bindingId: "fixture-binding", settings: { watchLocalThreads: true, watchWorkflows: false } };
      }
      const batch = request.body as { bindingId: unknown; items: Array<{ id: string; resourceId: string }> };
      delivered.push(batch);
      return { delivered: batch.items.map((item) => item.id), ignored: [] };
    },
  });
  try {
    await firstRequest.promise;
    account.load.mockRejectedValueOnce(new Error("Account storage lock busy"));
    listener({ id: "rejected-event", sessionId: "blocked-task", name: "turn.started", timestamp: "2026-10-05T10:00:00Z" });
    // Let rejection detection run while the queue is still blocked. Waiting only
    // after release would miss the precise delayed-attachment crash window.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onUnhandled).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    releaseFirstRequest.resolve();
    await bridge.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([]);

    listener({ id: "healthy-event", sessionId: "healthy-task", name: "turn.completed", timestamp: "2026-10-05T10:01:00Z" });
    await bridge.flush();
    expect(delivered).toEqual([{ bindingId: "fixture-binding", items: [expect.objectContaining({ id: "local:fixture-device:healthy-event", resourceId: "healthy-task" })] }]);
    const [file] = await readdir(path.join(storeDir, "ponder-activity"));
    expect(JSON.parse(await readFile(path.join(storeDir, "ponder-activity", file!), "utf8"))).toMatchObject({ pending: [] });
    expect(onUnhandled).not.toHaveBeenCalled();
  } finally {
    releaseFirstRequest.resolve();
    await bridge.close();
    process.off("unhandledRejection", onUnhandled);
    await rm(storeDir, { recursive: true, force: true });
  }
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
