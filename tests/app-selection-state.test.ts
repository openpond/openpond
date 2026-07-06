import { describe, expect, test } from "bun:test";
import type { Session } from "@openpond/contracts";
import { mergedSidebarSessions } from "../apps/web/src/hooks/useAppSelectionState";

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

describe("app selection state", () => {
  test("keeps sidebar sessions in existing order when a chat receives a newer turn", () => {
    const first = session({ id: "session_first", codexThreadId: "thread_first", updatedAt: older });
    const second = session({ id: "session_second", codexThreadId: "thread_second", updatedAt: older });
    const updatedSecond = { ...second, updatedAt: newer };
    const orderKeys: string[] = [];

    expect(mergedSidebarSessions([first, second], [], orderKeys).map((item) => item.id)).toEqual([
      "session_first",
      "session_second",
    ]);

    expect(mergedSidebarSessions([first, updatedSecond], [], orderKeys).map((item) => item.id)).toEqual([
      "session_first",
      "session_second",
    ]);
  });

  test("interleaves live and Codex history rows by timestamp for new sidebar rows", () => {
    const oldLive = session({ id: "session_old_live", codexThreadId: "thread_old_live", updatedAt: older });
    const newHistory = session({
      id: "codex_history_new",
      codexThreadId: "thread_history",
      updatedAt: newer,
    });

    expect(mergedSidebarSessions([oldLive], [newHistory]).map((item) => item.id)).toEqual([
      "codex_history_new",
      "session_old_live",
    ]);
  });

  test("merges Codex history goal metadata into duplicate live thread rows", () => {
    const live = session({
      id: "session_live",
      codexThreadId: "thread_shared",
      status: "idle",
      updatedAt: older,
    });
    const historyDuplicate = session({
      id: "codex_history_duplicate",
      codexThreadId: "thread_shared",
      status: "active",
      updatedAt: newer,
      metadata: {
        codexGoalRuntime: {
          provider: "codex",
          objective: "Keep working",
          status: "active",
          timeUsedSeconds: 1,
          tokensUsed: null,
          tokenBudget: null,
          updatedAt: newer,
        },
      },
    });

    const rows = mergedSidebarSessions([live], [historyDuplicate]);

    expect(rows.map((item) => item.id)).toEqual(["session_live"]);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.updatedAt).toBe(newer);
    expect(rows[0]?.metadata?.codexGoalRuntime).toMatchObject({
      objective: "Keep working",
      status: "active",
    });
  });
});
