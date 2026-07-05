import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelUsageRecord, UsageRecordsResponse, UsageSummaryResponse } from "@openpond/contracts";

import { UsageSettingsContent } from "../apps/web/src/components/settings/UsageSettingsSection";

const NOW = "2026-07-04T20:00:00.000Z";

describe("UsageSettingsContent", () => {
  test("renders summary metrics, grouped tables, and recent requests", () => {
    const html = renderUsage();

    expect(html).toContain("Usage");
    expect(html).toContain("All calls");
    expect(html).toContain("Total tokens");
    expect(html).toContain("1,500");
    expect(html).toContain("First token p95");
    expect(html).toContain("Daily tokens");
    expect(html).toContain("Models");
    expect(html).toContain("anthropic/claude-sonnet-4");
    expect(html).toContain("Threads");
    expect(html).toContain("Usage thread");
    expect(html).toContain("Slash commands");
    expect(html).toContain("/skill");
    expect(html).toContain("Insight runs");
    expect(html).toContain("Routes");
    expect(html).toContain("Local BYOK");
    expect(html).toContain("Sources");
    expect(html).toContain("Provider usage");
    expect(html).toContain("Requests");
    expect(html).toContain("Chat turn");
    expect(html).not.toContain("TOTAL TOKENS");
    expect(html).not.toContain("ALL CALLS");
  });

  test("renders empty usage states without data", () => {
    const html = renderUsage({
      summary: emptySummary(),
      recordsResponse: emptyRecords(),
    });

    expect(html).toContain("No usage records");
    expect(html).toContain("No daily tokens");
    expect(html).toContain("No model usage");
    expect(html).toContain("No requests");
  });

  test("renders neutral source actions for openable usage rows", () => {
    const html = renderUsage({
      onOpenSourceSession: () => undefined,
    });

    expect(html).toContain("Open");
    expect(html).toContain("aria-label=\"Open thread\"");
    expect(html).toContain("aria-label=\"Open Insight session\"");
    expect(html).toContain("aria-label=\"Open request source\"");
    expect(html).not.toContain("OPEN");
  });
});

function renderUsage(input: {
  summary?: UsageSummaryResponse;
  recordsResponse?: UsageRecordsResponse;
  onOpenSourceSession?: (sessionId: string) => void;
} = {}): string {
  return renderToStaticMarkup(
    createElement(UsageSettingsContent, {
      summary: input.summary ?? usageSummary(),
      recordsResponse: input.recordsResponse ?? usageRecords(),
      loading: false,
      error: null,
      range: "30d",
      visibility: "all",
      status: "all",
      onRangeChange: () => undefined,
      onVisibilityChange: () => undefined,
      onStatusChange: () => undefined,
      onRefresh: () => undefined,
      onOpenSourceSession: input.onOpenSourceSession,
    }),
  );
}

function usageSummary(): UsageSummaryResponse {
  return {
    generatedAt: NOW,
    range: { from: "2026-06-05T00:00:00.000Z", to: NOW, bucket: "day" },
    filters: { visibility: "all", status: "all" },
    totals: {
      requests: 3,
      completedRequests: 2,
      failedRequests: 1,
      missingUsageRequests: 1,
      promptTokens: 1120,
      completionTokens: 380,
      totalTokens: 1500,
      averageLatencyMs: 2000,
      p95LatencyMs: 3000,
      averageFirstTokenMs: 100,
      p95FirstTokenMs: 120,
      failureRate: 0.3333,
      activeModelCount: 2,
    },
    daily: [
      {
        date: "2026-07-04",
        totalTokens: 1500,
        requests: 3,
        models: [
          {
            provider: "openrouter",
            model: "anthropic/claude-sonnet-4",
            totalTokens: 1200,
            requests: 2,
          },
          {
            provider: "openai",
            model: "gpt-4.1",
            totalTokens: 300,
            requests: 1,
          },
        ],
      },
    ],
    models: [
      {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        route: "local_byok",
        requests: 2,
        promptTokens: 900,
        completionTokens: 300,
        totalTokens: 1200,
        averageLatencyMs: 1000,
        p95LatencyMs: 1200,
        averageFirstTokenMs: 80,
        p95FirstTokenMs: 100,
        failures: 0,
        failureRate: 0,
        firstSeenAt: "2026-07-04T10:00:00.000Z",
        lastSeenAt: "2026-07-04T13:00:00.000Z",
      },
    ],
    threads: [
      {
        sessionId: "session_usage",
        title: "Usage thread",
        workspaceKind: "local",
        workspaceId: "workspace_usage",
        requests: 3,
        promptTokens: 1120,
        completionTokens: 380,
        totalTokens: 1500,
        averageLatencyMs: 2000,
        p95LatencyMs: 3000,
        averageFirstTokenMs: 100,
        p95FirstTokenMs: 120,
        failures: 1,
        failureRate: 0.3333,
        firstSeenAt: "2026-07-04T10:00:00.000Z",
        lastSeenAt: "2026-07-04T13:00:00.000Z",
      },
    ],
    commands: [
      {
        commandName: "/skill",
        commandSource: "composer_selection",
        requests: 1,
        promptTokens: 900,
        completionTokens: 300,
        totalTokens: 1200,
        averageLatencyMs: 1000,
        p95LatencyMs: 1200,
        averageFirstTokenMs: 80,
        p95FirstTokenMs: 100,
        failures: 0,
        failureRate: 0,
        firstSeenAt: "2026-07-04T10:00:00.000Z",
        lastSeenAt: "2026-07-04T10:00:00.000Z",
      },
    ],
    insightRuns: [
      {
        insightRunId: "insight_run_usage",
        status: "completed",
        trigger: "manual",
        findingCount: 2,
        sessionId: "session_usage",
        turnId: "turn_usage",
        requests: 1,
        promptTokens: 220,
        completionTokens: 80,
        totalTokens: 300,
        averageLatencyMs: 3000,
        p95LatencyMs: 3000,
        averageFirstTokenMs: 100,
        p95FirstTokenMs: 120,
        failures: 1,
        failureRate: 1,
        firstSeenAt: "2026-07-04T12:00:00.000Z",
        lastSeenAt: "2026-07-04T12:00:00.000Z",
      },
    ],
    routes: [
      breakdown({
        route: "local_byok",
      }),
    ],
    statuses: [
      breakdown({
        status: "completed",
        requests: 2,
        failures: 0,
        failureRate: 0,
        totalTokens: 1200,
      }),
      breakdown({
        status: "failed",
        requests: 1,
        failures: 1,
        failureRate: 1,
        totalTokens: 300,
      }),
    ],
    sources: [
      breakdown({
        source: "provider_usage",
        requests: 2,
        totalTokens: 1500,
      }),
      breakdown({
        source: "missing",
        requests: 1,
        totalTokens: null,
      }),
    ],
  };
}

