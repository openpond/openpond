import { mkdtemp, rm } from "node:fs/promises";
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
