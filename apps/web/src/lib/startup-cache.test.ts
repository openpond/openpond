import { expect, test, vi } from "vitest";
import {
  preloadOpenPondOrganizations,
  readOpenPondOrganizationsFromMemory,
  writeOpenPondOrganizationsToMemory,
} from "./openpond-organization-memory";
import {
  preloadSandboxAgents,
  readSandboxAgentsFromMemory,
  writeSandboxAgentsToMemory,
} from "./sandbox-agent-memory";
import type { OpenPondOrganization } from "./organization-types";
import type { SandboxAgent } from "./sandbox-types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function checkCache<T>(name: string, cache: {
  load: (key: string, fetch: () => Promise<T[]>, force?: boolean) => Promise<T[]>;
  read: (key: string) => T[] | null;
  write: (key: string, rows: T[]) => void;
}) {
  // Focus, startup and settings can request the same data together. They must
  // share work without letting a late refresh undo an intervening saved change.
  test(`${name}: coalesces refreshes, protects newer writes and recovers after failure`, async () => {
    const key = `${name}-account`;
    const initial: T[] = [];
    const refreshed: T[] = [];
    cache.write(key, initial);
    const reply = deferred<T[]>();
    const fetch = vi.fn(() => reply.promise);
    const first = cache.load(key, fetch, true);
    const second = cache.load(key, fetch, true);
    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await cache.load(key, fetch)).toBe(initial);
    reply.resolve(refreshed);
    expect(await first).toBe(refreshed);
    expect(cache.read(key)).toBe(refreshed);

    const late = deferred<T[]>();
    const pending = cache.load(key, () => late.promise, true);
    const saved: T[] = [];
    cache.write(key, saved);
    late.resolve(initial);
    await pending;
    expect(cache.read(key)).toBe(saved);
    expect(cache.read(`${key}-other`)).toBeNull();
    const other: T[] = [];
    expect(await cache.load(`${key}-other`, async () => other, true)).toBe(other);
    expect(cache.read(key)).toBe(saved);

    const failed = deferred<T[]>();
    const failure = expect(cache.load(key, () => failed.promise, true)).rejects.toThrow("offline");
    failed.reject(new Error("offline"));
    await failure;
    expect(cache.read(key)).toBe(saved);
    expect(await cache.load(key, async () => refreshed, true)).toBe(refreshed);
    expect(cache.read(key)).toBe(refreshed);
  });
}

checkCache<OpenPondOrganization>("organizations", {
  load: (accountKey, fetchOrganizations, force) => preloadOpenPondOrganizations({ accountKey, fetchOrganizations, force }),
  read: readOpenPondOrganizationsFromMemory,
  write: writeOpenPondOrganizationsToMemory,
});

checkCache<SandboxAgent>("team agents", {
  load: (accountKey, fetchAgents, force) => preloadSandboxAgents({ teamId: "same-team", accountKey, fetchAgents, force }),
  read: (key) => readSandboxAgentsFromMemory("same-team", key),
  write: (key, rows) => writeSandboxAgentsToMemory("same-team", rows, key),
});

// A hung desktop discovery or response body cannot trap startup forever; a
// cancelled attempt must settle before a new attempt is allowed to publish.
test("startup deadlines abort hung work and allow a fresh attempt", async () => {
  const { startupRequest } = await import("../startup/startup-request");
  vi.useFakeTimers();
  try {
    let requestSignal: AbortSignal | undefined;
    const request = startupRequest(signal => { requestSignal = signal; return new Promise(() => {}); }, new AbortController().signal, 100);
    const rejected = expect(request).rejects.toThrow("too long");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    await expect(startupRequest(async () => "ready", new AbortController().signal, 100)).resolves.toBe("ready");
    const controller = new AbortController();
    const pending = startupRequest(() => new Promise(() => {}), controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await cancelled;
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
