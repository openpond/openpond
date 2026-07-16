import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { RuntimeEvent, Session } from "@openpond/contracts";

import { runtimeEventsPagePayload } from "../apps/server/src/api/event-page";
import { createOpenPondServer } from "../apps/server/src/index";

async function api<T>(server: string, token: string, route: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${server}${route}`, { ...init, headers });
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

function runtimeEvent(id: string, sessionId: string, name: RuntimeEvent["name"]): RuntimeEvent {
  return {
    id,
    sessionId,
    name,
    timestamp: "2026-07-01T00:00:00.000Z",
    source: "server",
  };
}

describe("runtime event page", () => {
  test("returns a bounded cursor page filtered by session", () => {
    const payload = runtimeEventsPagePayload(
      [
        runtimeEvent("event-1", "session-a", "session.started"),
        runtimeEvent("event-2", "session-b", "session.started"),
        runtimeEvent("event-3", "session-a", "assistant.delta"),
        runtimeEvent("event-4", "session-a", "turn.completed"),
      ],
      new URL("http://127.0.0.1:17874/v1/events/page?sessionId=session-a&afterSequence=1&limit=1"),
    );

    expect(payload).toEqual({
      events: [
        {
          sequence: 3,
          event: runtimeEvent("event-3", "session-a", "assistant.delta"),
        },
      ],
      sessionId: "session-a",
      afterSequence: 1,
      beforeSequence: null,
      nextSequence: 3,
      previousSequence: 3,
      limit: 1,
      hasMore: true,
      totalMatchingEvents: 3,
      remainingMatchingEvents: 2,
    });

    const nextPayload = runtimeEventsPagePayload(
      [
        runtimeEvent("event-1", "session-a", "session.started"),
        runtimeEvent("event-2", "session-b", "session.started"),
        runtimeEvent("event-3", "session-a", "assistant.delta"),
        runtimeEvent("event-4", "session-a", "turn.completed"),
      ],
      new URL(`http://127.0.0.1:17874/v1/events/page?sessionId=session-a&afterSequence=${payload.nextSequence}&limit=10`),
    );

    expect(nextPayload.events.map((entry) => [entry.sequence, entry.event.id])).toEqual([
      [4, "event-4"],
    ]);
    expect(nextPayload.hasMore).toBe(false);
    expect(nextPayload.remainingMatchingEvents).toBe(1);
  });

  test("returns the contiguous page immediately before a sequence cursor", () => {
    const payload = runtimeEventsPagePayload(
      [
        runtimeEvent("event-1", "session-a", "session.started"),
        runtimeEvent("event-2", "session-a", "assistant.delta"),
        runtimeEvent("event-3", "session-a", "assistant.delta"),
        runtimeEvent("event-4", "session-a", "assistant.delta"),
        runtimeEvent("event-5", "session-a", "turn.completed"),
      ],
      new URL("http://127.0.0.1:17874/v1/events/page?sessionId=session-a&beforeSequence=5&limit=2"),
    );

    expect(payload.events.map((entry) => [entry.sequence, entry.event.id])).toEqual([
      [3, "event-3"],
      [4, "event-4"],
    ]);
    expect(payload.beforeSequence).toBe(5);
    expect(payload.previousSequence).toBe(3);
    expect(payload.hasMore).toBe(true);
    expect(payload.remainingMatchingEvents).toBe(4);
  });

  test("serves persisted session events from a real authenticated local server", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openpond-event-page-"));
    const server = await createOpenPondServer({
      port: 0,
      storeDir,
      silent: true,
      version: "event-page-test",
    });

    try {
      const session = await api<Session>(server.url, server.token, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          provider: "codex",
          title: "event page route",
          cwd: process.cwd(),
        }),
      });

      const payload = await api<ReturnType<typeof runtimeEventsPagePayload>>(
        server.url,
        server.token,
        `/v1/events/page?sessionId=${encodeURIComponent(session.id)}&afterSequence=0&limit=10`,
      );

      expect(payload.sessionId).toBe(session.id);
      expect(payload.limit).toBe(10);
      expect(payload.events.length).toBeGreaterThanOrEqual(1);
      expect(payload.events[0]?.sequence).toBeGreaterThanOrEqual(1);
      expect(payload.events.some((entry) => entry.event.name === "session.started")).toBe(true);
      expect(JSON.stringify(payload)).not.toContain(server.token);
    } finally {
      await server.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
