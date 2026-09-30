import { describe, expect, it } from "vitest";
import { OpenPondExperimentHistoryClient } from "../src/experiment-history.js";

describe("compact Experiment history boundary", () => {
  // A history page must not leak case/private bytes, cross workspace rows, or
  // silently substitute a target or invalid continuation for its stored run.
  it("accepts exact retained identities and rejects private fields, foreign rows, target mismatch and invalid pages", async () => {
    const hash = "a".repeat(64), now = "2026-09-30T12:00:00.000Z";
    const item = { definition: { id: "exp-a", revision: 1, contentHash: hash }, policy: { kind: "fixture" }, summary: {
      schemaVersion: "openpond.modelTasksetRunSummary.v1", id: "run-a", revision: 1, teamId: "team-a", modelProjectId: null, operationId: "operation-a", taskset: { id: "dataset-a", revision: 1, contentHash: hash }, policyKind: "fixture", manifestHash: hash,
      status: "completed", totalCount: 1, counts: { pending: 0, running: 0, completed: 1, failed: 0, cancelled: 0 }, createdAt: now, startedAt: now, completedAt: now, cleanupComplete: true, resultAvailable: true, score: 1, metricName: "score", error: null,
    } };
    let value: unknown = { items: [item], nextCursor: null };
    const client = new OpenPondExperimentHistoryClient({ baseUrl: "https://example.test", apiKey: "test", teamId: "team-a", fetch: async () => Response.json(value) });
    await expect(client.list()).resolves.toMatchObject({ items: [item] });
    for (const page of [
      { items: [{ ...item, expectedOutput: { answer: "private" } }], nextCursor: null },
      { items: [{ ...item, summary: { ...item.summary, teamId: "team-b" } }], nextCursor: null },
      { items: [{ ...item, summary: { ...item.summary, policyKind: "hosted_chat" } }], nextCursor: null },
      { items: [item, item], nextCursor: null },
      { items: [item], nextCursor: "other-run" },
    ]) { value = page; await expect(client.list()).rejects.toThrow(); }
    value = { items: [item], nextCursor: null };
    await expect(client.list({ status: "failed" })).rejects.toThrow();
    await expect(client.list({ tasksetHash: "b".repeat(64) })).rejects.toThrow();
  });
});
