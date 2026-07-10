import { describe, expect, test } from "bun:test";
import { ServerLifecycleRegistry } from "../apps/server/src/runtime/server-lifecycle-registry";

describe("server lifecycle registry", () => {
  test("closes phases in order, closes peers together, and is idempotent", async () => {
    const registry = new ServerLifecycleRegistry();
    const calls: string[] = [];
    let releasePeer!: () => void;
    const peer = new Promise<void>((resolve) => {
      releasePeer = resolve;
    });
    registry.register({ id: "stop", phase: 0, close: () => calls.push("stop") });
    registry.register({ id: "peer-a", phase: 1, close: async () => {
      calls.push("peer-a:start");
      await peer;
      calls.push("peer-a:end");
    } });
    registry.register({ id: "peer-b", phase: 1, close: () => {
      calls.push("peer-b");
      releasePeer();
    } });
    registry.register({ id: "store", phase: 2, close: () => calls.push("store") });

    const first = registry.close();
    const second = registry.close();
    expect(second).toBe(first);
    await first;

    expect(calls).toEqual(["stop", "peer-a:start", "peer-b", "peer-a:end", "store"]);
    expect(registry.status()).toEqual({
      registered: ["stop", "peer-a", "peer-b", "store"],
      closed: ["stop", "peer-a", "peer-b", "store"],
    });
  });

  test("continues later phases and reports every failed owner", async () => {
    const registry = new ServerLifecycleRegistry();
    let storeClosed = false;
    registry.register({ id: "runtime", phase: 0, close: () => { throw new Error("runtime failed"); } });
    registry.register({ id: "store", phase: 1, close: () => { storeClosed = true; } });
    await expect(registry.close()).rejects.toThrow("runtime");
    expect(storeClosed).toBe(true);
    expect(registry.status().closed).toEqual(["runtime", "store"]);
  });
});
