import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { useRunningSessionState } from "../apps/web/src/hooks/useRunningSessionState";
import { buildRuntimeIndexes, latestGoalRuntimeForSession } from "../apps/web/src/lib/runtime-indexes";

const NOW = "2026-07-02T12:00:00.000Z";

describe("running session state", () => {
  test("does not expose Insights system goals as user-interruptible running sessions", () => {
    const insightsSession = session({
      id: "insights_session",
      status: "active",
      systemKind: "openpond.insights",
      hiddenFromDefaultSidebar: true,
    });
    const indexes = buildRuntimeIndexes([activeGoalEvent(insightsSession.id)], []);

    const html = renderRunningProbe(insightsSession, [insightsSession], indexes);

    expect(html).toContain("selected=false");
    expect(html).toContain("running=");
    expect(html).not.toContain("insights_session");
  });

  test("keeps normal active goal chats in the running set", () => {
    const chatSession = session({ id: "chat_session", status: "idle" });
    const indexes = buildRuntimeIndexes([activeGoalEvent(chatSession.id)], []);

    const html = renderRunningProbe(chatSession, [chatSession], indexes);

    expect(html).toContain("selected=true");
    expect(html).toContain("running=chat_session");
  });
});

function renderRunningProbe(
  selectedSession: Session,
  sidebarSessions: Session[],
  runtimeIndexes: ReturnType<typeof buildRuntimeIndexes>,
): string {
  return renderToStaticMarkup(
    createElement(RunningProbe, {
      selectedSession,
      sidebarSessions,
      runtimeIndexes,
    }),
  );
}

function RunningProbe({
  selectedSession,
  sidebarSessions,
  runtimeIndexes,
}: {
  selectedSession: Session;
  sidebarSessions: Session[];
  runtimeIndexes: ReturnType<typeof buildRuntimeIndexes>;
}) {
  const state = useRunningSessionState({
    goalRuntime: latestGoalRuntimeForSession(runtimeIndexes, selectedSession.id),
    runtimeIndexes,
    selectedSession,
    selectedSessionId: selectedSession.id,
    sidebarSessions,
  });
  return createElement(
    "pre",
    null,
    `selected=${state.selectedSessionRunning};running=${Array.from(state.runningSessionIds).join(",")}`,
  );
}

function activeGoalEvent(sessionId: string): RuntimeEvent {
  return {
    id: `${sessionId}_goal`,
    sessionId,
    name: "diagnostic",
    timestamp: NOW,
    source: "server",
    status: "completed",
    data: {
      kind: "thread_goal",
      goal: {
        id: `${sessionId}_goal`,
        objective: "Review recent activity.",
        status: "active",
        timeUsedSeconds: 10,
      },
    },
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openpond",
    modelRef: null,
    systemKind: null,
    hiddenFromDefaultSidebar: false,
    title: "Chat",
    appId: null,
    appName: null,
    workspaceKind: "local",
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/workspace",
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
