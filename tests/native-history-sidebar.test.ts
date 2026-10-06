import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { RuntimeEventSchema, SessionSchema, type RuntimeEvent, type Session } from "@openpond/contracts";
import type { NativeSession, NativeSource } from "@openpond/evals/native-conversations";
import { SqliteStore } from "../apps/server/src/store/store.js";
import { createNativeHistory } from "../apps/server/src/runtime/native-agents/history.js";
import { nativeAgentLaunch } from "../apps/server/src/runtime/native-agents/config.js";
import { createNativeCapabilityProbe } from "../apps/server/src/runtime/native-agents/capability-probes.js";
import { previewAgentImport } from "@openpond/evals/connected-evidence";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages.js";

const acquisition = vi.hoisted(() => ({
  discover: vi.fn(), list: vi.fn(), read: vi.fn(), sourceHome: "/fixture-account",
}));
vi.mock("@openpond/evals/native-conversations", async (original) => ({
  ...await original<object>(),
  discoverSources: acquisition.discover, listSessions: acquisition.list, readSession: acquisition.read,
  collectorDirectory: () => "/unused-test-collector", collectorMachineId: async () => "machine",
  collectorStatus: async () => ({ connections: [] }),
}));
vi.mock("../apps/server/src/openpond/provider-settings.js", () => ({
  readProvidersFile: async () => ({ providers: { opencode: { enabled: true, sourceHome: acquisition.sourceHome } } }),
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); acquisition.sourceHome = "/fixture-account"; });

// Failure story: retained Claude/OpenCode tool wrappers appear as an answer or
// lose their arguments/results, while a legitimate JSON/bracket answer is altered.
test("native source import renders retained text and tool activity without rewriting evidence", async () => {
  const f = await fixture();
  const answer = "The result is [1, 2].";
  const rows = [
    { uuid: "u", parentUuid: null, type: "user", message: { content: "Inspect the result" } },
    { uuid: "c", parentUuid: "u", type: "assistant", message: { content: [{ type: "tool_use", id: "call", name: "Bash", input: { command: "printf result" } }] } },
    { uuid: "r", parentUuid: "c", type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call", content: [{ type: "text", text: "[1, 2]" }] }] } },
    { uuid: "a", parentUuid: "r", type: "assistant", message: { content: [{ type: "text", text: answer }], stop_reason: "end_turn" } },
  ].map((row, index) => ({ ...row, sessionId: "vendor-id", timestamp: new Date(1000 + index * 1000).toISOString() }));
  const opencode = { info: { id: "vendor-id" }, messages: [
    { info: { id: "u", sessionID: "vendor-id", role: "user", time: { created: 1000 } }, parts: [{ id: "p-u", sessionID: "vendor-id", messageID: "u", type: "text", text: "Inspect the result" }] },
    { info: { id: "a", sessionID: "vendor-id", role: "assistant", parentID: "u", time: { created: 2000, completed: 3000 }, finish: "stop" }, parts: [
      { id: "p-tool", sessionID: "vendor-id", messageID: "a", type: "tool", callID: "call", tool: "bash", state: { input: { command: "printf result" }, output: "[1, 2]", status: "completed" } },
      { id: "p-a", sessionID: "vendor-id", messageID: "a", type: "text", text: answer },
    ] },
  ] };
  const examples = [
    { origin: "claude_code" as const, transcript: rows.map(row => JSON.stringify(row)).join("\n") },
    { origin: "opencode" as const, transcript: JSON.stringify(opencode) },
  ];
  for (const { origin, transcript } of examples) {
    const preview = previewAgentImport({ source: origin, files: [{ path: origin === "claude_code" ? "history.jsonl" : "history.json", text: transcript }] });
    expect(preview.issues).toEqual([]);
    const original = JSON.stringify(preview);
    const selectedSource = { ...source(`${origin}-instance`, false), source: origin };
    acquisition.discover.mockResolvedValue([selectedSource]);
    acquisition.list.mockResolvedValue({ items: [native(selectedSource.instanceId)], nextCursor: null });
    acquisition.read.mockResolvedValue({ preview });
    const handle = f.api(); await handle("list");
    const opened = await handle("open", { id: selectionId(selectedSource.instanceId) }) as Session;
    await f.reopen();
    const events = await f.store.runtimeEventsForSession(opened.id);
    const messages = buildChatMessages(events);
    expect(messages.filter(message => message.role === "assistant").map(message => message.content)).toEqual([answer]);
    expect(messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["Inspect the result"]);
    const activity = messages.flatMap(message => message.activities ?? []);
    expect(activity.some(item => item.content === "printf result")).toBe(true);
    expect(JSON.stringify(activity)).toContain("[1, 2]");
    expect(JSON.stringify(preview)).toBe(original);
    expect(events.filter(event => event.name.startsWith("tool.")).every(event => event.action === "native_tool")).toBe(true);
  }
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "native-sidebar-"));
  let store = new SqliteStore(home);
  cleanup.push(async () => { await store.close(); await rm(home, { recursive: true, force: true }); });
  const events: RuntimeEvent[] = [];
  const api = (canResume?: Parameters<typeof createNativeHistory>[0]["canResume"]) => createNativeHistory({ store, storeDir: home, canResume, appendRuntimeEvent: async (value) => {
    const event = RuntimeEventSchema.parse(value); events.push(event); await store.appendRuntimeEvent(event);
  } });
  return { home, get store() { return store; }, events, api,
    async reopen() { await store.close(); store = new SqliteStore(home); } };
}

