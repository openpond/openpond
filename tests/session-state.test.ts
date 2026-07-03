import { describe, expect, test } from "bun:test";
import type { Session } from "@openpond/contracts";
import {
  mergeBootstrapSessionListPreservingLocalState,
  mergeSessionListPreservingLocalSidebarState,
  recordSessionSidebarStateChanges,
  RECENT_LOCAL_SESSION_SIDEBAR_STATE_TTL_MS,
  upsertSessionPreservingLocalSidebarState,
  upsertSessionPreservingLocalSidebarStateAndRecency,
  type SessionSidebarStateChangeTimes,
} from "../apps/web/src/lib/session-state";

const older = "2026-07-01T10:00:00.000Z";
const newer = "2026-07-01T10:00:01.000Z";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "codex",
    title: "Codex chat",
    appId: null,
    appName: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/tmp/project",
    codexThreadId: "thread_1",
    createdAt: older,
    updatedAt: older,
    status: "idle",
    pinned: false,
    archived: false,
    order: 10,
    ...overrides,
  };
}

describe("session state merging", () => {
  test("keeps newer local sidebar fields and status when stale history payloads arrive", () => {
    const current = session({
      updatedAt: newer,
      pinned: true,
      archived: false,
      order: 2,
      status: "idle",
    });
    const stale = session({
      updatedAt: older,
      pinned: false,
      archived: true,
      order: 10,
      status: "active",
    });

    expect(upsertSessionPreservingLocalSidebarState([current], stale)).toEqual([
      {
        ...stale,
        updatedAt: newer,
        pinned: true,
        archived: false,
        order: 2,
        status: "idle",
      },
    ]);
  });

  test("accepts newer incoming sidebar state", () => {
    const current = session({
      updatedAt: older,
      pinned: true,
      order: 2,
    });
    const incoming = session({
      updatedAt: newer,
      pinned: false,
      archived: true,
      order: 10,
    });

    expect(upsertSessionPreservingLocalSidebarState([current], incoming)).toEqual([incoming]);
  });

  test("preserves local sidebar state during bootstrap list replacement", () => {
    const current = [
      session({ updatedAt: newer, pinned: true, order: 1, status: "idle" }),
      session({ id: "session_2", codexThreadId: "thread_2", updatedAt: newer, pinned: true, order: 2 }),
    ];
    const incoming = [
      session({ updatedAt: older, pinned: false, order: 10, status: "active" }),
    ];

    expect(mergeSessionListPreservingLocalSidebarState(current, incoming)).toEqual([
      {
        ...incoming[0]!,
        updatedAt: newer,
        pinned: true,
        archived: false,
        order: 1,
        status: "idle",
      },
    ]);
  });

  test("keeps a newer local session when a stale bootstrap list arrives", () => {
    const current = [
      session({ id: "session_new", codexThreadId: null, updatedAt: newer, title: "New chat" }),
      session({ id: "session_old", codexThreadId: "thread_old", updatedAt: older }),
    ];
    const incoming = [
      session({ id: "session_old", codexThreadId: "thread_old", updatedAt: older }),
    ];

    expect(mergeBootstrapSessionListPreservingLocalState(current, incoming)).toEqual([
      current[0],
      incoming[0],
    ]);
  });

  test("drops missing current sessions that are older than the bootstrap list", () => {
    const current = [
      session({ id: "session_missing", codexThreadId: "thread_missing", updatedAt: older }),
      session({ id: "session_live", codexThreadId: "thread_live", updatedAt: older }),
    ];
    const incoming = [
      session({ id: "session_live", codexThreadId: "thread_live", updatedAt: newer }),
    ];

    expect(mergeBootstrapSessionListPreservingLocalState(current, incoming)).toEqual([
      incoming[0],
    ]);
  });

  test("accepts newer incoming status", () => {
    const current = session({
      updatedAt: older,
      status: "active",
    });
    const incoming = session({
      updatedAt: newer,
      status: "idle",
    });

    expect(upsertSessionPreservingLocalSidebarState([current], incoming)).toEqual([incoming]);
  });

  test("can hydrate selected session details without changing sidebar recency", () => {
    const current = session({
      updatedAt: older,
      pinned: true,
      archived: false,
      order: 2,
      status: "idle",
    });
    const hydrated = session({
      updatedAt: newer,
      pinned: false,
      archived: true,
      order: 10,
      status: "active",
      title: "Hydrated title",
    });

    expect(upsertSessionPreservingLocalSidebarStateAndRecency([current], hydrated)).toEqual([
      {
        ...hydrated,
        updatedAt: older,
        pinned: true,
        archived: false,
        order: 2,
      },
    ]);
  });

  test("keeps recent local sidebar state without requiring an updatedAt bump", () => {
    const previous = [session({ pinned: false, archived: false, order: 10, updatedAt: older })];
    const current = [session({ pinned: true, archived: false, order: 10, updatedAt: older })];
    const incoming = [session({ pinned: false, archived: false, order: 10, updatedAt: older })];
    const changeTimes: SessionSidebarStateChangeTimes = {};

    recordSessionSidebarStateChanges(changeTimes, previous, current, 1_000);

    expect(
      mergeSessionListPreservingLocalSidebarState(current, incoming, changeTimes, 1_050),
    ).toEqual([
      {
        ...incoming[0]!,
        pinned: true,
        archived: false,
        order: 10,
      },
    ]);
  });

  test("accepts stale sidebar state again after the local session freshness window expires", () => {
    const current = [session({ pinned: true, updatedAt: older })];
    const incoming = [session({ pinned: false, updatedAt: older })];
    const changeTimes: SessionSidebarStateChangeTimes = {
      session_1: 1_000,
    };

    expect(
      mergeSessionListPreservingLocalSidebarState(
        current,
        incoming,
        changeTimes,
        1_000 + RECENT_LOCAL_SESSION_SIDEBAR_STATE_TTL_MS + 1,
      ),
    ).toEqual(incoming);
    expect(changeTimes).toEqual({});
  });
});
