import { describe, expect, test } from "bun:test";
import type { Session } from "@openpond/contracts";

import {
  appendSubagentRightChatPanels,
  newlyObservedSubagentSessions,
} from "../apps/web/src/lib/right-chat-panels";

describe("right chat panels", () => {
  test("detects only newly streamed subagent child sessions", () => {
    const existing = childSession("child_existing", "parent_1");
    const spawned = childSession("child_spawned", "parent_1");
    const regular = session({ id: "regular", parentSessionId: null, subagentRunId: null });

    const observed = newlyObservedSubagentSessions({
      sessions: [existing, spawned, regular],
      knownSessionIds: new Set([existing.id]),
    });

    expect(observed.newSessions.map((item) => item.id)).toEqual([spawned.id]);
    expect([...observed.knownSessionIds]).toEqual([existing.id, spawned.id]);
  });

  test("adds every spawned child once as a stable right-sidebar chat tab", () => {
    const first = childSession("child_1", "parent_1");
    const second = childSession("child_2", "parent_1");
    const panels = appendSubagentRightChatPanels([], [first, second]);

    expect(panels).toHaveLength(2);
    expect(panels.map((panel) => panel.id)).toEqual([
      "right-subagent-child_1",
      "right-subagent-child_2",
    ]);
    expect(panels.map((panel) => panel.sessionId)).toEqual([first.id, second.id]);
    expect(appendSubagentRightChatPanels(panels, [first])).toBe(panels);
  });
});

function childSession(id: string, parentSessionId: string): Session {
  return session({
    id,
    parentSessionId,
    subagentRunId: `run_${id}`,
    subagentRoleId: "research",
    title: `Research: ${id}`,
  });
}

function session(overrides: Partial<Session>): Session {
  return {
    id: "session_1",
    provider: "openai",
    modelRef: { providerId: "openai", modelId: "gpt-5.6-sol" },
    openPondCommandAccessMode: "full",
    title: "Session",
    appId: null,
    appName: null,
    cwd: null,
    codexThreadId: null,
    createdAt: "2026-07-09T20:00:00.000Z",
    updatedAt: "2026-07-09T20:00:00.000Z",
    status: "active",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}