// Failure story: model discovery's native session/new leaves a persisted empty
// session, then a refresh/restart presents it as a user chat. Only explicitly
// recorded probe identities may be excluded; legitimate empty chats must survive.
test("excludes exact capability probes after reload while retaining real empty chats", async () => {
  const f = await fixture();
  acquisition.sourceHome = f.home;
  const nativeSource = { ...source("probe-account", false), root: f.home };
  const probe = native(nativeSource.instanceId, "known-probe");
  const realEmpty = native(nativeSource.instanceId, "real-empty");
  const sameTitle = native(nativeSource.instanceId, "same-title-real-chat");
  acquisition.discover.mockResolvedValue([nativeSource]);
  acquisition.list.mockResolvedValue({ items: [probe, realEmpty, sameTitle], nextCursor: null });
  acquisition.read.mockImplementation(async (value: NativeSource, session: NativeSession) => historyRead(value, session));
  const beforeRegistration = f.api();
  await beforeRegistration("list", { retain: true });
  await Promise.all([
    createNativeCapabilityProbe("opencode", f.home, async () => ({ sessionId: probe.nativeSessionId })),
    createNativeCapabilityProbe("claude-code", f.home, async () => ({ sessionId: realEmpty.nativeSessionId })),
  ]);
  await expect(beforeRegistration("open", { id: selectionId(nativeSource.instanceId, probe.nativeSessionId) })).rejects.toThrow("Capability discovery sessions");
  const verify = async () => {
    const handle = f.api();
    const list = await handle("list", { retain: true }) as { items: Array<{ nativeSessionId: string }> };
    expect(list.items.map((item) => item.nativeSessionId)).toEqual([realEmpty.nativeSessionId, sameTitle.nativeSessionId]);
    expect((await f.store.sessionShells()).filter((session) => !session.archived).map((session) => session.id).sort()).toEqual([
      `native-${selectionId(nativeSource.instanceId, realEmpty.nativeSessionId)}`,
      `native-${selectionId(nativeSource.instanceId, sameTitle.nativeSessionId)}`,
    ].sort());
    expect(await f.store.getSession(`native-${selectionId(nativeSource.instanceId, probe.nativeSessionId)}`)).toMatchObject({ archived: true });
    await expect(handle("open", { id: selectionId(nativeSource.instanceId, probe.nativeSessionId) })).rejects.toThrow("selection expired");
    expect(await handle("open", { id: selectionId(nativeSource.instanceId, realEmpty.nativeSessionId) })).toMatchObject({ nativeAgent: null, metadata: { nativeHistoryLoaded: true } });
  };
  await verify();
  await f.reopen();
  await verify();
});

const source = (instanceId: string, nativeResume = true): NativeSource => ({ source: "opencode", machineId: "machine", instanceId,
  root: "/fixture-account", acquisition: "sqlite", available: true, capabilities: { history: true, live: true, nativeResume } });
const native = (instanceId: string, nativeSessionId = "vendor-id"): NativeSession => ({ nativeSessionId,
  sourceInstanceId: instanceId, path: "/fixture-account/history", title: "Original source title", cwd: "/workspace",
  updatedAt: "2026-10-05T01:00:00Z" });
const selectionId = (instanceId: string, id = "vendor-id") => createHash("sha256").update(JSON.stringify([instanceId, id])).digest("hex");
function historyRead(_source: NativeSource, session: NativeSession) {
  return { preview: { sessions: [{ sessionId: session.nativeSessionId, contentHash: "snapshot", events: [], boundaries: [] }] } };
}

