import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CollectorStore, collectorMachineId, type CollectorConnection } from "@openpond/evals/native-conversations";
import { retainedReconnect, assertReconnectSource, assertReconnectUnchanged } from "../apps/cli/src/importer/reconnect";
import { previewAgentImport } from "@openpond/evals/connected-evidence";
import { refreshRetainedAdmission } from "../apps/cli/src/importer/retained-admission";

// Reauthorization must not replace an old profile/cutoff with today's discovery
// defaults, or revive a scope changed while its browser approval was open.
it("retains reconnect scope and rejects changed machine, source and concurrent controls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "importer-reconnect-"));
  const machineId = await collectorMachineId(directory);
  const store = await CollectorStore.open(directory);
  const connection: CollectorConnection = {
    id: "retained", teamId: "team", apiBaseUrl: "https://staging-api.openpond.ai",
    accountBaseUrl: "https://staging.openpond.ai", projectId: "original-project", revision: 7,
    since: "2026-09-26T12:00:00.000Z", keepSyncing: false, state: "disconnected",
    source: { source: "pi", machineId, instanceId: "original-profile", root: join(directory, "selected-profile"), acquisition: "files", available: true, capabilities: { history: true, live: true, nativeResume: false } },
  };
  try {
    store.put(connection);
    // A newer projection must drain unchanged queued bytes while keeping the
    // original completed turn, source authority and retry identity.
    const files = [{ path: "rollout.jsonl", text: [
      { type: "session_meta", payload: { id: "queued-session" } },
      { type: "response_item", timestamp: "2026-10-01T00:00:00Z", payload: { type: "message", role: "user", content: "Selected request" } },
      { type: "response_item", timestamp: "2026-10-01T00:00:01Z", payload: { type: "message", role: "assistant", content: "Retained answer" } },
      { type: "event_msg", timestamp: "2026-10-01T00:00:02Z", payload: { type: "task_complete" } },
      { type: "response_item", timestamp: "2026-10-01T00:00:03Z", payload: { type: "message", role: "user", content: "Pending sibling" } },
    ].map(row => JSON.stringify(row)).join("\n") }];
    const codex = { ...connection, source: { ...connection.source, source: "codex" as const } };
    const normalized = previewAgentImport({ source: "codex", files, acquisition: { machineId, sourceInstanceId: connection.source.instanceId } });
    const session = normalized.sessions[0]!;
    const boundary = session.boundaries.find(item => item.projection === "turn" && item.terminal === "completed")!;
    const entry = { operationId: "retained-admission", connectionId: connection.id, sessionKey: JSON.stringify([connection.source.instanceId, session.sessionId, session.branchId]),
      contentHash: "0".repeat(64), files, boundaryIds: [boundary.id] };
    const refreshed = refreshRetainedAdmission(codex, entry, normalized);
    expect(refreshed).toEqual({ ...entry, contentHash: session.contentHash, operationId: expect.any(String) });
    expect(refreshed.operationId).not.toBe(entry.operationId);
    expect(refreshRetainedAdmission(codex, entry, normalized)).toEqual(refreshed);
    expect(refreshRetainedAdmission(codex, refreshed, normalized)).toEqual(refreshed);
    expect(() => refreshRetainedAdmission({ ...codex, id: "foreign" }, entry, normalized)).toThrow(/connection/);
    expect(() => refreshRetainedAdmission({ ...codex, source: { ...codex.source, instanceId: "foreign" } }, entry, normalized)).toThrow(/boundaries/);
    const pending = session.boundaries.find(item => item.projection === "turn" && item.terminal === "unknown")!;
    expect(() => refreshRetainedAdmission(codex, { ...entry, boundaryIds: [pending.id] }, normalized)).toThrow(/boundaries/);
    expect(() => refreshRetainedAdmission({ ...codex, since: "2026-10-02T00:00:00Z" }, entry, normalized)).toThrow(/boundaries/);
    const retained = await retainedReconnect(directory, connection.id);
    expect(retained).toEqual(connection);
    expect(() => assertReconnectSource(retained, retained.source)).not.toThrow();
    expect(() => assertReconnectSource(retained, { ...retained.source, root: join(directory, "another-profile") })).toThrow(/identity changed/);
    store.put({ ...connection, destinations: { taskDatasetId: "acknowledged-dataset", conversationDatasetId: null } });
    await assertReconnectUnchanged(directory, retained);
    store.put({ ...connection, revision: 8, since: null });
    await expect(assertReconnectUnchanged(directory, retained)).rejects.toThrow(/changed during sign-in/);
    store.put({ ...connection, revision: 9, source: { ...connection.source, machineId: "another-machine" } });
    await expect(retainedReconnect(directory, connection.id)).rejects.toThrow(/another machine/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
