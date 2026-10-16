import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listSessions, inspectSessionBranches, readSession } from "../src/native-conversations/history.js";
import { CollectorStore } from "../src/native-conversations/collector-store.js";
import { collectorBranchAnchor, selectCollectorBranch } from "../src/native-conversations/collector-branches.js";
import { discoverSources } from "../src/native-conversations/discovery.js";

// A default-path fallback can upload a different account/profile's history.
// Discovery must preserve explicit authority and surface ambiguous choices.
it("keeps profile discovery and explicit source authority separate", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-source-authority-"));
  const hermes = join(home, ".hermes");
  const omp = join(home, ".omp");
  const selected = join(home, "selected-history");
  const inventory = async (source: "hermes" | "oh_my_pi", environment = {}, locations = {}) =>
    (await discoverSources({ machineId: "machine", home, environment, locations })).filter((item) => item.source === source);
  try {
    for (const name of ["work", "personal", "deleted"]) {
      await mkdir(join(hermes, "profiles", name), { recursive: true });
      await writeFile(join(hermes, "profiles", name, "state.db"), "");
      await mkdir(join(omp, "profiles", name, "agent", "sessions"), { recursive: true });
    }
    await mkdir(join(hermes, "profiles", ".deleted"));
    await writeFile(join(hermes, "profiles", ".deleted", "deleted"), "deleted");
    await writeFile(join(hermes, "active_profile"), "work");
    const choices = await inventory("hermes");
    expect(choices.map((item) => item.root)).toEqual([join(hermes, "profiles", "work"), join(hermes, "profiles", "personal")]);
    expect(new Set(choices.map((item) => item.instanceId)).size).toBe(2);
    expect((await inventory("hermes", { HERMES_HOME: choices[1]!.root })).map((item) => item.root)).toEqual([choices[1]!.root]);
    await writeFile(join(hermes, "active_profile"), "missing");
    expect((await inventory("hermes"))[0]).toMatchObject({ available: false, capabilities: { history: false } });

    await mkdir(selected);
    const pinned = (await inventory("hermes", {}, { hermes: selected }))[0]!;
    expect(pinned.root).toBe(selected);
    expect((await inventory("hermes", { HERMES_HOME: "/absent/other-home" }, { hermes: selected }))[0]!.instanceId).toBe(pinned.instanceId);

    const named = await inventory("oh_my_pi", { OMP_PROFILE: "work", PI_PROFILE: "personal", PI_CODING_AGENT_DIR: selected });
    expect(named.map((item) => item.root)).toEqual([join(omp, "profiles", "work", "agent")]);
    expect((await inventory("oh_my_pi", { OMP_PROFILE: "", PI_PROFILE: "work", PI_CODING_AGENT_DIR: selected }))[0]!.root).toBe(selected);
    expect((await inventory("oh_my_pi", { OMP_PROFILE: "../outside" }))[0]!.available).toBe(false);
    expect((await inventory("oh_my_pi", { OMP_PROFILE: "../outside" }, { oh_my_pi: selected }))[0]!.root).toBe(selected);
    const missing = (await inventory("oh_my_pi", {}, { oh_my_pi: join(home, "missing") }))[0]!;
    expect(missing.available).toBe(false);
    expect(missing.root).toBe(join(home, "missing"));
  } finally { await rm(home, { recursive: true, force: true }); }
});

