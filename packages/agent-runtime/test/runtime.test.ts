import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import {
  canonicalHash,
  agentCompactionDecision,
  createAgentRuntimeService,
  createAgentToolCatalog,
  createAgentToolCatalogProjection,
  executeAgentTool,
  executeProjectedAgentTool,
  materializeAgentPrompt,
  providerRoundSequence,
  runProviderRound,
  runProviderRoundLoop,
  runAgentCompaction,
  runAgentCompactionProgram,
} from "../src/index.js";

describe("@openpond/agent-runtime", () => {
  test("hashes recursively sorted JSON deterministically", () => {
    expect(canonicalHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  test("derives model tools, execution, UI capabilities, and one catalog hash", async () => {
    const execute = vi.fn(async (input: { path: string }) => `read:${input.path}`);
    const catalog = createAgentToolCatalog([
      {
        name: "read_file",
        description: "Read one file",
        displayLabel: "Read file",
        placement: "local",
        inputSchema: z.object({ path: z.string() }),
        execute
      },
      {
        name: "connected_app",
        description: "Call a connected app",
        placement: "managed",
        inputSchema: z.object({}),
        unavailableReason: "not authorized"
      }
    ]);
    expect(catalog.modelTools.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(catalog.capabilities).toEqual([
      expect.objectContaining({ name: "connected_app", available: false }),
      expect.objectContaining({ name: "read_file", available: true })
    ]);
    expect(catalog.hash).toMatch(/^[a-f0-9]{64}$/);
    const signal = new AbortController().signal;
    await expect(executeAgentTool(catalog, {
      name: "read_file",
      arguments: { path: "README.md" },
      context: { threadId: "thread", turnId: "turn", callId: "call", signal }
    })).resolves.toBe("read:README.md");
    expect(execute).toHaveBeenCalledOnce();
  });

  test("owns provider round identity and interruption boundaries", async () => {
    const controller = new AbortController();
    const rounds = providerRoundSequence({ turnId: "turn-1", maxRounds: 3, signal: controller.signal });
    await expect(rounds.next()).resolves.toEqual({
      done: false,
      value: { index: 0, requestId: "turn-1:model:0", signal: controller.signal }
    });
    controller.abort(new Error("stop"));
    await expect(rounds.next()).rejects.toThrow("stop");
  });

  test("makes projected JSON-schema catalogs executable through the same admitted registry", async () => {
    const execute = vi.fn(async (input: unknown) => input);
    const catalog = createAgentToolCatalogProjection([
      {
        name: "read_resource",
        description: "Read a resource",
        inputSchema: { type: "object", properties: { ref: { type: "string" } } },
        placement: "local",
        executorAvailable: true,
        validateArguments: (input) => z.object({ ref: z.string() }).parse(input),
        execute,
      },
    ]);

    await expect(executeProjectedAgentTool(catalog, {
      name: "read_resource",
      arguments: { ref: "workspace:README.md" },
      context: {
        threadId: "thread",
        turnId: "turn",
        callId: "call",
        signal: new AbortController().signal,
      },
    })).resolves.toEqual({ ref: "workspace:README.md" });
    expect(catalog.modelTools[0]?.inputSchema).toEqual(
      expect.objectContaining({ type: "object" }),
    );
  });

  test("owns provider loop completion and exhaustion", async () => {
    const signal = new AbortController().signal;
    const visited: number[] = [];
    await expect(runProviderRoundLoop({
      turnId: "turn-1",
      maxRounds: 3,
      signal,
      runRound: async (round) => {
        visited.push(round.index);
        return round.index === 1
          ? { type: "complete", result: "done" }
          : { type: "continue" };
      },
      onExhausted: async () => "exhausted",
    })).resolves.toBe("done");
    expect(visited).toEqual([0, 1]);

    await expect(runProviderRoundLoop({
      turnId: "turn-2",
      maxRounds: 1,
      signal,
      runRound: async () => ({ type: "continue" }),
      onExhausted: async () => "exhausted",
    })).resolves.toBe("exhausted");
  });

  test("owns provider stream collection and lifecycle hooks", async () => {
    const calls: string[] = [];
    async function* stream() {
      yield { text: "hel", toolCalls: [{ index: 0, value: "a" }] };
      yield {
        text: "lo",
        reasoningText: "reason",
        usage: { total: 3 },
        continuation: { id: "next" },
        toolCalls: [{ index: 0, value: "b" }],
        finishReason: "tool_calls",
      };
    }
    const result = await runProviderRound({
      stream: stream(),
      signal: new AbortController().signal,
      onDelta: () => calls.push("delta"),
      onCompleted: async () => { calls.push("completed"); },
      onFailed: async () => { calls.push("failed"); },
    });
    expect(result).toEqual({
      text: "hello",
      reasoningText: "reason",
      usage: { total: 3 },
      continuation: { id: "next" },
      toolCallBatches: [
        [{ index: 0, value: "a" }],
        [{ index: 0, value: "b" }],
      ],
      finishReason: "tool_calls",
    });
    expect(calls).toEqual(["delta", "delta", "completed"]);
  });

  test("materializes prompt layers in canonical order", () => {
    expect(materializeAgentPrompt({
      system: "system",
      harnessInstructions: ["harness"],
      skillInstructions: ["skill"],
      hostInstructions: ["host"]
    })).toBe("system\n\nharness\n\nskill\n\nhost");
  });

  test("owns compaction lifecycle ordering while the host supplies execution", async () => {
    const calls: string[] = [];
    await expect(runAgentCompaction({
      started: async () => { calls.push("started"); },
      compact: async () => {
        calls.push("compact");
        return { summary: "bounded" };
      },
      failed: async () => { calls.push("failed"); },
    })).resolves.toEqual({ summary: "bounded" });
    expect(calls).toEqual(["started", "compact"]);

    await expect(runAgentCompaction({
      started: async () => { calls.push("failed-started"); },
      compact: async () => { throw new Error("compaction failed"); },
      failed: async () => { calls.push("failed-recorded"); },
    })).rejects.toThrow("compaction failed");
    expect(calls.slice(-2)).toEqual(["failed-started", "failed-recorded"]);
  });

  test("owns provider-neutral compaction threshold decisions", () => {
    expect(agentCompactionDecision({
      projectedTokens: 700,
      maxContextTokens: 1_000,
      usableContextTokens: 800,
      triggerPercent: 85,
    })).toMatchObject({ shouldCompact: true, thresholdTokens: 680 });
    expect(agentCompactionDecision({
      projectedTokens: 10,
      maxContextTokens: null,
      usableContextTokens: null,
    })).toMatchObject({ shouldCompact: false, maxContextTokens: 0 });
  });

  test("owns the complete compaction program behind typed host ports", async () => {
    type TestEvent = { id: string; turnId?: string | null; text: string };
    const events: TestEvent[] = [
      { id: "old", turnId: "turn-1", text: "old context" },
      { id: "tail", turnId: "turn-2", text: "recent context" },
    ];
    const result = await runAgentCompactionProgram({
      events,
      model: "test-model",
      maxContextTokens: 1_000,
      host: {
        projectEvents: (items) => [...items],
        selectEvents: (items) => ({
          summaryEvents: [items[0]!],
          preservedEvents: [items[1]!],
          preservedEventIds: [items[1]!.id],
          retainedTailTokens: 10,
          retainedTailBudgetTokens: 100,
          splitTurnId: null,
        }),
        normalizeRecords: (items) => items.map((item) => item.text),
        buildFileLedger: () => [{ path: "README.md" }],
        inputCharBudget: () => 1_000,
        serializeRecords: (records) => ({
          text: records.join("\n"),
          inputChars: records.join("\n").length,
        }),
        buildSummaryMessages: ({ serializedHistory }) => [serializedHistory],
        streamSummary: async () => "durable summary",
        estimateProjection: () => ({
          inputTokensBefore: 20,
          inputTokensAfter: 12,
        }),
        durableResourceRefs: () => ["resource:one"],
        lastTurnId: (items) => items.at(-1)?.turnId ?? null,
        createMetrics: (metrics) => metrics,
      },
    });
    expect(result).toMatchObject({
      summary: "durable summary",
      compactedThroughEventId: "tail",
      compactedThroughTurnId: "turn-2",
      preservedFromEventId: "tail",
      preservedEventIds: ["tail"],
      sourceEventCount: 1,
      preservedEventCount: 1,
      inputTokensBefore: 20,
      inputTokensAfter: 12,
    });
  });

  test("owns thread and turn lifecycle telemetry without recording request payloads", async () => {
    const telemetry: Array<Record<string, unknown>> = [];
    const service = createAgentRuntimeService({
      capabilities: async () => ({
        protocolVersion: "test",
        placement: "local",
        methods: [],
        features: {},
        tools: [],
        toolCatalogHash: canonicalHash([]),
      }),
      createThread: async () => ({ id: "thread-1" }),
      readThread: async (threadId) => ({ id: threadId }),
      listTurns: async () => [],
      listEvents: async () => [],
      startTurn: async (threadId) => ({ id: "turn-1", threadId }),
      isTurnActive: () => false,
      waitForTurnSettlement: async () => undefined,
      interruptTurn: async (threadId) => ({ id: "turn-1", threadId }),
      resolveApproval: async (approvalId) => ({ id: approvalId }),
      inspectHarness: async () => ({}),
      reviewHarnessProposal: async () => ({}),
      reviewHarness: async () => ({}),
      acceptHarnessEvaluationReview: async () => ({}),
      materializeHarnessEvaluationTaskset: async () => ({}),
      validateHarness: async () => ({}),
      updateHarnessBackgroundReview: async () => ({}),
      diffHarness: async () => ({}),
      rollbackHarness: async () => ({}),
      telemetry: (event) => telemetry.push(event),
    });

    await service.turnStart({
      threadId: "thread-1",
      input: { prompt: "sensitive prompt", token: "secret" },
    });

    expect(telemetry).toEqual([
      expect.objectContaining({
        method: "turn/start",
        phase: "started",
        threadId: "thread-1",
        durationMs: null,
      }),
      expect.objectContaining({
        method: "turn/start",
        phase: "completed",
        threadId: "thread-1",
        durationMs: expect.any(Number),
      }),
    ]);
    expect(JSON.stringify(telemetry)).not.toContain("sensitive prompt");
    expect(JSON.stringify(telemetry)).not.toContain("secret");
  });
});
