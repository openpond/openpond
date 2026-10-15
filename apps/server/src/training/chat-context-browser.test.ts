import { expect, test, vi } from "vitest";
import type { SqliteStore } from "../store/store.js";
import { createChatContextBrowser } from "./chat-context-browser.js";

// A selection carries identity into a new chat; its saved display snapshot must
// never become status authority or bypass the account that owns the job.
test("retains an exact training target and reauthorizes it for fresh status reads", async () => {
  const access = { apiBaseUrl: "https://api.example.test", token: "test", teamId: "team", actorId: "actor" };
  let state = "running";
  let metadata: Record<string, unknown> = {};
  const request = vi.fn(async () => new Response(JSON.stringify({ job: {
    schemaVersion: "openpond.trainingJob.v2", id: "job", teamId: "team", kind: "policy_optimize",
    modelProjectId: "model", portableProjectId: "portable", sourceProjectRevision: 1, submissionHash: "a".repeat(64),
    state, phase: state === "running" ? "training" : "completed", version: 1, progress: state === "running" ? 0.5 : 1,
    rolloutProgress: { groupsCompleted: 1, groupsTarget: 1, optimizerUpdatesApplied: 1, optimizerUpdatesSkipped: 0 },
    accruedSpendUsd: 1, terminalReason: null, createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T01:00:00.000Z", completedAt: null,
  } })));
  vi.stubGlobal("fetch", request);
  try {
    const store = { getSession: async () => ({ id: "chat", metadata }), updateSession: async (_id: string, update: (value: unknown) => { metadata: Record<string, unknown> }) => {
      const result = update({ id: "chat", metadata }); metadata = result.metadata; return result;
    } } as unknown as SqliteStore;
    const browser = createChatContextBrowser({ store, access: async () => access, resources: async () => [], selectResource: async () => {} });
    const target = { kind: "training", id: "job", location: "cloud", teamId: "team", apiOrigin: access.apiBaseUrl };
    const selected = await browser.select(target, "chat");
    expect(selected?.training).toMatchObject({ jobId: "job", job: { state: "running" } });
    expect(metadata).toEqual({ chatContextSelection: target });
    state = "succeeded";
    expect((await browser.resolve(metadata.chatContextSelection)).training).toMatchObject({ job: { state: "succeeded" } });
    const calls = request.mock.calls.length;
    await expect(browser.resolve({ ...target, teamId: "different" })).rejects.toThrow("account");
    expect(request).toHaveBeenCalledTimes(calls);
    expect(metadata).toEqual({ chatContextSelection: target });
  } finally { vi.unstubAllGlobals(); }
});