// Failure story: inventory refresh and clicking the same history race into duplicate
// sessions or overwrite pins/project/profile state; another account's equal vendor ID
// is incorrectly granted that managed session's continuation authority.
test("concurrent inventory/open retains one managed identity and isolates equal native IDs by source", async () => {
  const f = await fixture();
  const first = source("account-one"), second = source("account-two", false);
  acquisition.discover.mockResolvedValue([first, second]);
  acquisition.list.mockImplementation(async (value: NativeSource) => ({ items: [native(value.instanceId)], nextCursor: null }));
  acquisition.read.mockImplementation(async (value: NativeSource, session: NativeSession) => historyRead(value, session));
  const managed = SessionSchema.parse({ id: "managed-original", experience: "work", provider: "opencode", title: "User renamed title",
    appId: null, appName: null, localProjectId: "real-project", cwd: "/workspace", codexThreadId: null,
    nativeAgent: { provider: "opencode", instanceId: nativeAgentLaunch("opencode", { sourceHome: "/fixture-account" }).instanceId, sessionId: "vendor-id", cwd: "/workspace" },
    createdAt: "2026-10-04T01:00:00Z", updatedAt: "2026-10-04T01:00:00Z", status: "idle", pinned: true, archived: true, order: 0,
    metadata: { sourceInstanceId: first.instanceId, profileRef: { slug: "keep-profile" }, composerDraft: "Keep this draft" } });
  await f.store.insertSessionAtFront(managed);
  const handle = f.api();
  const [, opened] = await Promise.all([handle("list", { retain: true }), handle("open", { id: selectionId(first.instanceId) }), handle("list", { retain: true })]);
  expect(opened).toMatchObject({ id: managed.id, title: managed.title, pinned: true, archived: true, localProjectId: "real-project",
    metadata: { composerDraft: "Keep this draft", profileRef: { slug: "keep-profile" } } });
  const shells = await f.store.sessionShells();
  expect(shells).toHaveLength(2);
  const other = shells.find((session) => session.id !== managed.id)!;
  expect(other).toMatchObject({ id: `native-${selectionId(second.instanceId)}`, nativeAgent: null, metadata: { nativeHistoryLoaded: false, nativeResumeAvailable: false } });
  const readOnly = await handle("open", { id: selectionId(second.instanceId) }) as Session;
  expect(readOnly).toMatchObject({ id: other.id, nativeAgent: null, metadata: { nativeHistoryLoaded: true, nativeResumeAvailable: false } });
  expect(readOnly.metadata?.nativeReadOnlyReason).toBeTruthy();
  expect(f.events.some((event) => event.name === "session.updated")).toBe(true);
  await f.reopen();
  expect(await f.store.getSession(managed.id)).toMatchObject({ pinned: true, archived: true, title: managed.title });
  expect(await f.store.getSession(other.id)).toMatchObject({ nativeAgent: null });
});

// Failure story: after restart a retained later-page row disappears from the open
// lookup, or a metadata refresh advances inbox ordering without real activity.
test("restart resolves retained later-page history and persists only meaningful activity", async () => {
  const f = await fixture();
  const selectedSource = source("paged-account");
  const old = native(selectedSource.instanceId, "old-session");
  acquisition.discover.mockResolvedValue([selectedSource]);
  acquisition.list.mockImplementation(async (_source: NativeSource, options: { cursor?: string }) => options.cursor
    ? { items: [old], nextCursor: null }
    : { items: [native(selectedSource.instanceId, "new-session")], nextCursor: "older" });
  acquisition.read.mockImplementation(async (value: NativeSource, session: NativeSession) => historyRead(value, session));
  const initial = f.api();
  await initial("list", { cursors: { [selectedSource.instanceId]: "older" }, retain: true });
  const id = `native-${selectionId(selectedSource.instanceId, old.nativeSessionId)}`;
  await f.store.appendRuntimeEvent({ id: "meaningful", name: "turn.completed", sessionId: id, timestamp: "2026-10-05T04:00:00Z" });
  await f.store.appendRuntimeEvent({ id: "metadata-only", name: "session.updated", sessionId: id, timestamp: "2026-10-05T05:00:00Z", data: { session: await f.store.getSession(id) } });
  await f.store.appendRuntimeEvent({ id: "late-old-event", name: "turn.started", sessionId: id, timestamp: "2026-10-05T02:00:00Z" });
  await f.reopen();
  expect((await f.store.getSession(id))?.metadata?.sidebarActivityAt).toBe("2026-10-05T04:00:00Z");
  acquisition.list.mockClear();
  const opened = await f.api()("open", { id: selectionId(selectedSource.instanceId, old.nativeSessionId) }) as Session;
  expect(opened).toMatchObject({ id, nativeAgent: { sessionId: old.nativeSessionId, cwd: old.cwd }, metadata: { nativeHistoryLoaded: true } });
  expect(acquisition.list.mock.calls.map(([, options]) => options.cursor)).toEqual([undefined, "older"]);
  expect((await f.store.getSession(id))?.metadata?.sidebarActivityAt).toBe("2026-10-05T04:00:00Z");
  // A generated provider title may change without newer activity. It should
  // refresh the retained row without changing ordering or a user's own rename.
  old.title = "Provider generated a title";
  await f.api()("list", { cursors: { [selectedSource.instanceId]: "older" }, retain: true });
  expect(await f.store.getSession(id)).toMatchObject({ title: old.title, metadata: { sidebarActivityAt: "2026-10-05T04:00:00Z" } });
  await f.store.updateSession(id, (session) => ({ ...session, title: "My own title" }));
  old.title = "Provider renamed it again";
  await f.api()("list", { cursors: { [selectedSource.instanceId]: "older" }, retain: true });
  await f.reopen();
  expect(await f.store.getSession(id)).toMatchObject({ title: "My own title", metadata: { nativeSourceTitle: old.title, sidebarActivityAt: "2026-10-05T04:00:00Z" } });
});

