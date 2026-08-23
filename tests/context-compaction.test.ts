import { describe, expect, test } from "vitest";
import type { RuntimeEvent, Session } from "@openpond/contracts";
import { runHostedContextCompaction } from "../apps/server/src/openpond/context-compaction/index";
import {
  normalizeCompactionRecords,
  serializeRecordsForCompaction,
} from "../apps/server/src/openpond/context-compaction/normalizer";
import { compactionInputCharBudget } from "../apps/server/src/openpond/context-compaction/prompt";
import { selectEventsForHostedCompaction } from "../apps/server/src/openpond/context-compaction/tail-selection";

const NOW = "2026-07-07T12:00:00.000Z";

describe("context compaction", () => {

  test("preserves sparse durable facts from the provider-backed long-history fixtures", () => {
    const factual = syntheticLongTurns("atlas", 26, (index) => [
      index === 1 ? "The Atlas service port is 4317." : "",
      index === 4 ? "The active branch is feat/atlas-ledger." : "",
      index === 7 ? "Irreversible constraint: never delete generated fixtures." : "",
      index === 10 ? "The older-history continuity code is CEDAR-91." : "",
      index === 25 ? "The next validation command is pnpm test:contract." : "",
    ].filter(Boolean).join(" "));
    const operational = syntheticLongTurns("cache-ledger", 22, (index) => [
      index === 2 ? "The active file is /synthetic/src/cache-ledger.ts." : "",
      index === 5 ? "Validation failed with E_CACHE_17." : "",
      index === 6 ? "Do not retry pnpm test cache-ledger until schema migration completes." : "",
      index === 9 ? "The operational continuity token is OPAL-63." : "",
      index === 21 ? "The next safe action is migrate schema v44." : "",
    ].filter(Boolean).join(" "));
    operational.splice(14, 0, runtimeEvent({
      id: "cache-ledger-command-failure",
      sessionId: "session-cache-ledger",
      turnId: "cache-ledger-turn-006",
      name: "command.output",
      action: "pnpm test cache-ledger",
      status: "failed",
      output: "E_CACHE_17: schema v44 has not been migrated; retry is blocked.",
    }));
    const orbit = syntheticLongTurns("orbit", 18, (index) => [
      index === 1 ? "The original Orbit project token is ORBIT-771." : "",
      index === 3 ? "The Orbit service port is 5902." : "",
      index === 6 ? "The first-stage continuity color is AMBER." : "",
    ].filter(Boolean).join(" "));

    const factualPreTail = serializedCompactionPreTail(factual);
    const operationalPreTail = serializedCompactionPreTail(operational);
    const orbitPreTail = serializedCompactionPreTail(orbit);

    expect(factualPreTail).toContain("4317");
    expect(factualPreTail).toContain("feat/atlas-ledger");
    expect(factualPreTail).toContain("CEDAR-91");
    expect(operationalPreTail).toContain("OPAL-63");
    expect(orbitPreTail).toContain("ORBIT-771");
    expect(orbitPreTail).toContain("5902");
    expect(orbitPreTail).toContain("AMBER");

    const records = normalizeCompactionRecords(factual);
    expect(records.find((record) => record.body.includes("4317"))?.durableFacts).toContainEqual({
      kind: "port",
      label: "The Atlas service port",
      value: "4317",
    });
    expect(records.find((record) => record.body.includes("feat/atlas-ledger"))?.durableFacts)
      .toContainEqual(expect.objectContaining({ kind: "branch", value: "feat/atlas-ledger" }));
    expect(records.find((record) => record.eventId === "atlas-turn-000-assistant")?.durableFacts).toEqual([]);
    const operationalRecords = normalizeCompactionRecords(operational);
    expect(operationalRecords.find((record) => record.body.includes("E_CACHE_17"))?.durableFacts)
      .toContainEqual(expect.objectContaining({ kind: "error_code", value: "E_CACHE_17" }));
  });

  test("selects newest useful records from oversized histories with explicit omission telemetry", () => {
    const events: RuntimeEvent[] = [
      runtimeEvent({
        id: "previous_compaction",
        sessionId: "session_parent",
        name: "session.compaction.completed",
        data: { summary: "durable previous summary marker" },
      }),
      runtimeEvent({
        id: "goal_context",
        sessionId: "session_parent",
        name: "session.goal.updated",
        data: { kind: "goal_context", goal: "ship the compaction source selector" },
      }),
      ...Array.from({ length: 400 }, (_, index) => runtimeEvent({
        id: `old_filler_${index}`,
        sessionId: "session_parent",
        turnId: `turn_old_${index}`,
        name: "assistant.delta",
        output: `old low-value filler ${index} ${"x".repeat(500)}`,
      })),
      runtimeEvent({
        id: "failed_validation",
        sessionId: "session_parent",
        turnId: "turn_latest",
        name: "command.output",
        status: "failed",
        action: "pnpm test compaction",
        output: "E_SOURCE_SELECTION: keep this unresolved failure",
      }),
      runtimeEvent({
        id: "latest_user",
        sessionId: "session_parent",
        turnId: "turn_latest",
        name: "turn.started",
        args: { prompt: "latest request: continue after fixing source selection" },
      }),
      runtimeEvent({
        id: "tool_started",
        sessionId: "session_parent",
        turnId: "turn_latest",
        name: "tool.started",
        action: "inspect_latest_state",
        data: { toolCallId: "call_latest" },
      }),
      runtimeEvent({
        id: "tool_completed",
        sessionId: "session_parent",
        turnId: "turn_latest",
        name: "tool.completed",
        action: "inspect_latest_state",
        output: "newest tool result marker",
        data: { toolCallId: "call_latest" },
      }),
    ];
    const records = normalizeCompactionRecords(events);
    const serialized = serializeRecordsForCompaction(records, 12_000);
    const repeated = serializeRecordsForCompaction(records, 12_000);

    expect(records.reduce((total, item) => total + item.body.length, 0)).toBeGreaterThan(180_000);
    expect(serialized).toEqual(repeated);
    expect(serialized.inputChars).toBe(serialized.text.length);
    expect(serialized.inputChars).toBeLessThanOrEqual(12_000);
    expect(serialized.sourceRecordCount).toBe(records.length);
    expect(serialized.includedRecordCount + serialized.omittedRecordCount).toBe(records.length);
    expect(serialized.omittedRecordCount).toBeGreaterThan(0);
    expect(serialized.inputTruncated).toBe(true);
    expect(serialized.selectionStrategy).toBe("newest_useful_v1");
    expect(serialized.text).toContain("durable previous summary marker");
    expect(serialized.text).toContain("ship the compaction source selector");
    expect(serialized.text).toContain("E_SOURCE_SELECTION");
    expect(serialized.text).toContain("latest request: continue after fixing source selection");
    expect(serialized.text).toContain("inspect_latest_state");
    expect(serialized.text).toContain("newest tool result marker");
    expect(serialized.text.indexOf("durable previous summary marker"))
      .toBeLessThan(serialized.text.indexOf("latest request: continue after fixing source selection"));
  });

  test("keeps tool invocation and result records atomic at every input budget", () => {
    const records = normalizeCompactionRecords([
      runtimeEvent({
        id: "atomic_started",
        sessionId: "session_parent",
        turnId: "turn_atomic",
        name: "tool.started",
        action: "atomic tool call marker",
        data: { toolCallId: "atomic_call" },
      }),
      runtimeEvent({
        id: "atomic_completed",
        sessionId: "session_parent",
        turnId: "turn_atomic",
        name: "tool.completed",
        output: "atomic tool result marker",
        data: { toolCallId: "atomic_call" },
      }),
    ]);
    const complete = serializeRecordsForCompaction(records, 12_000);

    for (let budget = 0; budget <= complete.inputChars + 10; budget += 13) {
      const serialized = serializeRecordsForCompaction(records, budget);
      expect(serialized.text.includes("atomic tool call marker"))
        .toBe(serialized.text.includes("atomic tool result marker"));
    }
  });

  test("reports individual record truncation separately from source omission", () => {
    const records = normalizeCompactionRecords([
      runtimeEvent({
        id: "large_record",
        sessionId: "session_parent",
        turnId: "turn_large",
        name: "assistant.delta",
        output: `large record marker ${"z".repeat(7_000)}`,
      }),
    ]);
    const serialized = serializeRecordsForCompaction(records, 12_000);

    expect(serialized).toMatchObject({
      sourceRecordCount: 1,
      includedRecordCount: 1,
      omittedRecordCount: 0,
      truncatedRecordCount: 1,
      inputTruncated: true,
    });
    expect(serialized.text).toContain("[record truncated]");
  });

  test("never splits an oversized tool call across the summary and retained tail", async () => {
    let serializedPrompt = "";
    const result = await runHostedContextCompaction({
      session: sessionFixture(),
      events: [
        runtimeEvent({
          id: "turn_old_atomic",
          sessionId: "session_parent",
          turnId: "turn_old_atomic",
          name: "turn.started",
          args: { prompt: "old request needed to make compaction eligible" },
        }),
        runtimeEvent({
          id: "assistant_old_atomic",
          sessionId: "session_parent",
          turnId: "turn_old_atomic",
          name: "assistant.delta",
          output: "old answer",
        }),
        runtimeEvent({
          id: "turn_latest_atomic",
          sessionId: "session_parent",
          turnId: "turn_latest_atomic",
          name: "turn.started",
          args: { prompt: "run the oversized atomic tool" },
        }),
        runtimeEvent({
          id: "oversized_tool_started",
          sessionId: "session_parent",
          turnId: "turn_latest_atomic",
          name: "tool.started",
          action: "oversized atomic invocation marker",
          data: { toolCallId: "oversized_atomic", payload: "q".repeat(20_000) },
        }),
        runtimeEvent({
          id: "oversized_tool_completed",
          sessionId: "session_parent",
          turnId: "turn_latest_atomic",
          name: "tool.completed",
          output: "oversized atomic result marker",
          data: { toolCallId: "oversized_atomic" },
        }),
      ],
      provider: "openrouter",
      model: "test/model",
      maxContextTokens: 1200,
      streamCompactionChatTurn: async function* (input) {
        serializedPrompt = String(input.messages.at(-1)?.content ?? "");
        yield { text: "Atomic tool summary." };
      },
    });

    expect(result.preservedEventIds.includes("oversized_tool_started"))
      .toBe(result.preservedEventIds.includes("oversized_tool_completed"));
    expect(serializedPrompt.includes("oversized atomic invocation marker"))
      .toBe(serializedPrompt.includes("oversized atomic result marker"));
    expect(serializedPrompt).toContain("oversized atomic invocation marker");
    expect(serializedPrompt).toContain("oversized atomic result marker");
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
    expect(result.metrics).toMatchObject({
      sourceRecords: 1,
      includedRecords: 1,
      omittedRecords: 0,
      preservedRecords: 0,
      truncatedRecords: 0,
      summaryInputTruncated: false,
      sourceSelectionStrategy: "newest_useful_v1",
    });
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

function syntheticLongTurns(
  prefix: string,
  count: number,
  factForTurn: (index: number) => string,
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const turnId = `${prefix}-turn-${String(index).padStart(3, "0")}`;
    events.push(runtimeEvent({
      id: `${turnId}-started`,
      sessionId: `session-${prefix}`,
      turnId,
      name: "turn.started",
      args: { prompt: `Review synthetic ${prefix} checkpoint ${index} and retain durable operational state.` },
    }));
    const filler = Array.from({ length: 9 }, (_, note) =>
      `Evidence ${index}.${note}: synthetic inspection completed without repository data; preserve decisions, failures, and next actions while discarding repetitive narration.`
    ).join(" ");
    events.push(runtimeEvent({
      id: `${turnId}-assistant`,
      sessionId: `session-${prefix}`,
      turnId,
      name: "assistant.delta",
      output: `${factForTurn(index)} ${filler}`.trim(),
    }));
  }
  return events;
}

function serializedCompactionPreTail(events: RuntimeEvent[]): string {
  const selection = selectEventsForHostedCompaction(events, 6_000);
  return serializeRecordsForCompaction(
    normalizeCompactionRecords(selection.summaryEvents),
    compactionInputCharBudget(6_000),
  ).text;
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
