import type { Session } from "@openpond/contracts";
import { describe, expect, test } from "vitest";

import { tasksetNameFromId } from "../apps/web/src/lib/session-tasksets";
import {
  mergeSidebarTaskOrder,
  sidebarTaskEmptyLabel,
  sidebarTaskRows,
  sidebarTaskShortcutState,
} from "../apps/web/src/lib/sidebar-task-list";

const NOW = "2026-07-29T12:00:00.000Z";

describe("sidebar task filters", () => {
  const active = session({
    id: "active",
    title: "Active",
    updatedAt: "2026-07-29T10:00:00.000Z",
  });
  const running = session({
    id: "running",
    title: "Running",
    order: 1,
    updatedAt: "2026-07-29T11:00:00.000Z",
  });
  const pinned = session({
    id: "pinned",
    title: "Pinned",
    order: 2,
    pinned: true,
    updatedAt: "2026-07-29T09:00:00.000Z",
  });
  const saved = session({
    id: "saved",
    title: "Saved",
    order: 3,
    pinned: true,
    savedForLater: true,
    updatedAt: "2026-07-29T12:00:00.000Z",
  });
  const done = session({
    id: "done",
    title: "Done",
    order: 4,
    archived: true,
    updatedAt: "2026-07-29T08:00:00.000Z",
  });
  const input = {
    activeSessions: [active, running, pinned, saved],
    doneSessions: [done],
    inProgressSessionIds: new Set([running.id]),
    sort: "recent" as const,
  };

  test("derives readable legacy Taskset names", () => {
    expect(tasksetNameFromId("benchmark-harness-refiner-b227699dcd0c5007"))
      .toBe("Harness Refiner");
    expect(tasksetNameFromId("taskset_work_fixture_portability"))
      .toBe("Work Fixture Portability");
  });

  test("Active excludes saved and done tasks", () => {
    expect(sidebarTaskRows({ ...input, filter: "active" }).map((row) => row.id))
      .toEqual(["pinned", "running", "active"]);
  });

  test("status filters remain literal", () => {
    expect(sidebarTaskRows({ ...input, filter: "in_progress" }).map((row) => row.id))
      .toEqual(["running"]);
    expect(sidebarTaskRows({ ...input, filter: "pinned" }).map((row) => row.id))
      .toEqual(["pinned"]);
    expect(sidebarTaskRows({ ...input, filter: "saved_for_later" }).map((row) => row.id))
      .toEqual(["saved"]);
    expect(sidebarTaskRows({ ...input, filter: "done" }).map((row) => row.id))
      .toEqual(["done"]);
    expect(sidebarTaskRows({ ...input, filter: "all" }).map((row) => row.id))
      .toEqual(["pinned", "saved", "running", "active", "done"]);
    expect(sidebarTaskEmptyLabel("saved_for_later", "tasks"))
      .toBe("Nothing saved for later");
  });

  test("Codex visibility composes with status filters", () => {
    const codexProviderSession = session({
      id: "codex-provider",
      provider: "codex",
      updatedAt: "2026-07-29T12:00:00.000Z",
    });
    const codexHistorySession = session({
      id: "codex_history_imported",
      provider: "openpond",
      updatedAt: "2026-07-29T11:30:00.000Z",
    });

    expect(sidebarTaskRows({
      activeSessions: [active, codexProviderSession, codexHistorySession],
      doneSessions: [],
      filter: "active",
      inProgressSessionIds: new Set(),
      showCodexChats: false,
      sort: "recent",
    }).map((row) => row.id)).toEqual(["active"]);
  });

  test("running-only visibility composes with Codex visibility and sorting", () => {
    const runningCodex = session({
      id: "running-codex",
      provider: "codex",
      updatedAt: "2026-07-29T12:00:00.000Z",
    });
    const runningOpenPond = session({
      id: "running-openpond",
      updatedAt: "2026-07-29T11:30:00.000Z",
    });
    const idleOpenPond = session({
      id: "idle-openpond",
      updatedAt: "2026-07-29T13:00:00.000Z",
    });

    expect(sidebarTaskRows({
      activeSessions: [idleOpenPond, runningOpenPond, runningCodex],
      doneSessions: [],
      filter: "active",
      inProgressSessionIds: new Set([runningCodex.id, runningOpenPond.id]),
      onlyRunningTasks: true,
      showCodexChats: false,
      sort: "recent",
    }).map((row) => row.id)).toEqual(["running-openpond"]);
  });

  test("recent mode preserves manual order inside the pinned block", () => {
    const firstPinned = session({
      id: "first-pinned",
      order: 8,
      pinned: true,
      updatedAt: "2026-07-20T12:00:00.000Z",
    });
    const secondPinned = session({
      id: "second-pinned",
      order: 9,
      pinned: true,
      updatedAt: "2026-07-29T12:00:00.000Z",
    });
    const newestRegular = session({
      id: "newest-regular",
      order: 0,
      updatedAt: "2026-07-30T12:00:00.000Z",
    });

    expect(sidebarTaskRows({
      activeSessions: [secondPinned, newestRegular, firstPinned],
      doneSessions: [],
      filter: "active",
      inProgressSessionIds: new Set(),
      sort: "recent",
    }).map((row) => row.id)).toEqual([
      "first-pinned",
      "second-pinned",
      "newest-regular",
    ]);
  });

  test("recent mode previews pinned drag order without changing regular recency", () => {
    const firstPinned = session({
      id: "first-pinned",
      order: 8,
      pinned: true,
      updatedAt: "2026-07-20T12:00:00.000Z",
    });
    const secondPinned = session({
      id: "second-pinned",
      order: 9,
      pinned: true,
      updatedAt: "2026-07-29T12:00:00.000Z",
    });
    const olderRegular = session({
      id: "older-regular",
      updatedAt: "2026-07-28T12:00:00.000Z",
    });
    const newerRegular = session({
      id: "newer-regular",
      updatedAt: "2026-07-30T12:00:00.000Z",
    });

    expect(sidebarTaskRows({
      activeSessions: [firstPinned, olderRegular, secondPinned, newerRegular],
      doneSessions: [],
      filter: "active",
      inProgressSessionIds: new Set(),
      previewSessionIds: [secondPinned.id, firstPinned.id],
      sort: "recent",
    }).map((row) => row.id)).toEqual([
      "second-pinned",
      "first-pinned",
      "newer-regular",
      "older-regular",
    ]);
  });

  test("manual order follows persisted order independently of status", () => {
    expect(sidebarTaskRows({ ...input, filter: "all", sort: "manual" }).map((row) => row.id))
      .toEqual(["active", "running", "pinned", "saved", "done"]);
  });

  test("Taskset mode narrows linked chats to one Taskset", () => {
    const first = session({
      id: "taskset-first",
      metadata: { tasksetId: "support", tasksetName: "Support" },
    });
    const second = session({
      id: "taskset-second",
      metadata: { tasksetId: "finance", tasksetName: "Finance" },
    });

    expect(sidebarTaskRows({
      activeSessions: [active, first, second],
      doneSessions: [],
      filter: "tasksets",
      inProgressSessionIds: new Set(),
      selectedTasksetId: "support",
      sort: "recent",
    }).map((row) => row.id)).toEqual(["taskset-first"]);
  });

  test("reordering a filtered view preserves hidden task positions", () => {
    expect(mergeSidebarTaskOrder(
      ["active", "running", "pinned", "saved", "done"],
      ["running", "pinned"],
      ["pinned", "running"],
    )).toEqual(["active", "pinned", "running", "saved", "done"]);
  });

  test("heading shortcut toggles between saved-for-later and active counts", () => {
    expect(sidebarTaskShortcutState({
      activeCount: 12,
      filter: "active",
      savedForLaterCount: 3,
    })).toEqual({
      count: 3,
      label: "Later",
      targetFilter: "saved_for_later",
      targetLabel: "saved for later",
    });
    expect(sidebarTaskShortcutState({
      activeCount: 12,
      filter: "saved_for_later",
      savedForLaterCount: 3,
    })).toEqual({
      count: 12,
      label: "In Progress",
      targetFilter: "active",
      targetLabel: "active",
    });
  });
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session",
    experience: "development",
    provider: "openpond",
    modelRef: null,
    title: "Sidebar session",
    appId: null,
    appName: null,
    workspaceKind: null,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: NOW,
    updatedAt: NOW,
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
