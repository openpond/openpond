import { describe, expect, test } from "vitest";
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

  test("uses sidebar goal runtime map for provider-independent running goals", () => {
    const chatSession = session({ id: "chat_session", status: "idle" });
    const indexes = buildRuntimeIndexes([], []);
    const goalRuntimeBySessionId = new Map([
      [
        chatSession.id,
        {
          objective: "Keep working",
          status: "running",
          timeUsedSeconds: 4,
          tokensUsed: null,
          tokenBudget: null,
          actionLabel: "Pursuing goal",
          timeLabel: "4s",
          label: "Goal 4s",
          detail: "Running",
          tooltip: "Goal runtime: 4 seconds. Running. Keep working",
          tone: "active" as const,
        },
      ],
    ]);

    const html = renderRunningProbe(chatSession, [chatSession], indexes, goalRuntimeBySessionId);

    expect(html).toContain("selected=true");
    expect(html).toContain("running=chat_session");
  });

  test("keeps active sessions visible as running when their events are not loaded", () => {
    const chatSession = session({ id: "chat_session", status: "active" });
    const otherSession = session({ id: "other_session", status: "idle" });
    const indexes = buildRuntimeIndexes([], []);

    const activeHtml = renderRunningProbe(chatSession, [chatSession, otherSession], indexes);
    const otherHtml = renderRunningProbe(otherSession, [chatSession, otherSession], indexes);

    expect(activeHtml).toContain("selected=false");
    expect(activeHtml).toContain("running=chat_session");
    expect(otherHtml).toContain("selected=false");
    expect(otherHtml).toContain("running=chat_session");
  });

  test("does not treat active session status alone as a selected running turn when loaded events are terminal", () => {
    const chatSession = session({ id: "chat_session", status: "active" });
    const otherSession = session({ id: "other_session", status: "idle" });
    const indexes = buildRuntimeIndexes(
      [turnStartedEvent(chatSession.id), turnCompletedEvent(chatSession.id)],
      [],
    );

    const activeHtml = renderRunningProbe(chatSession, [chatSession, otherSession], indexes);
    const otherHtml = renderRunningProbe(otherSession, [chatSession, otherSession], indexes);

    expect(activeHtml).toContain("selected=false");
    expect(activeHtml).toContain("running=");
    expect(activeHtml).not.toContain("chat_session");
    expect(otherHtml).toContain("selected=false");
    expect(otherHtml).toContain("running=");
    expect(otherHtml).not.toContain("chat_session");
  });

  test("keeps active sessions with pending turns in the running set", () => {
    const chatSession = session({ id: "chat_session", status: "active" });
    const indexes = buildRuntimeIndexes([turnStartedEvent(chatSession.id)], []);

    const html = renderRunningProbe(chatSession, [chatSession], indexes);

    expect(html).toContain("selected=true");
    expect(html).toContain("running=chat_session");
  });

  test("keeps active chats running when the bounded event window starts after turn.started", () => {
    const chatSession = session({ id: "chat_session", status: "active" });
    const indexes = buildRuntimeIndexes([assistantDeltaEvent(chatSession.id)], []);

    const html = renderRunningProbe(chatSession, [chatSession], indexes);

    expect(html).toContain("selected=true");
    expect(html).toContain("running=chat_session");
  });

  test("does not revive active status when the bounded event window contains a terminal turn", () => {
    const chatSession = session({ id: "chat_session", status: "active" });
    const indexes = buildRuntimeIndexes([turnCompletedEvent(chatSession.id)], []);

    const html = renderRunningProbe(chatSession, [chatSession], indexes);

    expect(html).toContain("selected=false");
    expect(html).toContain("running=");
    expect(html).not.toContain("running=chat_session");
  });

  test("uses newer deltas as evidence of a current turn after an older terminal event", () => {
    const chatSession = session({ id: "chat_session", status: "active" });
    const indexes = buildRuntimeIndexes(
      [turnCompletedEvent(chatSession.id), assistantDeltaEvent(chatSession.id, "current")],
      [],
    );

    const html = renderRunningProbe(chatSession, [chatSession], indexes);

    expect(html).toContain("selected=true");
    expect(html).toContain("running=chat_session");
  });

  test("uses a newer terminal event over earlier truncated-window activity", () => {
    const chatSession = session({ id: "chat_session", status: "active" });
    const indexes = buildRuntimeIndexes(
      [assistantDeltaEvent(chatSession.id, "previous"), turnCompletedEvent(chatSession.id)],
      [],
    );

    const html = renderRunningProbe(chatSession, [chatSession], indexes);

    expect(html).toContain("selected=false");
    expect(html).not.toContain("running=chat_session");
  });
});

function renderRunningProbe(
  selectedSession: Session,
  sidebarSessions: Session[],
  runtimeIndexes: ReturnType<typeof buildRuntimeIndexes>,
  goalRuntimeBySessionId?: Parameters<typeof useRunningSessionState>[0]["goalRuntimeBySessionId"],
): string {
  return renderToStaticMarkup(
    createElement(RunningProbe, {
      goalRuntimeBySessionId,
      selectedSession,
      sidebarSessions,
      runtimeIndexes,
    }),
  );
}

function RunningProbe({
  goalRuntimeBySessionId,
  selectedSession,
  sidebarSessions,
  runtimeIndexes,
}: {
  goalRuntimeBySessionId?: Parameters<typeof useRunningSessionState>[0]["goalRuntimeBySessionId"];
  selectedSession: Session;
  sidebarSessions: Session[];
  runtimeIndexes: ReturnType<typeof buildRuntimeIndexes>;
}) {
  const state = useRunningSessionState({
    goalRuntime: latestGoalRuntimeForSession(runtimeIndexes, selectedSession.id),
    goalRuntimeBySessionId,
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

function turnStartedEvent(sessionId: string): RuntimeEvent {
  return {
    id: `${sessionId}_turn_started`,
    sessionId,
    turnId: `${sessionId}_turn`,
    name: "turn.started",
    timestamp: NOW,
    source: "chat_action",
    status: "started",
  };
}

function turnCompletedEvent(sessionId: string): RuntimeEvent {
  return {
    id: `${sessionId}_turn_completed`,
    sessionId,
    turnId: `${sessionId}_turn`,
    name: "turn.completed",
    timestamp: NOW,
    source: "server",
    status: "completed",
  };
}

function assistantDeltaEvent(sessionId: string, suffix = "delta"): RuntimeEvent {
  return {
    id: `${sessionId}_${suffix}`,
    sessionId,
    name: "assistant.delta",
    timestamp: NOW,
    source: "provider",
    output: "Working",
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
