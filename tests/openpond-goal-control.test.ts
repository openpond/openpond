import { describe, expect, test } from "bun:test";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { runOpenPondGoalControl } from "../apps/server/src/openpond/goal-control";

describe("OpenPond goal control facade", () => {
  test("starts a new local goal from session context", () => {
    const result = runOpenPondGoalControl({
      session: baseSession({ workspaceKind: "local_project", cwd: "/repo" }),
      events: [],
      request: {
        action: "start",
        objective: "Ship capability tools.",
        mode: "auto",
        reason: "User asked OpenPond to pursue durable work.",
      },
      now: "2026-07-03T10:00:00.000Z",
    });

    expect(result).toMatchObject({
      action: "start",
      mode: "local",
      status: "queued",
      nextStep: "OpenPond goal queued.",
      goal: {
        provider: "openpond",
        status: "queued",
        objective: "Ship capability tools.",
        mode: "local",
        controlAction: "start",
        previousStatus: null,
      },
    });
    expect(result.goal.id).toMatch(/^goal_/);
  });

  test("pauses, resumes, and stops the targeted OpenPond goal", () => {
    const events = [
      threadGoalEvent({
        id: "goal_1",
        objective: "Ship capability tools.",
        status: "running",
        mode: "local",
      }),
    ];
    const session = baseSession({ workspaceKind: "local_project", cwd: "/repo" });

    const paused = runOpenPondGoalControl({
      session,
      events,
      request: {
        action: "pause",
        targetGoalId: "goal_1",
        reason: "User asked to pause.",
      },
      now: "2026-07-03T10:01:00.000Z",
    });
    expect(paused.goal).toMatchObject({
      id: "goal_1",
      status: "paused",
      previousStatus: "running",
      controlAction: "pause",
    });

    const resumed = runOpenPondGoalControl({
      session,
      events: [...events, threadGoalEvent(paused.goal)],
      request: {
        action: "resume",
        targetGoalId: "goal_1",
        reason: "User asked to resume.",
      },
      now: "2026-07-03T10:02:00.000Z",
    });
    expect(resumed.goal).toMatchObject({
      id: "goal_1",
      status: "queued",
      previousStatus: "paused",
      controlAction: "resume",
    });

    const stopped = runOpenPondGoalControl({
      session,
      events: [...events, threadGoalEvent(resumed.goal)],
      request: {
        action: "stop",
        targetGoalId: "goal_1",
        reason: "User asked to stop.",
      },
      now: "2026-07-03T10:03:00.000Z",
    });
    expect(stopped.goal).toMatchObject({
      id: "goal_1",
      status: "cancelled",
      previousStatus: "queued",
      controlAction: "stop",
    });
  });

  test("resolves remote mode from cloud workspace context", () => {
    const result = runOpenPondGoalControl({
      session: baseSession({ workspaceKind: "sandbox", workspaceId: "sandbox_1" }),
      events: [],
      request: {
        action: "start",
        objective: "Run the hosted goal.",
        mode: "auto",
        reason: "User asked for hosted work.",
      },
      now: "2026-07-03T10:00:00.000Z",
    });

    expect(result.mode).toBe("remote");
    expect(result.goal.mode).toBe("remote");
  });

  test("resolves remote mode from Hybrid workspace metadata", () => {
    const result = runOpenPondGoalControl({
      session: baseSession({
        workspaceKind: "sandbox",
        workspaceId: "sandbox_hybrid",
        metadata: { workspaceTarget: "hybrid" },
      }),
      events: [],
      request: {
        action: "start",
        objective: "Run the Hybrid goal.",
        mode: "auto",
        reason: "User asked for Hybrid work.",
      },
      now: "2026-07-03T10:00:00.000Z",
    });

    expect(result.mode).toBe("remote");
    expect(result.goal.mode).toBe("remote");
  });
});

function threadGoalEvent(goal: Record<string, unknown>): RuntimeEvent {
  return {
    id: `event_${String(goal.id ?? "goal")}`,
    sessionId: "session_1",
    turnId: "turn_1",
    name: "diagnostic",
    timestamp: "2026-07-03T10:00:00.000Z",
    source: "provider",
    status: "completed",
    output: String(goal.objective ?? "Goal"),
    data: {
      kind: "thread_goal",
      provider: "openpond",
      goal,
    },
  };
}

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    title: "Goal control chat",
    appId: null,
    appName: null,
    workspaceKind: undefined,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-07-03T10:00:00.000Z",
    updatedAt: "2026-07-03T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
