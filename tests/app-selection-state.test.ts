import { describe, expect, test } from "vitest";
import type { AccountState, Session } from "@openpond/contracts";
import {
  mergedSidebarSessions,
  sessionsForOpenPondWorkspace,
} from "../apps/web/src/hooks/useAppSelectionState";

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

function account(active: "personal" | "team"): AccountState {
  const usage = {
    scope: "workspace" as const,
    limitsScope: "workspace" as const,
    periodStart: "2026-08-01T00:00:00.000Z",
    sandbox: { hours: 0, retailUsd: null, includedHours: 5, maxConcurrent: 1 },
    opChat: { tokens: 0, includedTokens: 1_000 },
    search: { calls: 0, includedCalls: 10 },
    personalizedInference: { requests: 0, includedRequests: 10 },
    totalRetailUsd: null,
  };
  const personal = {
    id: "personal_ada",
    type: "personal" as const,
    displayName: "Personal",
    role: "owner" as const,
    isBillingAdmin: true,
    canManageBilling: true,
    planKey: "free",
    accessState: "active",
    usage,
  };
  const team = {
    ...personal,
    id: "team_engine",
    type: "team" as const,
    displayName: "Engine",
  };
  return {
    state: "signed_in",
    activeProfile: { handle: "ada", baseUrl: null },
    label: "Ada",
    email: "ada@example.com",
    avatarUrl: null,
    environment: "staging",
    baseUrl: null,
    apiBaseUrl: "https://api.example.test",
    chatApiBaseUrl: "https://api.example.test/opchat/v1",
    creditsLabel: null,
    profile: {
      id: "user_ada",
      email: "ada@example.com",
      name: "Ada",
      handle: "ada",
      image: null,
      timezone: "UTC",
      isAdmin: false,
      isVerified: true,
      dailyAgentAppId: null,
      dailyAgentDeploymentId: null,
      credits: null,
    },
    products: [],
    workspaces: {
      personal,
      team,
      activeWorkspace: active === "personal"
        ? { id: personal.id, type: "personal" }
        : { id: team.id, type: "team" },
      hasMembershipConflict: false,
    },
    apiHealth: null,
    accounts: [],
    error: null,
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

  test("keeps legacy chats Personal and partitions bound chats by active workspace", () => {
    const legacy = session({ id: "legacy", codexThreadId: "legacy_thread" });
    const personal = session({
      id: "personal",
      codexThreadId: "personal_thread",
      openPondAccountId: "user_ada",
      openPondWorkspaceId: "personal_ada",
      openPondWorkspaceType: "personal",
    });
    const team = session({
      id: "team",
      codexThreadId: "team_thread",
      openPondAccountId: "user_ada",
      openPondWorkspaceId: "team_engine",
      openPondWorkspaceType: "team",
    });
    const anotherAccount = session({
      id: "other",
      codexThreadId: "other_thread",
      openPondAccountId: "user_other",
      openPondWorkspaceId: "personal_other",
      openPondWorkspaceType: "personal",
    });

    expect(
      sessionsForOpenPondWorkspace([legacy, personal, team, anotherAccount], account("personal"))
        .map((item) => item.id),
    ).toEqual(["legacy", "personal"]);
    expect(
      sessionsForOpenPondWorkspace([legacy, personal, team, anotherAccount], account("team"))
        .map((item) => item.id),
    ).toEqual(["team"]);
  });
});
