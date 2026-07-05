import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { createSessionStore } from "../apps/server/src/store/session-store";
import { SqliteStore } from "../apps/server/src/store/store";

describe("session store patches", () => {
  test("creates normal local chat sessions visible in the default sidebar", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-session-store-"));
    const store = new SqliteStore(storeDir);
    const events: RuntimeEvent[] = [];

    try {
      const { createSession } = createSessionStore({
        store,
        defaultSessionCwd: () => "/tmp/openpond",
        appendRuntimeEvent: async (event: RuntimeEvent) => {
          events.push(event);
        },
      });

      const created = await createSession({
        provider: "openai",
        title: "Terminal chat",
        cwd: "/tmp/project",
      });
      const stored = await store.getSession(created.id);

      expect(created.hiddenFromDefaultSidebar).toBe(false);
      expect(created.appId).toBeNull();
      expect(created.workspaceKind).toBeUndefined();
      expect(created.cwd).toBe("/tmp/project");
      expect(stored?.hiddenFromDefaultSidebar).toBe(false);
      expect(events[0]).toMatchObject({
        sessionId: created.id,
        name: "session.started",
        source: "server",
        data: {
          provider: "openai",
          appName: null,
          cwd: "/tmp/project",
        },
      });
    } finally {
      await store.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("persists session metadata through create and patch", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-session-store-"));
    const store = new SqliteStore(storeDir);

    try {
      const { createSession, patchSession } = createSessionStore({
        store,
        defaultSessionCwd: () => "/tmp/openpond",
        appendRuntimeEvent: async (_event: RuntimeEvent) => undefined,
      });

      const created = await createSession({
        provider: "codex",
        workspaceKind: "sandbox",
        workspaceId: null,
        metadata: { workspaceTarget: "hybrid", source: "test" },
        title: "Hybrid chat",
      });
      const stored = await store.getSession(created.id);

      expect(created.metadata).toEqual({ workspaceTarget: "hybrid", source: "test" });
      expect(stored?.metadata).toEqual({ workspaceTarget: "hybrid", source: "test" });

      const patched = await patchSession(created.id, {
        metadata: { workspaceTarget: "hybrid", source: "patched" },
      });

      expect(patched.metadata).toEqual({ workspaceTarget: "hybrid", source: "patched" });
    } finally {
      await store.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("keeps updatedAt stable for sidebar-only patches", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-session-store-"));
    const store = new SqliteStore(storeDir);
    const baseSession = session("session-sidebar");

    try {
      await store.insertSessionAtFront(baseSession);
      const { patchSession } = createSessionStore({
        store,
        defaultSessionCwd: () => "/tmp/openpond",
        appendRuntimeEvent: async (_event: RuntimeEvent) => undefined,
      });

      const pinned = await patchSession(baseSession.id, { pinned: true, archived: false });

      expect(pinned.pinned).toBe(true);
      expect(pinned.archived).toBe(false);
      expect(pinned.updatedAt).toBe(baseSession.updatedAt);

      const reordered = await patchSession(baseSession.id, { order: 7 });

      expect(reordered.order).toBe(7);
      expect(reordered.updatedAt).toBe(baseSession.updatedAt);

      const rebound = await patchSession(baseSession.id, {
        provider: "openpond",
        workspaceKind: "local_project",
        workspaceId: "project_1",
        workspaceName: "Project",
        cwd: "/tmp/project",
      });

      expect(rebound.workspaceKind).toBe("local_project");
      expect(rebound.workspaceId).toBe("project_1");
      expect(rebound.updatedAt).toBe(baseSession.updatedAt);
    } finally {
      await store.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});

function session(id: string): Session {
  return {
    id,
    provider: "openpond",
    modelRef: null,
    title: id,
    appId: null,
    appName: null,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/tmp/openpond",
    codexThreadId: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}
