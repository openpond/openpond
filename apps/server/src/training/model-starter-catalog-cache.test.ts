import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createModelStarterCatalogCache } from "./model-starter-catalog-cache.js";

// A packaged Desktop restart changes its renderer origin. Catalog metadata must
// survive in the local runtime, stay scoped, and remain usable during an outage.
it("retains catalog metadata across runtime restarts and refresh failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "starter-catalog-cache-"));
  try {
    const page = { items: [], nextCursor: "next-page" };
    const scope = { apiBaseUrl: "https://staging-api.example.test", teamId: "team-a", query: { limit: 30 } };
    let calls = 0;
    const fetch = async () => { calls++; return page; };
    const first = createModelStarterCatalogCache(home);
    expect(await first.list({ ...scope, fetch })).toEqual(page);
    const restarted = createModelStarterCatalogCache(home);
    const offline = async (): Promise<typeof page> => { throw new Error("network unavailable"); };
    expect(await restarted.list({ ...scope, fetch: offline })).toEqual(page);
    await expect(restarted.list({ ...scope, fresh: true, fetch: offline })).rejects.toThrow("network unavailable");
    expect(await restarted.list({ ...scope, fetch: offline })).toEqual(page);
    await expect(restarted.list({ ...scope, teamId: "team-b", fetch: offline })).rejects.toThrow("network unavailable");
    await expect(restarted.list({ ...scope, apiBaseUrl: "https://api.example.test", fetch: offline })).rejects.toThrow("network unavailable");
    await expect(restarted.list({ ...scope, query: { limit: 30, afterId: "next-page" }, fetch: offline })).rejects.toThrow("network unavailable");
    let release: (value: typeof page) => void = () => { throw new Error("No pending fetch"); };
    const pending = restarted.list({ ...scope, fresh: true, fetch: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
    const duplicate = restarted.list({ ...scope, fresh: true, fetch });
    release({ items: [], nextCursor: "refreshed" });
    expect(await pending).toEqual(await duplicate);
    expect(calls).toBe(2);
    const directory = join(home, "cache", "model-starter-catalog");
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, files[0]!), "utf8"))).toEqual({ items: [], nextCursor: "refreshed" });
  } finally { await rm(home, { recursive: true, force: true }); }
});
