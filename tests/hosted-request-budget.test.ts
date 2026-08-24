import { describe, expect, test } from "vitest";
import {
  estimateHostedRequestBudget,
  hostedRequestedOutputTokens,
} from "../apps/server/src/openpond/context-usage";
import { hostedAutoCompactionDecision } from "../apps/server/src/openpond/context-compaction/index";
import {
  isProviderContextOverflowError,
  runWithSingleContextOverflowRecovery,
} from "../apps/server/src/runtime/hosted-turn/context-overflow-recovery";
import {
  createByokTurnRunnerHarness,
  hostedCompactionPriorEvents,
  openRouterProviderSettingsWithContextWindow,
} from "./helpers/byok-turn-runner-harness";

describe("hosted physical request budgeting", () => {
  test("accounts for messages, tool schemas, provider continuation state, output, and reserve", () => {
    const budget = estimateHostedRequestBudget({
      provider: "openrouter",
      maxContextTokens: 32_000,
      maxOutputTokens: 4_096,
      messages: [
        { role: "system", content: "System instructions" },
        {
          role: "assistant",
          content: "Continue",
          continuation: {
            kind: "chat_completions_reasoning",
            reasoningContent: "provider continuation state",
          },
        },
      ],
      tools: [{
        type: "function",
        function: {
          name: "large_tool",
          description: "x".repeat(2_000),
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "y".repeat(1_000) } },
          },
        },
      }],
    });

    expect(budget.messageTokens).toBeGreaterThan(0);
    expect(budget.toolDefinitionTokens).toBeGreaterThan(700);
    expect(budget.continuationTokens).toBeGreaterThan(0);
    expect(budget.outputAllowanceTokens).toBe(4_096);
    expect(budget.safetyReserveTokens).toBeGreaterThan(0);
    expect(budget.projectedTokens).toBe(
      budget.messageTokens
      + budget.toolDefinitionTokens
      + budget.continuationTokens
      + budget.outputAllowanceTokens
      + budget.safetyReserveTokens,
    );
    expect(budget.tokenSource).toBe("heuristic");
  });

  test("tool schemas can trigger compaction when message-only accounting would not", () => {
    const messages = [{ role: "user" as const, content: "short request" }];
    const quiet = hostedAutoCompactionDecision({
      provider: "openpond",
      model: "openpond-10k",
      messages,
      maxOutputTokens: 512,
      tools: [],
    });
    const toolHeavy = hostedAutoCompactionDecision({
      provider: "openpond",
      model: "openpond-10k",
      messages,
      maxOutputTokens: 1_024,
      tools: [{
        type: "function",
        function: {
          name: "schema_heavy",
          description: "z".repeat(20_000),
          parameters: { type: "object", properties: {} },
        },
      }],
    });

    expect(quiet.shouldCompact).toBe(false);
    expect(toolHeavy.shouldCompact).toBe(true);
    expect(toolHeavy.requestBudget.toolDefinitionTokens).toBeGreaterThan(4_000);
  });

  test("bounds the requested output allowance to the model and context limits", () => {
    expect(hostedRequestedOutputTokens({ maxContextTokens: 128_000 })).toBe(8_192);
    expect(hostedRequestedOutputTokens({ maxContextTokens: 8_000 })).toBe(1_000);
    expect(hostedRequestedOutputTokens({ maxContextTokens: 128_000, modelOutputLimit: 2_048 })).toBe(2_048);
  });
});

