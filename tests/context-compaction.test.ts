import { describe, expect, test } from "bun:test";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { runHostedContextCompaction } from "../apps/server/src/openpond/context-compaction";

const NOW = "2026-07-07T12:00:00.000Z";

describe("context compaction", () => {
  test("serializes subagent summaries and preserves child conversation refs", async () => {
    let serializedPrompt = "";
    const result = await runHostedContextCompaction({
      session: sessionFixture(),
      events: [
        runtimeEvent({
          id: "subagent_completed",
          sessionId: "session_parent",
          turnId: "turn_parent",
          name: "subagent.completed",
          status: "completed",
          output: "research subagent completed.",
          data: {
            run: subagentRunFixture(),
          },
        }),
      ],
      provider: "openrouter",
      model: "test/model",
      maxContextTokens: 2000,
      streamCompactionChatTurn: async function* (input) {
        serializedPrompt = String(input.messages.at(-1)?.content ?? "");
        yield { text: "Conversation summary with subagent evidence." };
      },
    });

    expect(serializedPrompt).toContain("### Subagent Activity");
    expect(serializedPrompt).toContain("run: subagent-run:run_research");
    expect(serializedPrompt).toContain("child session: session:child_research");
    expect(serializedPrompt).toContain("blockers: Waiting on approval");
    expect(serializedPrompt).toContain("usage: 42 tokens across 2 requests");
    expect(result.preservedResourceRefs).toContain("subagent-run:run_research");
    expect(result.preservedResourceRefs).toContain("session:child_research");
    expect(result.preservedResourceRefs).toContain("workspace:file:/repo/docs/agents.md");
    expect(result.summary).toBe("Conversation summary with subagent evidence.");
  });
});

function sessionFixture(): Session {
  return {
    id: "session_parent",
    provider: "openpond",
    title: "Parent chat",
    appId: null,
    appName: null,
    workspaceKind: "local",
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/repo",
    codexThreadId: null,
    createdAt: NOW,
    updatedAt: NOW,
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}

function runtimeEvent(input: Omit<RuntimeEvent, "timestamp">): RuntimeEvent {
  return {
    timestamp: NOW,
    ...input,
  };
}

function subagentRunFixture() {
  return {
    id: "run_research",
    parentSessionId: "session_parent",
    parentTurnId: "turn_parent",
    parentGoalId: "goal_1",
    childSessionId: "child_research",
    roleId: "research",
    objective: "Research subagent orchestration docs.",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    isolationMode: "none",
    toolPolicy: "read_only",
    background: true,
    peerMessages: "goal_scoped",
    status: "completed",
    required: true,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    error: null,
    report: {
      summary: "Found subagent docs and approval caveats.",
      findings: ["Child conversations need parent-visible receipts."],
      artifacts: [{ kind: "file", id: "/repo/docs/agents.md", label: "docs/agents.md" }],
      patchRef: null,
      diffRef: null,
      testsRun: ["bun test tests/context-compaction.test.ts"],
      blockers: ["Waiting on approval"],
      confidence: "high",
      followUpNeeded: false,
    },
    metadata: {
      usage: {
        totalTokens: 42,
        promptTokens: 30,
        completionTokens: 12,
        requestCount: 2,
      },
    },
  };
}