function usageRecords(): UsageRecordsResponse {
  return {
    generatedAt: NOW,
    range: { from: "2026-06-05T00:00:00.000Z", to: NOW, bucket: "day" },
    filters: { visibility: "all", status: "all", sessionId: null, turnId: null },
    limit: 100,
    hasMore: false,
    records: [usageRecord()],
  };
}

function emptySummary(): UsageSummaryResponse {
  return {
    ...usageSummary(),
    totals: {
      requests: 0,
      completedRequests: 0,
      failedRequests: 0,
      missingUsageRequests: 0,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      averageLatencyMs: null,
      p95LatencyMs: null,
      averageFirstTokenMs: null,
      p95FirstTokenMs: null,
      failureRate: 0,
      activeModelCount: 0,
    },
    daily: [],
    models: [],
    threads: [],
    commands: [],
    insightRuns: [],
    routes: [],
    statuses: [],
    sources: [],
  };
}

function emptyRecords(): UsageRecordsResponse {
  return {
    ...usageRecords(),
    hasMore: false,
    records: [],
  };
}

function usageRecord(): ModelUsageRecord {
  return {
    id: "model_usage_1",
    requestId: "turn_usage:model:0",
    requestOrdinal: 0,
    sessionId: "session_usage",
    turnId: "turn_usage",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    route: "local_byok",
    source: "provider_usage",
    requestKind: "chat_turn",
    visibility: "user_facing",
    status: "completed",
    startedAt: "2026-07-04T10:00:00.000Z",
    completedAt: "2026-07-04T10:00:01.000Z",
    durationMs: 1000,
    firstTokenMs: 80,
    promptTokens: 900,
    completionTokens: 300,
    totalTokens: 1200,
    errorType: null,
    errorMessage: null,
    attribution: {
      surface: "chat",
      workflowKind: "slash_command",
      sessionId: "session_usage",
      turnId: "turn_usage",
      insightRunId: null,
      goalId: null,
      createPipelineRequestId: null,
      createPipelineId: null,
      commandName: "/skill",
      commandSource: "composer_selection",
      appId: "app_usage",
      workspaceKind: "local",
      workspaceId: "workspace_usage",
      localProjectId: "local_project_usage",
      cloudProjectId: null,
      sourceEventSequence: null,
    },
  };
}

function breakdown<T extends object>(overrides: T) {
  return {
    requests: 3,
    promptTokens: 1120,
    completionTokens: 380,
    totalTokens: 1500,
    averageLatencyMs: 2000,
    p95LatencyMs: 3000,
    averageFirstTokenMs: 100,
    p95FirstTokenMs: 120,
    failures: 1,
    failureRate: 0.3333,
    firstSeenAt: "2026-07-04T10:00:00.000Z",
    lastSeenAt: "2026-07-04T13:00:00.000Z",
    ...overrides,
  };
}
