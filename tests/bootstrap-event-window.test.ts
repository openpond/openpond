import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { BootstrapPayload, RuntimeEvent, Session } from "@openpond/contracts";

import type { RuntimeEventPagePayload } from "../apps/server/src/api/event-page";
import { createOpenPondServer } from "../apps/server/src/index";
import { SqliteStore } from "../apps/server/src/store/store";

async function api<T>(
  serverUrl: string,
  token: string,
  route: string,
): Promise<T> {
  const response = await fetch(`${serverUrl}${route}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

describe("bootstrap event window", () => {
  test("sends a recent event window while event paging retrieves omitted session history", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-bootstrap-event-window-"));
    const session = sessionFixture("session-window");
    const store = new SqliteStore(storeDir);
    await store.mutate((data) => {
      data.sessions.push(session);
      for (let index = 1; index <= 505; index += 1) {
        data.events.push(runtimeEvent(index, session.id));
      }
    });
    await store.close();

    const server = await createOpenPondServer({
      port: 0,
      storeDir,
      silent: true,
      version: "bootstrap-event-window-test",
    });

    try {
      const bootstrap = await api<BootstrapPayload>(
        server.url,
        server.token,
        "/v1/bootstrap?ensureProfile=0",
      );
      expect(bootstrap.sessions.some((item) => item.id === session.id)).toBe(true);
      expect(bootstrap.events).toHaveLength(500);
      expect(bootstrap.events[0]?.id).toBe("event-6");
      expect(bootstrap.events.at(-1)?.id).toBe("event-505");
      expect(bootstrap.eventWindow).toMatchObject({
        latestSequence: 505,
        oldestSequence: 6,
        totalEvents: 505,
        limit: 500,
        hasMoreBefore: true,
      });

      const firstPage = await api<RuntimeEventPagePayload>(
        server.url,
        server.token,
        `/v1/events/page?sessionId=${encodeURIComponent(session.id)}&afterSequence=0&limit=500`,
      );
      expect(firstPage.events).toHaveLength(500);
      expect(firstPage.events[0]?.sequence).toBe(1);
      expect(firstPage.events[0]?.event.id).toBe("event-1");
      expect(firstPage.hasMore).toBe(true);

      const secondPage = await api<RuntimeEventPagePayload>(
        server.url,
        server.token,
        `/v1/events/page?sessionId=${encodeURIComponent(session.id)}&afterSequence=${firstPage.nextSequence}&limit=500`,
      );
      expect(secondPage.events.map((entry) => entry.event.id)).toEqual([
        "event-501",
        "event-502",
        "event-503",
        "event-504",
        "event-505",
      ]);
      expect(secondPage.hasMore).toBe(false);

      const latestPage = await api<RuntimeEventPagePayload>(
        server.url,
        server.token,
        `/v1/events/page?sessionId=${encodeURIComponent(session.id)}&beforeSequence=${bootstrap.eventWindow.latestSequence + 1}&limit=500`,
      );
      expect(latestPage.events).toHaveLength(500);
      expect(latestPage.events[0]?.event.id).toBe("event-6");
      expect(latestPage.events.at(-1)?.event.id).toBe("event-505");
      expect(latestPage.hasMore).toBe(true);
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("pages omitted archived session history only for the requested session", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-bootstrap-archived-event-window-"));
    const archivedSession = sessionFixture("session-archived", { archived: true });
    const activeSession = sessionFixture("session-active");
    const store = new SqliteStore(storeDir);
    await store.mutate((data) => {
      data.sessions.push(archivedSession, activeSession);
      for (let index = 1; index <= 10; index += 1) {
        data.events.push(runtimeEvent(index, archivedSession.id, `archived-event-${index}`));
      }
      for (let index = 11; index <= 520; index += 1) {
        data.events.push(runtimeEvent(index, activeSession.id, `active-event-${index}`));
      }
    });
    await store.close();

    const server = await createOpenPondServer({
      port: 0,
      storeDir,
      silent: true,
      version: "bootstrap-archived-event-window-test",
    });

    try {
      const bootstrap = await api<BootstrapPayload>(
        server.url,
        server.token,
        "/v1/bootstrap?ensureProfile=0",
      );
      expect(bootstrap.sessions.find((item) => item.id === archivedSession.id)?.archived).toBe(true);
      expect(bootstrap.events.some((item) => item.sessionId === archivedSession.id)).toBe(false);
      expect(bootstrap.eventWindow.hasMoreBefore).toBe(true);

      const archivedPage = await api<RuntimeEventPagePayload>(
        server.url,
        server.token,
        `/v1/events/page?sessionId=${encodeURIComponent(archivedSession.id)}&afterSequence=0&limit=20`,
      );
      expect(archivedPage.totalMatchingEvents).toBe(10);
      expect(archivedPage.events.map((entry) => entry.event.id)).toEqual(
        Array.from({ length: 10 }, (_, index) => `archived-event-${index + 1}`),
      );
      expect(archivedPage.events.every((entry) => entry.event.sessionId === archivedSession.id)).toBe(true);
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  }, 10_000);
});

function sessionFixture(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    provider: "openpond",
    modelRef: null,
    title: "Windowed event session",
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
    ...overrides,
  };
}

function runtimeEvent(index: number, sessionId: string, id = `event-${index}`): RuntimeEvent {
  return {
    id,
    sessionId,
    turnId: `turn-${Math.ceil(index / 10)}`,
    name: "assistant.delta",
    timestamp: `2026-07-01T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    source: "provider",
    output: `chunk-${index}`,
  };
}