// Failure story: acquisition-only capability flags hide an enabled adapter's
// original-session continuation, or qualification grants authority to a branch
// snapshot/unverified source ID. Discovery must never probe or create authority.
test("explicit open qualifies an acquisition-only history after native identity validation and preserves read-only branches", async () => {
  const f = await fixture();
  const selectedSource = source("acquisition-only", false);
  const claudeSource: NativeSource = { ...source("claude-branch", false), source: "claude_code", acquisition: "files" };
  acquisition.discover.mockResolvedValue([selectedSource, claudeSource]);
  acquisition.list.mockImplementation(async (value: NativeSource) => ({ items: [native(value.instanceId)], nextCursor: null }));
  acquisition.read.mockImplementation(async (value: NativeSource, session: NativeSession) => historyRead(value, session));
  const canResume = vi.fn(async (): Promise<boolean | { available: boolean; reason: string | null }> => ({ available: false, reason: "Original working folder is missing." }));
  const handle = f.api(canResume);
  await handle("list", { retain: true });
  expect(canResume).not.toHaveBeenCalled();
  const id = selectionId(selectedSource.instanceId);
  const retainedId = `native-${id}`;
  expect(await f.store.getSession(retainedId)).toMatchObject({ nativeAgent: null, metadata: { nativeHistoryLoaded: false, nativeResumeAvailable: false } });
  const denied = await handle("open", { id }) as Session;
  expect(denied).toMatchObject({ id: retainedId, nativeAgent: null, metadata: { nativeHistoryLoaded: true, nativeResumeAvailable: false } });
  expect(denied.metadata?.nativeReadOnlyReason).toBeTruthy();
  expect(canResume).toHaveBeenCalledWith("opencode", "/workspace");
  expect((await f.store.getSession(retainedId))?.metadata?.nativeReadOnlyReason).toBe("Original working folder is missing.");

  canResume.mockResolvedValue(true);
  const eventBoundary = f.events.length;
  const qualified = await handle("open", { id }) as Session;
  expect(qualified).toMatchObject({ id: retainedId, nativeAgent: {
    provider: "opencode", instanceId: nativeAgentLaunch("opencode", { sourceHome: "/fixture-account" }).instanceId,
    sessionId: "vendor-id", cwd: "/workspace",
  }, metadata: { nativeHistoryLoaded: true, nativeResumeAvailable: true, nativeReadOnlyReason: null } });
  expect(f.events.slice(eventBoundary)).toContainEqual(expect.objectContaining({ name: "session.updated", sessionId: retainedId,
    data: expect.objectContaining({ session: expect.objectContaining({ nativeAgent: expect.objectContaining({ sessionId: "vendor-id" }) }) }) }));
  expect((await f.store.sessionShells()).filter((session) => session.id === retainedId)).toHaveLength(1);

  canResume.mockClear();
  // Following an already qualified conversation must not keep launching
  // capability probes (and creating empty vendor sessions) on every refresh.
  await handle("open", { id });
  expect(canResume).not.toHaveBeenCalled();
  const branch = { leafId: "chosen-leaf", revision: "a".repeat(64) };
  const snapshot = await handle("open", { id: selectionId(claudeSource.instanceId), branch }) as Session;
  expect(snapshot).toMatchObject({ provider: "claude-code", nativeAgent: null, metadata: { nativeBranch: branch, nativeResumeAvailable: false } });
  expect(snapshot.metadata?.nativeReadOnlyReason).toBeTruthy();
  expect(canResume).not.toHaveBeenCalled();

  acquisition.read.mockImplementationOnce(async () => ({ preview: { sessions: [{ sessionId: "foreign-native-id" }] } }));
  await expect(handle("open", { id })).rejects.toThrow("does not match");
  expect(canResume).not.toHaveBeenCalled();
});
