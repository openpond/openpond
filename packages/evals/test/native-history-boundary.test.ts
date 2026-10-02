import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listSessions, inspectSessionBranches, readSession } from "../src/native-conversations/history.js";
import { CollectorStore } from "../src/native-conversations/collector-store.js";
import { collectorBranchAnchor, selectCollectorBranch } from "../src/native-conversations/collector-branches.js";

// Claude queue records precede the cwd owner. Guessing from the first row or
// another session can resume a conversation in the wrong working directory.
it("uses matching native Claude message metadata for cwd after queue bookkeeping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-native-history-"));
  const sessionId = "a635de7e-1111-4222-8333-444444444444";
  const path = join(directory, `${sessionId}.jsonl`);
  const rows = [...Array.from({ length: 15 }, () => ({ type: "queue-operation", sessionId })), { type: "user", sessionId: "foreign", cwd: "/wrong" }, { type: "user", sessionId, cwd: directory, message: { content: "fixture" } }];
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  try {
    const source = { source: "claude_code" as const, root: directory, machineId: "machine", instanceId: "instance", acquisition: "files" as const, available: true, capabilities: { history: true, live: true, nativeResume: false } };
    const result = await listSessions(source);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ nativeSessionId: sessionId, cwd: directory });
    await writeFile(path, rows.slice(0, -1).map((row) => JSON.stringify(row)).join("\n") + "\n");
    expect((await listSessions(source)).items[0]?.cwd).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("takes Grok cwd only from the selected native session's retained summary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grok-native-history-"));
  const sessionId = "native-grok-fixture";
  const nativeRoot = join(directory, "sessions", "encoded", sessionId);
  await mkdir(nativeRoot, { recursive: true });
  await writeFile(join(nativeRoot, "updates.jsonl"), JSON.stringify({ method: "session/update", params: { sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "fixture" } } } }) + "\n");
  const summary = join(nativeRoot, "summary.json");
  const source = { source: "grok_build" as const, root: directory, machineId: "machine", instanceId: "instance", acquisition: "files" as const, available: true, capabilities: { history: true, live: true, nativeResume: false } };
  try {
    await writeFile(summary, JSON.stringify({ info: { id: sessionId, cwd: directory }, generated_title: "Fixture" }));
    expect((await listSessions(source)).items[0]).toMatchObject({ nativeSessionId: sessionId, cwd: directory, title: "Fixture" });
    await writeFile(summary, JSON.stringify({ info: { id: "foreign", cwd: "/wrong" } }));
    expect((await listSessions(source)).items[0]?.cwd).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// A repair must never smuggle sibling rows into upload, follow a new fork by
// guesswork, or reuse an earlier queued selection after consent changes.
it("fences explicit Claude branch authority through snapshot, pause, queue reset and live follow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-branch-authority-"));
  const sessionId = "a635de7e-1111-4222-8333-444444444444";
  const path = join(directory, `${sessionId}.jsonl`);
  const root = { type: "user", uuid: "root", sessionId, cwd: directory, parentUuid: null, timestamp: "2026-10-02T00:00:00Z", message: { content: "Shared input" } };
  const reply = (uuid: string, parentUuid: string, text: string) => ({ type: "assistant", uuid, sessionId, parentUuid, timestamp: "2026-10-02T00:00:01Z", message: { content: [{ type: "text", text }], stop_reason: "end_turn" } });
  const rows = [root, reply("alpha", "root", "ONLY_ALPHA"), reply("beta", "root", "ONLY_BETA")];
  const write = () => writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const source = { source: "claude_code" as const, root: path, machineId: "machine", instanceId: "instance", acquisition: "files" as const, available: true, capabilities: { history: true, live: true, nativeResume: false } };
  const collector = join(directory, "collector");
  try {
    await write();
    const native = (await listSessions(source)).items[0]!;
    const inspection = await inspectSessionBranches(source, native);
    expect(inspection.branches.map(branch => branch.leafId)).toEqual(["alpha", "beta"]);
    await expect(readSession(source, native)).rejects.toThrow("multiple branches");
    await expect(readSession(source, { ...native, nativeSessionId: "foreign" }, { branchLeafId: "alpha" })).rejects.toThrow("changed identity");
    const choice = { leafId: "alpha", revision: inspection.revision };
    const selected = await readSession(source, native, { branchLeafId: choice.leafId, expectedBranchRevision: choice.revision });
    expect(JSON.stringify(selected.files)).toContain("ONLY_ALPHA");
    expect(JSON.stringify(selected.files)).not.toContain("ONLY_BETA");
    const store = await CollectorStore.open(collector);
    const connection = { id: "connection", teamId: "team", apiBaseUrl: "https://fixture.invalid", source, projectId: "project", revision: 1, since: null, keepSyncing: true, state: "active" as const };
    store.put(connection);
    store.enqueue({ operationId: "old-selection", connectionId: connection.id, sessionKey: sessionId, contentHash: "old", files: [{ path: "old.jsonl", text: "sibling" }], boundaryIds: ["old"] }, [{ id: "old", revision: "old" }]);
    store.close();
    await expect(selectCollectorBranch(collector, connection.id, sessionId, choice)).rejects.toThrow("Pause");
    const pausedStore = await CollectorStore.open(collector);
    pausedStore.put({ ...connection, revision: 2, state: "paused" }); pausedStore.close();
    await selectCollectorBranch(collector, connection.id, sessionId, choice);
    const repaired = await CollectorStore.open(collector);
    const anchor = collectorBranchAnchor(repaired, connection.id, sessionId)!;
    expect(repaired.queued(connection.id)).toBe(0);
    expect(repaired.connections()[0]?.state).toBe("paused");
    repaired.close();
    rows.push(reply("alpha-next", "alpha", "ALPHA_CONTINUED")); await write();
    await expect(readSession(source, native, { branchLeafId: choice.leafId, expectedBranchRevision: choice.revision })).rejects.toThrow("changed");
    const followed = await readSession(source, native, { branchAnchor: anchor });
    expect(followed.branchLeafId).toBe("alpha-next");
    expect(JSON.stringify(followed.files)).not.toContain("ONLY_BETA");
    rows.push(reply("alpha-fork", "alpha", "DO_NOT_CHOOSE")); await write();
    await expect(readSession(source, native, { branchAnchor: anchor })).rejects.toThrow("diverged");
    root.message.content = "REWRITTEN_AUTHORITY"; await write();
    await expect(readSession(source, native, { branchAnchor: anchor })).rejects.toThrow("history changed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
