import { expect, test, vi } from "vitest";
import type { SqliteStore } from "../store/store.js";
import { listHostedModelProjectCatalog } from "./hosted-model-project-catalog.js";

// Failure story: multiple desktop surfaces used to issue the same expensive
// catalog read concurrently. Sharing must stop at an account/credential change.
test("catalog refreshes share in-flight work and scope cached reads to the actor", async () => {
  const cache = new Map<string, unknown>();
  const store = {
    getCacheEntry: async (_type: string, key: string) => cache.has(key) ? { payload: cache.get(key) } : null,
    setCacheEntry: async (_type: string, key: string, payload: unknown) => { cache.set(key, payload); },
    listModelProjects: async () => [],
  } as unknown as SqliteStore;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher = vi.fn(async () => { await gate; return new Response(JSON.stringify({ projects: [] })); });
  const access = { apiBaseUrl: "https://api.example.test", teamId: "team", actorId: "actor", token: "first" };
  const input = { store, fetch: fetcher as typeof fetch, resolveAccess: async () => ({ ...access }) };
  const reads = [listHostedModelProjectCatalog(input, { refresh: true }), listHostedModelProjectCatalog(input, { refresh: true })];
  release();
  await Promise.all(reads);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await listHostedModelProjectCatalog(input, { maxAgeMs: 30_000 })).cached).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  access.actorId = "another-actor";
  await listHostedModelProjectCatalog(input, { maxAgeMs: 30_000 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  await listHostedModelProjectCatalog(input, { maxAgeMs: 0 });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
