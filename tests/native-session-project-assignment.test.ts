import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createSessionStore } from "../apps/server/src/store/session-store.js";
import { SqliteStore } from "../apps/server/src/store/store.js";

// A project attachment must preserve native conversation/account identity and
// never report success when resume fails or a response starts during the move.
test("qualifies native project changes before atomically committing their folder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-project-assignment-"));
  const store = new SqliteStore(directory);
  const qualify = vi.fn(async () => {});
  const service = createSessionStore({ store, defaultSessionCwd: () => directory,
    qualifyNativeWorkspace: qualify, appendRuntimeEvent: async event => { await store.appendRuntimeEvent(event); } });
  try {
    const session = await service.createSession({ provider: "claude-code", cwd: directory });
    const nativeAgent = { provider: "claude-code" as const, instanceId: "original-account", sessionId: "native-conversation", cwd: directory };
    await service.updateSession(session.id, { nativeAgent });
    const patch = { cwd: join(directory, "project"), workspaceKind: "local_project", workspaceId: "project", localProjectId: "project" };
    qualify.mockRejectedValueOnce(new Error("Native resume failed"));
    await expect(service.patchSession(session.id, patch)).rejects.toThrow("Native resume failed");
    expect((await service.getSession(session.id)).nativeAgent).toEqual(nativeAgent);
    expect((await service.getSession(session.id)).cwd).toBe(directory);
    qualify.mockImplementationOnce(async () => { await service.updateSession(session.id, { status: "active" }); });
    await expect(service.patchSession(session.id, patch)).rejects.toThrow("conversation changed");
    expect((await service.getSession(session.id)).nativeAgent).toEqual(nativeAgent);
    await service.updateSession(session.id, { status: "idle" });
    const moved = await service.patchSession(session.id, patch);
    expect(qualify).toHaveBeenLastCalledWith(nativeAgent, patch.cwd);
    expect(moved.id).toBe(session.id);
    expect(moved.nativeAgent).toEqual({ ...nativeAgent, cwd: patch.cwd });
    expect(moved.cwd).toBe(patch.cwd);
    expect(moved.localProjectId).toBe("project");
    // A retry also repairs a previously committed project with a stale binding.
    await service.updateSession(session.id, { nativeAgent });
    expect((await service.patchSession(session.id, patch)).nativeAgent?.cwd).toBe(patch.cwd);
    const calls = qualify.mock.calls.length;
    await expect(service.patchSession(session.id, { ...patch, cwd: null })).rejects.toThrow("local project folder");
    await expect(service.patchSession(session.id, { ...patch, cwd: directory, provider: "opencode" })).rejects.toThrow("original agent configuration");
    expect(qualify.mock.calls).toHaveLength(calls);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

// Moving a conversation must retain original file locations even when its old
// messages are outside the UI's loaded history page; sandbox roots stay scoped.
test("conversation file references keep their original folder and sandbox across project changes", async () => {
  const { sessionFileArtifacts } = await import("../apps/server/src/workspace/session-file-artifacts.js");
  const { SessionSchema, RuntimeEventSchema } = await import("@openpond/contracts");
  const session = SessionSchema.parse({ id: "chat", title: "Files", provider: "claude-code", experience: "work",
    appId: null, appName: null, cwd: "/new-project", codexThreadId: null, status: "idle",
    createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z", pinned: false, archived: false, order: 0 });
  let eventId = 0;
  const event = (name: string, data: unknown, extra = {}) => RuntimeEventSchema.parse({ id: String(++eventId), sessionId: "chat", name,
    timestamp: "2026-10-12T00:00:00Z", source: "server", data, ...extra });
  const artifact = { path: "outputs/deck.pptx", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sizeBytes: 120 };
  const events = [event("session.started", { session: { cwd: "/old-project" } }), event("workspace_action_result", { artifacts: [artifact] }),
    event("assistant.delta", { delta: "[Word document](<notes/" }, { turnId: "old-answer" }),
    event("assistant.delta", { delta: "report.docx>)" }, { turnId: "old-answer" }),
    event("session.updated", { session: { cwd: "/new-project" } }), event("tool.completed", { artifacts: [{ ...artifact, path: "report.docx" }] }),
    event("session.updated", { session: { cwd: "/workspace", workspaceKind: "sandbox", workspaceId: "old-sandbox" } }),
    event("workspace_action_result", { artifacts: [{ ...artifact, path: "/workspace/deck.pptx" }] }),
    event("session.updated", { session: { cwd: "/workspace", workspaceKind: "sandbox", workspaceId: "new-sandbox" } }),
    event("workspace_action_result", { artifacts: [{ ...artifact, path: "/workspace/deck.pptx" }] })];
  const files = sessionFileArtifacts(session, events);
  expect(files.map(file => [file.path, file.sandboxId])).toEqual(expect.arrayContaining([
    ["/old-project/outputs/deck.pptx", null], ["/new-project/report.docx", null],
    ["/workspace/deck.pptx", "old-sandbox"], ["/workspace/deck.pptx", "new-sandbox"], ["/old-project/notes/report.docx", null],
  ]));
  expect(files).toHaveLength(5);
  expect(files.map(file => file.path)).toEqual(["/workspace/deck.pptx", "/workspace/deck.pptx", "/new-project/report.docx", "/old-project/notes/report.docx", "/old-project/outputs/deck.pptx"]);
  expect(sessionFileArtifacts(session, [...events, event("tool.completed", { artifacts: [{ ...artifact, path: "/workspace/deck.pptx" }] }, { action: "work_output_delete", status: "completed" })]))
    .toHaveLength(4);
});


// Rewriting a saved filename must move it to the front even without another
// output event; repeated refreshes must not rescan immutable transcript history.
test("conversation file refreshes sort by disk updates and reuse the persisted index", async () => {
  const { createSessionFileIndex } = await import("../apps/server/src/workspace/session-file-index.js");
  const { SessionSchema, RuntimeEventSchema } = await import("@openpond/contracts");
  const directory = await mkdtemp(join(tmpdir(), "openpond-file-order-"));
  try {
    const a = join(directory, "z-first.txt");
    const b = join(directory, "a-second.txt");
    await writeFile(a, "old"); await writeFile(b, "new");
    await utimes(a, new Date("2026-01-01"), new Date("2026-01-01"));
    await utimes(b, new Date("2026-02-01"), new Date("2026-02-01"));
    const session = SessionSchema.parse({ id: "files", title: "Files", provider: "claude-code", experience: "work",
      appId: null, appName: null, cwd: directory, codexThreadId: null, status: "idle",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", pinned: false, archived: false, order: 0 });
    const events = vi.fn(async () => [RuntimeEventSchema.parse({ id: "1", sessionId: session.id,
      name: "tool.completed", timestamp: session.createdAt, source: "server", data: { artifacts: [a, b].map(path => ({ path, contentType: "text/plain" })) } })]);
    let sequence = 1;
    const index = createSessionFileIndex({ getSession: async () => session, latestSequence: async () => sequence, events });
    const [first, concurrent] = await Promise.all([index(session.id), index(session.id)]);
    expect(first.files.map(file => file.path)).toEqual([b, a]);
    expect(concurrent.files).toEqual(first.files);
    expect(events).toHaveBeenCalledTimes(1);
    await writeFile(a, "updated");
    await utimes(a, new Date("2026-03-01"), new Date("2026-03-01"));
    const next = await index(session.id);
    expect(next.files.map(file => file.path)).toEqual([a, b]);
    expect(next.files[0]?.revision).not.toBe(first.files[1]?.revision);
    expect(events).toHaveBeenCalledTimes(1);
    sequence += 1;
    await index(session.id);
    expect(events).toHaveBeenCalledTimes(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