// Claude queue records precede user/title metadata. Another session's records
// must not supply identity or title, and tail-appended names must remain visible.
it("uses owned Claude identity, cwd and titles after bookkeeping and late title records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-native-history-"));
  const sessionId = "a635de7e-1111-4222-8333-444444444444";
  const path = join(directory, `${sessionId}.jsonl`);
  const rows = [...Array.from({ length: 15 }, () => ({ type: "queue-operation", sessionId })), { type: "user", sessionId: "foreign", cwd: "/wrong" }, { type: "user", sessionId, cwd: directory, message: { content: "fixture" } }];
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  try {
    const source = { source: "claude_code" as const, root: directory, machineId: "machine", instanceId: "instance", acquisition: "files" as const, available: true, capabilities: { history: true, live: true, nativeResume: false } };
    const result = await listSessions(source);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ nativeSessionId: sessionId, cwd: directory, title: "fixture" });
    await writeFile(path, [...rows,
      { type: "assistant", sessionId, message: { content: "x".repeat(600_000) } },
      { type: "summary", summary: "Provider summary" },
      { type: "custom-title", sessionId, customTitle: "Named by the user" },
      { type: "custom-title", sessionId: "foreign", customTitle: "Wrong account's name" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    expect((await listSessions(source)).items[0]).toMatchObject({ nativeSessionId: sessionId, cwd: directory, title: "Named by the user" });
    await writeFile(path, rows.slice(0, -1).map((row) => JSON.stringify(row)).join("\n") + "\n");
    expect((await listSessions(source)).items[0]).toMatchObject({ nativeSessionId: sessionId, cwd: null, title: sessionId });
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

// Opening a desktop chat must follow Claude's main chain even after a retry,
// trailing bookkeeping or a newer sidechain. Import consent stays explicit.
it("opens the latest Claude conversation chain without granting import branch authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-latest-history-"));
  const sessionId = "a635de7e-1111-4222-8333-444444444444";
  const path = join(directory, `${sessionId}.jsonl`);
  const message = (uuid: string, parentUuid: string | null, type: string, text: string, extra = {}) => ({
    uuid, parentUuid, type, sessionId, cwd: directory, timestamp: "2026-10-02T00:00:01Z",
    message: { content: text, ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) }, ...extra,
  });
  const rows = [message("root", null, "user", "Shared input"),
    message("old", "root", "assistant", "OLD_BRANCH", { timestamp: "2099-01-01T00:00:00Z" }),
    message("current", "root", "assistant", "CURRENT_BRANCH"),
    { uuid: "attachment", parentUuid: "current", type: "attachment", sessionId },
    message("side", "root", "assistant", "SIDECHAIN", { isSidechain: true }),
    message("team", "root", "assistant", "TEAM", { teamName: "worker" }),
    message("meta", "root", "user", "META", { isMeta: true }),
    { uuid: "metadata", type: "custom-title", sessionId, customTitle: "Title" },
  ];
  const write = () => writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const source = { source: "claude_code" as const, root: path, machineId: "machine", instanceId: "instance", acquisition: "files" as const, available: true, capabilities: { history: true, live: true, nativeResume: false } };
  try {
    await write();
    const native = (await listSessions(source)).items[0]!;
    const opened = await readSession(source, native, { latestBranch: true });
    expect(opened.preview.issues).toEqual([]);
    expect(opened.preview.sessions[0]?.sessionId).toBe(sessionId);
    expect(opened.preview.sessions[0]?.events.filter(event => event.kind === "message").map(event => event.id)).toEqual(["root", "current"]);
    expect(opened.files[0]!.text).not.toMatch(/OLD_BRANCH|SIDECHAIN|TEAM|META/);
    await expect(readSession(source, native)).rejects.toThrow("multiple branches");
    await expect(readSession(source, { ...native, nativeSessionId: "foreign" }, { latestBranch: true })).rejects.toThrow("changed identity");
    await expect(readSession(source, native, { latestBranch: true, branchLeafId: "old" })).rejects.toThrow("either");
    rows.push(message("continued", "attachment", "user", "Continue here"));
    await write();
    const followed = await readSession(source, native, { latestBranch: true });
    expect(followed.preview.sessions[0]?.events.filter(event => event.kind === "message").map(event => event.id)).toEqual(["root", "current", "continued"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Child files use a distinct agent filename while each event retains the parent
// sessionId. Inspection must acquire only that file and preserve both identities.
it("acquires a Claude internal worker without substituting the parent transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-worker-history-"));
  const childDir = join(directory, "projects", "fixture", "parent-native", "subagents");
  await mkdir(childDir, { recursive: true });
  const rows = [
    { uuid: "u", parentUuid: null, type: "user", message: { content: "Child task" } },
    { uuid: "a", parentUuid: "u", type: "assistant", message: { content: [{ type: "text", text: "Child result" }], stop_reason: "end_turn" } },
  ].map((row, index) => ({ ...row, sessionId: "parent-native", agentId: "worker", isSidechain: true, cwd: directory, timestamp: new Date(1000 + index * 1000).toISOString() }));
  await writeFile(join(childDir, "agent-worker.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const source = { source: "claude_code" as const, root: directory, machineId: "machine", instanceId: "instance", acquisition: "files" as const, available: true, capabilities: { history: true, live: true, nativeResume: true } };
  try {
    const child = (await listSessions(source)).items[0]!;
    expect(child).toMatchObject({ nativeSessionId: "agent-worker", parentNativeSessionId: "parent-native", cwd: directory, title: "Child task" });
    const retained = await readSession(source, child, { latestBranch: true });
    expect(retained.preview.sessions[0]?.events.some(event => JSON.stringify(event.content).includes("Child result"))).toBe(true);
    // A selected child replaced by its sibling/parent still shares sessionId.
    await writeFile(join(childDir, "agent-worker.jsonl"), rows.map(row => JSON.stringify({ ...row, agentId: "sibling" })).join("\n") + "\n");
    await expect(readSession(source, child, { latestBranch: true })).rejects.toThrow("Native worker changed identity");
    await expect(inspectSessionBranches(source, child)).rejects.toThrow("Native worker changed identity");
    await writeFile(join(childDir, "agent-worker.jsonl"), rows.map(row => JSON.stringify({ ...row, isSidechain: false })).join("\n") + "\n");
    await expect(readSession(source, child, { latestBranch: true })).rejects.toThrow("Native worker changed identity");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