describe("bounded provider overflow recovery", () => {
  test("compacts and retries exactly once before output escapes", async () => {
    const attempts: number[] = [];
    let recoveries = 0;
    const result = await runWithSingleContextOverflowRecovery({
      runAttempt: async ({ attempt }) => {
        attempts.push(attempt);
        if (attempt === 0) throw new Error("maximum context length exceeded");
        return "recovered";
      },
      recover: async () => {
        recoveries += 1;
        return true;
      },
    });

    expect(result).toBe("recovered");
    expect(attempts).toEqual([0, 1]);
    expect(recoveries).toBe(1);
  });

  test("does not retry after any provider output escaped", async () => {
    let recoveries = 0;
    await expect(runWithSingleContextOverflowRecovery({
      runAttempt: async ({ markOutputEscaped }) => {
        markOutputEscaped();
        throw new Error("context_length_exceeded");
      },
      recover: async () => {
        recoveries += 1;
        return true;
      },
    })).rejects.toThrow("context_length_exceeded");
    expect(recoveries).toBe(0);
  });

  test("recognizes context overflow without treating ordinary token errors as overflow", () => {
    expect(isProviderContextOverflowError(new Error("prompt is too long for the context window"))).toBe(true);
    expect(isProviderContextOverflowError(new Error("maximum context length is 128000 tokens"))).toBe(true);
    expect(isProviderContextOverflowError(new Error("API token is invalid"))).toBe(false);
    expect(isProviderContextOverflowError(new Error("rate limit exceeded"))).toBe(false);
  });
});

describe("hosted request preparation integration", () => {
  test("compacts between tool rounds before the next physical provider request", async () => {
    const largeToolOutput = "large-result:" + "x".repeat(19_500);
    const harness = createByokTurnRunnerHarness({
      sessionOverrides: {
        workspaceKind: "local_project",
        cwd: "/tmp/openpond-request-budget",
      },
      providerSettings: openRouterProviderSettingsWithContextWindow(32_000),
      toolCallsByPass: {
        1: [0, 1, 2].map((index) => ({
          name: "resource_read",
          args: { ref: `workspace:file:large-${index}.log` },
        })),
      },
      executeWorkspaceTool: async (_sessionId, request) => ({
        ok: true,
        action: request.action,
        appId: null,
        output: largeToolOutput,
        data: null,
      }),
      compactionSummary:
        "The three large resource reads completed successfully. Continue with the final response.",
      finalText: "Finished after safe-boundary compaction.",
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Read the three large logs and then finish.",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const providerRequests = harness.streamInputs.filter(
      (request) => !request.requestId.startsWith("compact-"),
    );
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests.every((request) => request.maxOutputTokens === 4_000)).toBe(true);
    expect(JSON.stringify(providerRequests[1].messages)).toContain(
      "The three large resource reads completed successfully",
    );
    expect(JSON.stringify(providerRequests[1].messages)).not.toContain(largeToolOutput);

    const completed = harness.events.find(
      (event) =>
        event.name === "session.compaction.completed"
        && (event.data as any)?.reason === "auto"
        && (event.data as any)?.roundIndex === 1,
    );
    expect(completed).toBeDefined();
    expect((completed?.data as any)?.requestBudget.toolDefinitionTokens).toBeGreaterThan(0);
    expect((completed?.data as any)?.requestBudget.outputAllowanceTokens).toBe(4_000);
  });

  test("recovers once from a provider context overflow before output escapes", async () => {
    const harness = createByokTurnRunnerHarness({
      providerSettings: openRouterProviderSettingsWithContextWindow(32_000),
      initialEvents: hostedCompactionPriorEvents(1_000),
      failOnPass: 1,
      failure: new Error("maximum context length exceeded"),
      compactionSummary:
        "The durable workflow context is preserved. Retry the current request now.",
      finalText: "Recovered after overflow.",
    });

    const turn = await harness.runner.sendTurn("session_1", {
      prompt: "Continue the workflow.",
      modelRef: { providerId: "openrouter", modelId: "test/model" },
    });

    expect(turn.status).toBe("completed");
    const providerRequests = harness.streamInputs.filter(
      (request) => !request.requestId.startsWith("compact-"),
    );
    expect(providerRequests.map((request) => request.requestId)).toEqual([
      expect.not.stringContaining(":overflow-retry"),
      expect.stringContaining(":overflow-retry"),
    ]);
    const recoveryCompactions = harness.events.filter(
      (event) =>
        event.name === "session.compaction.completed"
        && (event.data as any)?.reason === "overflow_recovery",
    );
    expect(recoveryCompactions).toHaveLength(1);
    expect(harness.usageRecords.filter((record) => record.status === "failed")).toHaveLength(1);
    expect(harness.usageRecords.filter(
      (record) => record.status === "completed" && record.requestId.includes(":overflow-retry"),
    )).toHaveLength(1);
  });
});
