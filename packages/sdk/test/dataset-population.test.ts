import { contentHash } from "@openpond/harness";
import { describe, expect, it } from "vitest";
import { OpenPondDatasetPopulationClient } from "../src/dataset-population.js";

describe("released Dataset population boundary", () => {
  it("accepts only exact bounded policy projections and rejects Gold bytes, a changed release, or an invalid cursor", async () => {
    const release = { id: "dataset-release", revision: 1, contentHash: "a".repeat(64) };
    const page = { schemaVersion: "openpond.datasetPopulationPage.v1", teamId: "team", release, view: "policy", taskCount: 1,
      items: [{ id: "task", split: "test", input: { prompt: "Question" }, policyVisibleContext: {}, artifacts: [] }], graders: [], nextCursor: null };
    let response: unknown = { ...page, contentHash: contentHash(page) };
    const client = new OpenPondDatasetPopulationClient({ baseUrl: "https://example.test", apiKey: "test", teamId: "team", fetch: async () => Response.json(response) });
    await expect(client.read({ release, view: "policy" })).resolves.toMatchObject({ items: page.items });
    for (const invalid of [
      { ...page, items: [{ ...page.items[0], expectedOutput: { answer: "Private" } }] },
      { ...page, release: { ...release, revision: 2 } },
      { ...page, nextCursor: "another-task" },
      { ...page, items: [...page.items, ...page.items] },
    ]) {
      response = { ...invalid, contentHash: contentHash(invalid) };
      await expect(client.read({ release, view: "policy" })).rejects.toThrow();
    }
  });
});
