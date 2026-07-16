import { describe, expect, test } from "vitest";
import type { Session } from "@openpond/contracts";
import { codexHistorySessionWithLiveStatus } from "../apps/server/src/api/server-payload-helpers";
import {
  createCodexHistoryLiveRefreshCoordinator,
  codexHistoryPayloadWithLiveStatus,
  codexHistoryRefreshDelayMs,
} from "../apps/web/src/lib/codex-history-live-refresh";

describe("Codex history live refresh", () => {
  test("refreshes active history threads faster than idle discovery", () => {
    expect(codexHistoryRefreshDelayMs({ active: true, surface: "thread" })).toBe(500);
    expect(codexHistoryRefreshDelayMs({ active: true, surface: "sidebar" })).toBe(500);
    expect(codexHistoryRefreshDelayMs({ active: false, surface: "thread" })).toBe(2_500);
    expect(codexHistoryRefreshDelayMs({ active: false, surface: "sidebar" })).toBe(15_000);
  });

  test("keeps an imported Codex session active while the server owns its turn", () => {
    const idle = session("idle");
    const active = codexHistorySessionWithLiveStatus(idle, true);

    expect(active.status).toBe("active");
    expect(codexHistorySessionWithLiveStatus(active, true)).toBe(active);
    expect(codexHistorySessionWithLiveStatus(idle, false)).toBe(idle);
  });

  test("does not let an early idle history read erase optimistic running state", () => {
    const payload = { session: session("idle"), events: [] };
    const livePayload = codexHistoryPayloadWithLiveStatus(payload, true);

    expect(livePayload.session.status).toBe("active");
    expect(codexHistoryPayloadWithLiveStatus(livePayload, true)).toBe(livePayload);
    expect(codexHistoryPayloadWithLiveStatus(payload, false)).toBe(payload);
  });

  test("coordinates sidebar and thread refreshes with one non-overlapping request", async () => {
    let timerId = 0;
    const timers = new Map<number, { callback: () => void; delayMs: number }>();
    const pendingLoads: Array<{
      resolve: (payload: { session: Session; events: [] }) => void;
    }> = [];
    let loadCount = 0;
    const coordinator = createCodexHistoryLiveRefreshCoordinator({
      cachedPayload: () => null,
      clearTimer: (id) => timers.delete(id as number),
      loadPayload: () => {
        loadCount += 1;
        return new Promise((resolve) => pendingLoads.push({ resolve }));
      },
      now: () => 0,
      setTimer: (callback, delayMs) => {
        const id = ++timerId;
        timers.set(id, { callback, delayMs });
        return id;
      },
    });
    const connection = { serverUrl: "http://127.0.0.1:17876", token: "test-token" };
    const receivedStatuses: Session["status"][] = [];
    const subscribe = (surface: "sidebar" | "thread") =>
      coordinator.subscribe({
        connection,
        locallyActive: false,
        onPayload: (payload) => receivedStatuses.push(payload.session.status),
        reportedActive: false,
        sessionId: "codex_history_thread-1",
        surface,
      });

    const unsubscribeSidebar = subscribe("sidebar");
    const unsubscribeThread = subscribe("thread");
    expect([...timers.values()].map((timer) => timer.delayMs)).toEqual([0]);

    runNextTimer(timers);
    expect(loadCount).toBe(1);
    expect(timers.size).toBe(0);

    pendingLoads.shift()!.resolve({ session: session("idle"), events: [] });
    await flushPromises();
    expect(receivedStatuses).toEqual(["idle", "idle"]);
    expect([...timers.values()].map((timer) => timer.delayMs)).toEqual([2_500]);

    runNextTimer(timers);
    expect(loadCount).toBe(2);
    expect(timers.size).toBe(0);
    pendingLoads.shift()!.resolve({ session: session("active"), events: [] });
    await flushPromises();
    expect([...timers.values()].map((timer) => timer.delayMs)).toEqual([500]);

    unsubscribeThread();
    runNextTimer(timers);
    expect(loadCount).toBe(3);
    pendingLoads.shift()!.resolve({ session: session("idle"), events: [] });
    await flushPromises();
    expect([...timers.values()].map((timer) => timer.delayMs)).toEqual([15_000]);

    unsubscribeSidebar();
    expect(timers.size).toBe(0);
  });
});

function runNextTimer(
  timers: Map<number, { callback: () => void; delayMs: number }>,
): void {
  const next = timers.entries().next().value;
  if (!next) throw new Error("Expected a scheduled refresh");
  const [id, timer] = next;
  timers.delete(id);
  timer.callback();
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function session(status: Session["status"]): Session {
  return {
    id: "codex_history_thread-1",
    provider: "codex",
    modelRef: null,
    title: "Imported Codex thread",
    appId: null,
    appName: null,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/tmp/project",
    codexThreadId: "thread-1",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    status,
    pinned: false,
    archived: false,
    order: 0,
  };
}
