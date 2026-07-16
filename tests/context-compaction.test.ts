import { describe, expect, test } from "vitest";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { runHostedContextCompaction } from "../apps/server/src/openpond/context-compaction/index";
import {
  normalizeCompactionRecords,
  serializeRecordsForCompaction,
} from "../apps/server/src/openpond/context-compaction/normalizer";

const NOW = "2026-07-07T12:00:00.000Z";

describe("context compaction", () => {
  test("normalizes key event fixtures into the legacy summary input shape", () => {
    const records = normalizeCompactionRecords([
      runtimeEvent({
        id: "context_skip",
        sessionId: "session_parent",
        name: "session.context.updated",
        data: { ignored: true },
      }),
      runtimeEvent({
        id: "compact_previous",
        sessionId: "session_parent",
        name: "session.compaction.completed",
        data: { summary: "Previous compacted goal." },
      }),
      runtimeEvent({
        id: "turn_fixture_started",
        sessionId: "session_parent",
        turnId: "turn_fixture",
        name: "turn.started",
        args: { prompt: "Implement compaction improvements." },
      }),
      runtimeEvent({
        id: "turn_fixture_assistant",
        sessionId: "session_parent",
        turnId: "turn_fixture",
        name: "assistant.delta",
        output: "Plan accepted.",
      }),
      runtimeEvent({
        id: "workspace_fixture",
        sessionId: "session_parent",
        turnId: "turn_fixture",
        name: "workspace_action_result",
        action: "read_file",
        status: "completed",
        output: "Read apps/server/src/openpond/context-compaction/index.ts",
      }),
      runtimeEvent({
        id: "tool_fixture",
        sessionId: "session_parent",
        turnId: "turn_fixture",
        name: "tool.completed",
        action: "pnpm test",
        status: "failed",
        error: "tests/context-compaction.test.ts failed: expected failure label",
      }),
      runtimeEvent({
        id: "goal_fixture",
        sessionId: "session_parent",
        turnId: "turn_fixture",
        name: "goal_context.updated",
        output: "Active compaction goal.",
        data: { kind: "thread_goal", objective: "Finish compaction phases." },
      }),
      runtimeEvent({
        id: "turn_fixture_failed",
        sessionId: "session_parent",
        turnId: "turn_fixture",
        name: "turn.failed",
        status: "failed",
        error: "Build failed in tests/context-compaction.test.ts",
      }),
      runtimeEvent({
        id: "diagnostic_skip",
        sessionId: "session_parent",
        name: "diagnostic",
        output: "skip diagnostics",
      }),
    ]);

    expect(records.map((record) => record.kind)).toEqual([
      "previous_summary",
      "user",
      "assistant",
      "workspace_activity",
      "tool_activity",
      "goal_context",
      "turn_failed",
    ]);
    expect(serializeRecordsForCompaction(records, 100_000).text).toBe([
      "### Previous Summary",
      "Previous compacted goal.",
      "",
      "### User (turn=turn_fixture)",
      "Implement compaction improvements.",
      "",
      "### Assistant (turn=turn_fixture)",
      "Plan accepted.",
      "",
      "### Workspace Activity (turn=turn_fixture action=read_file status=completed)",
      "Read apps/server/src/openpond/context-compaction/index.ts\nread_file",
      "",
      "### Tool Activity (turn=turn_fixture action=pnpm test status=failed)",
      "tests/context-compaction.test.ts failed: expected failure label\npnpm test",
      "",
      "### Goal Context (turn=turn_fixture)",
      "ref: goal-context:goal_fixture\nActive compaction goal.\n{\"kind\":\"thread_goal\",\"objective\":\"Finish compaction phases.\"}",
      "",
      "### Turn Failed (turn=turn_fixture status=failed)",
      "Build failed in tests/context-compaction.test.ts",
    ].join("\n"));
  });

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
    expect(result.metrics.summarizedEvents).toBe(1);
    expect(result.metrics.summaryInputChars).toBeGreaterThan(0);
    expect(result.metrics.fileLedgerEntries).toBeGreaterThan(0);
    expect(result.preservedEventIds).toEqual([]);
    expect(serializedPrompt).toContain("## Relevant Files");
    expect(serializedPrompt).toContain("docs/agents.md");
  });

  test("preserves recent turns by token budget and summarizes older turns", async () => {
    let serializedPrompt = "";
    const result = await runHostedContextCompaction({
      session: sessionFixture(),
      events: [
        runtimeEvent({
          id: "turn_old",
          sessionId: "session_parent",
          turnId: "turn_old",
          name: "turn.started",
          args: { prompt: "old request that should be summarized" },
        }),
        runtimeEvent({
          id: "assistant_old",
          sessionId: "session_parent",
          turnId: "turn_old",
          name: "assistant.delta",
          output: "old answer that mentioned apps/server/src/openpond/context-compaction/index.ts",
        }),
        runtimeEvent({
          id: "turn_recent_a",
          sessionId: "session_parent",
          turnId: "turn_recent_a",
          name: "turn.started",
          args: { prompt: "recent request A should stay verbatim" },
        }),
        runtimeEvent({
          id: "assistant_recent_a",
          sessionId: "session_parent",
          turnId: "turn_recent_a",
          name: "assistant.delta",
          output: "recent answer A",
        }),
        runtimeEvent({
          id: "turn_recent_b",
          sessionId: "session_parent",
          turnId: "turn_recent_b",
          name: "turn.started",
          args: { prompt: "recent request B should stay verbatim" },
        }),
        runtimeEvent({
          id: "assistant_recent_b",
          sessionId: "session_parent",
          turnId: "turn_recent_b",
          name: "assistant.delta",
          output: "recent answer B",
        }),
      ],
      provider: "openrouter",
      model: "test/model",
      maxContextTokens: 8000,
      streamCompactionChatTurn: async function* (input) {
        serializedPrompt = String(input.messages.at(-1)?.content ?? "");
        yield { text: "Older context summary." };
      },
    });

    expect(serializedPrompt).toContain("old request that should be summarized");
    expect(serializedPrompt).not.toContain("recent request B should stay verbatim");
    expect(result.preservedEventIds).toContain("turn_recent_a");
    expect(result.preservedEventIds).toContain("assistant_recent_b");
    expect(result.preservedEventIds).not.toContain("turn_old");
    expect(result.metrics.retainedTailTokens).toBeGreaterThan(0);
    expect(result.metrics.retainedTailBudgetTokens).toBeGreaterThan(0);
    expect(result.metrics.finalProviderContextTokens).toBe(result.inputTokensAfter);
  });

  test("splits an oversized latest turn by preserving only a suffix", async () => {
    const largeOutput = "large command output line\n".repeat(1800);
    const result = await runHostedContextCompaction({
      session: sessionFixture(),
      events: [
        runtimeEvent({
          id: "turn_old",
          sessionId: "session_parent",
          turnId: "turn_old",
          name: "turn.started",
          args: { prompt: "old request" },
        }),
        runtimeEvent({
          id: "assistant_old",
          sessionId: "session_parent",
          turnId: "turn_old",
          name: "assistant.delta",
          output: "old answer",
        }),
        runtimeEvent({
          id: "turn_huge",
          sessionId: "session_parent",
          turnId: "turn_huge",
          name: "turn.started",
          args: { prompt: "huge latest request" },
        }),
        runtimeEvent({
          id: "tool_huge",
          sessionId: "session_parent",
          turnId: "turn_huge",
          name: "command.output",
          output: largeOutput,
        }),
        runtimeEvent({
          id: "assistant_final",
          sessionId: "session_parent",
          turnId: "turn_huge",
          name: "assistant.delta",
          output: "latest final answer survives",
        }),
      ],
      provider: "openrouter",
      model: "test/model",
      maxContextTokens: 1200,
      streamCompactionChatTurn: async function* () {
        yield { text: "Split turn summary." };
      },
    });

    expect(result.metrics.splitTurnId).toBe("turn_huge");
    expect(result.preservedEventIds).toContain("turn_huge");
    expect(result.preservedEventIds).toContain("assistant_final");
    expect(result.preservedEventIds).not.toContain("tool_huge");
  });

  test("preserves recent unresolved failures and records exact ledger failure labels", async () => {
    let serializedPrompt = "";
    const result = await runHostedContextCompaction({
      session: sessionFixture(),
      events: [
        runtimeEvent({
          id: "turn_old",
          sessionId: "session_parent",
          turnId: "turn_old",
          name: "turn.started",
          args: { prompt: "old request" },
        }),
        runtimeEvent({
          id: "assistant_old",
          sessionId: "session_parent",
          turnId: "turn_old",
          name: "assistant.delta",
          output: "old answer",
        }),
        runtimeEvent({
          id: "turn_failed_started",
          sessionId: "session_parent",
          turnId: "turn_failed",
          name: "turn.started",
          args: { prompt: "run failing validation" },
        }),
        runtimeEvent({
          id: "turn_failed_output",
          sessionId: "session_parent",
          turnId: "turn_failed",
          name: "command.output",
          action: "pnpm test tests/context-compaction.test.ts",
          status: "failed",
          output: `FAIL tests/context-compaction.test.ts: expected failure label\n${"failure context ".repeat(2500)}`,
        }),
        runtimeEvent({
          id: "turn_failed_terminal",
          sessionId: "session_parent",
          turnId: "turn_failed",
          name: "turn.failed",
          status: "failed",
          error: "FAIL tests/context-compaction.test.ts: expected failure label",
        }),
        runtimeEvent({
          id: "turn_latest",
          sessionId: "session_parent",
          turnId: "turn_latest",
          name: "turn.started",
          args: { prompt: "latest request" },
        }),
        runtimeEvent({
          id: "assistant_latest",
          sessionId: "session_parent",
          turnId: "turn_latest",
          name: "assistant.delta",
          output: "latest answer",
        }),
      ],
      provider: "openrouter",
      model: "test/model",
      maxContextTokens: 1200,
      streamCompactionChatTurn: async function* (input) {
        serializedPrompt = String(input.messages.at(-1)?.content ?? "");
        yield { text: "Failure-aware summary." };
      },
    });

    expect(result.preservedEventIds).toContain("turn_failed_started");
    expect(result.preservedEventIds).toContain("turn_failed_output");
    expect(result.preservedEventIds).toContain("turn_failed_terminal");
    expect(serializedPrompt).toContain("## Relevant Files");
    expect(serializedPrompt).toContain("expected failure label");
    expect(result.fileLedger).toContainEqual(expect.objectContaining({
      path: "tests/context-compaction.test.ts",
      latestStatus: "failed",
      relevance: "failed",
      failure: "FAIL tests/context-compaction.test.ts: expected failure label",
    }));
    expect(result.fileLedger.find((entry) => entry.path === "tests/context-compaction.test.ts")?.operations).toEqual(
      expect.arrayContaining(["validation", "failure"]),
    );
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
      testsRun: ["pnpm test tests/context-compaction.test.ts"],
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
