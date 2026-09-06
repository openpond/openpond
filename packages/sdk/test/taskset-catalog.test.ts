import { expect, it, vi } from "vitest";

import { HostedTasksetSummarySchema, OpenPondTasksetCatalogClient } from "../src/taskset-catalog.js";

const item = HostedTasksetSummarySchema.parse({
  schemaVersion: "openpond.hostedTasksetSummary.v1", id: "taskset-one", teamId: "team-one",
  release: { id: "portable-one", revision: 1, contentHash: "a".repeat(64) },
  name: "Reviewed examples", description: "A published package", taskCount: 5,
  buildIntent: "demonstrations", methodHint: "sft", packageBytes: 1024, storedBytes: 512,
  createdAt: "2026-09-06T12:00:00.000Z",
});

// A bad cache/proxy must not return another workspace's inventory or a different
// selected release, and catalog responses must remain bounded metadata reads.
it("binds catalog responses to workspace, identity and bounded pages", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ items: [item], nextCursor: item.id }))
    .mockResolvedValueOnce(Response.json(item))
    .mockResolvedValueOnce(Response.json({ ...item, teamId: "other-team" }))
    .mockResolvedValueOnce(Response.json({ items: [{ ...item, teamId: "other-team" }], nextCursor: null }))
    .mockResolvedValueOnce(Response.json({ code: "taskset_not_found", message: "Taskset is unavailable." }, { status: 404 }));
  const client = new OpenPondTasksetCatalogClient({ baseUrl: "https://api.example.test", apiKey: "test", teamId: "team-one", fetch });
  expect(await client.list({ limit: 1, modelProjectId: "model/one" })).toEqual({ items: [item], nextCursor: item.id });
  expect(fetch.mock.calls[0]![0]).toBe("https://api.example.test/v1/taskset-catalog?limit=1&modelProjectId=model%2Fone");
  expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer test", "X-OpenPond-Team-Id": "team-one" } });
  expect(await client.get(item.id)).toEqual(item);
  await expect(client.get(item.id)).rejects.toMatchObject({ code: "catalog_identity_mismatch" });
  await expect(client.list()).rejects.toMatchObject({ code: "catalog_scope_mismatch" });
  await expect(client.get(item.id)).rejects.toMatchObject({ status: 404, code: "taskset_not_found" });
  const tooLarge = new OpenPondTasksetCatalogClient({ baseUrl: "https://api.example.test", apiKey: "test", teamId: "team-one", fetch: async () => new Response(new Uint8Array(4_194_305)) });
  await expect(tooLarge.list()).rejects.toMatchObject({ code: "response_too_large" });
  expect(() => HostedTasksetSummarySchema.parse({ ...item, privateSource: "private bytes" })).toThrow();
});
