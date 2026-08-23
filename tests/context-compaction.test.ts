import { describe, expect, test } from "vitest";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { runHostedContextCompaction } from "../apps/server/src/openpond/context-compaction/index";
import {
  normalizeCompactionRecords,
  serializeRecordsForCompaction,
} from "../apps/server/src/openpond/context-compaction/normalizer";

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

  test("carries exact operational state through two continuation capsules", async () => {
    const firstEvents = [
      runtimeEvent({
        id: "turn_operational_old",
        sessionId: "session_parent",
        turnId: "turn_operational_old",
        name: "turn.started",
        args: { prompt: "Repair the cache ledger without deleting generated fixtures." },
      }),
      runtimeEvent({
        id: "assistant_operational_old",
        sessionId: "session_parent",
        turnId: "turn_operational_old",
        name: "assistant.delta",
        output: "The active file is /repo/src/cache-ledger.ts. Never delete generated fixtures.",
      }),
      runtimeEvent({
        id: "turn_operational_failed",
        sessionId: "session_parent",
        turnId: "turn_operational_failed",
        name: "turn.started",
        args: { prompt: "Run the cache ledger validation." },
      }),
      runtimeEvent({
        id: "command_operational_failed",
        sessionId: "session_parent",
        turnId: "turn_operational_failed",
        name: "command.output",
        action: "pnpm test cache-ledger",
        status: "failed",
        output: "E_CACHE_17: schema v44 is missing. Do not retry pnpm test cache-ledger until schema v44 is migrated.",
      }),
      runtimeEvent({
        id: "turn_operational_latest",
        sessionId: "session_parent",
        turnId: "turn_operational_latest",
        name: "turn.started",
        args: { prompt: "Continue safely from the failed validation." },
      }),
      runtimeEvent({
        id: "assistant_operational_latest",
        sessionId: "session_parent",
        turnId: "turn_operational_latest",
        name: "assistant.delta",
        output: "The immediate next action is migrate schema v44.",
      }),
    ];
    const first = await runHostedContextCompaction({
      session: sessionFixture(),
      events: firstEvents,
      provider: "openrouter",
      model: "test/model",
      maxContextTokens: 1200,
      streamCompactionChatTurn: async function* () {
        yield {
          text: [
            "## Goal",
            "- Repair the cache ledger safely.",
            "## Constraints & Preferences",
            "- Never delete generated fixtures.",
            "## Key Decisions",
            "- Migrate the schema before retrying validation.",
            "## Next Steps",
            "- migrate schema v44",
          ].join("\n"),
        };
      },
    });

    expect(first.continuationCapsule).toMatchObject({
      schemaVersion: "openpond.continuation.v1",
      currentGoal: "Repair the cache ledger safely.",
      constraints: ["Never delete generated fixtures."],
      activeFiles: expect.arrayContaining([
        expect.objectContaining({ path: "/repo/src/cache-ledger.ts" }),
      ]),
      blockedActions: [expect.objectContaining({
        action: "pnpm test cache-ledger",
        error: expect.stringContaining("E_CACHE_17"),
        retryCondition: "until schema v44 is migrated",
      })],
      validations: [expect.objectContaining({
        action: "pnpm test cache-ledger",
        status: "failed",
      })],
      immediateNextActions: expect.arrayContaining(["migrate schema v44"]),
    });
    expect(first.metrics.finalProviderContextTokens).toBe(first.inputTokensAfter);

    const firstCompletion = runtimeEvent({
      id: "compaction_operational_first",
      sessionId: "session_parent",
      turnId: "turn_operational_latest",
      name: "session.compaction.completed",
      status: "completed",
      data: {
        summary: first.summary,
        continuationCapsule: first.continuationCapsule,
        preservedFromEventId: first.preservedFromEventId,
        preservedEventIds: first.preservedEventIds,
        preservedResourceRefs: first.preservedResourceRefs,
      },
    });
    const second = await runHostedContextCompaction({
      session: sessionFixture(),
      events: [
        ...firstEvents,
        firstCompletion,
        runtimeEvent({
          id: "turn_after_first_compaction",
          sessionId: "session_parent",
          turnId: "turn_after_first_compaction",
          name: "turn.started",
          args: { prompt: "Keep the validation blocked and prepare the migration." },
        }),
        runtimeEvent({
          id: "assistant_after_first_compaction",
          sessionId: "session_parent",
          turnId: "turn_after_first_compaction",
          name: "assistant.delta",
          output: "The next step is update /repo/src/schema-v44.ts.",
        }),
      ],
      provider: "openrouter",
      model: "test/model",
      maxContextTokens: 1200,
      streamCompactionChatTurn: async function* () {
        yield {
          text: [
            "## Goal",
            "- Complete the schema migration safely.",
            "## Constraints & Preferences",
            "- Never delete generated fixtures.",
            "## Key Decisions",
            "- Keep cache-ledger validation blocked until migration completes.",
            "## Next Steps",
            "- update /repo/src/schema-v44.ts",
          ].join("\n"),
        };
      },
    });

    expect(second.continuationCapsule.activeFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/repo/src/cache-ledger.ts" }),
      expect.objectContaining({ path: "/repo/src/schema-v44.ts" }),
    ]));
    expect(second.continuationCapsule.blockedActions).toEqual([
      expect.objectContaining({
        action: "pnpm test cache-ledger",
        retryCondition: "until schema v44 is migrated",
      }),
    ]);
    expect(second.continuationCapsule.immediateNextActions).toContain("update /repo/src/schema-v44.ts");
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
    childSessionId: "child_research",
    roleId: "research",
    objective: "Research subagent orchestration docs.",
    modelRef: { providerId: "openrouter", modelId: "test/model" },
    isolationMode: "none",
    toolPolicy: "read_only",
    background: true,
    peerMessages: "parent_scoped",
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
