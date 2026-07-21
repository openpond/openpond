import { describe, expect, test } from "vitest";
import type { ModelUsageRecord, Session } from "@openpond/contracts";
import { usageRecordsPayload, usageSummaryPayload } from "../apps/server/src/api/usage-payloads";

describe("usage API payloads", () => {
  test("aggregates all-calls usage by totals, day, model, thread, and command", async () => {
    const records = [
      usageRecord({
        requestId: "usage_1",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        totalTokens: 1200,
        promptTokens: 900,
        completionTokens: 300,
        durationMs: 1000,
        attribution: {
          ...usageRecord().attribution,
          commandName: "/skill",
          commandSource: "composer_selection",
        },
      }),
      usageRecord({
        requestId: "usage_2",
        provider: "openai",
        model: "gpt-4.1",
        totalTokens: 300,
        promptTokens: 220,
        completionTokens: 80,
        durationMs: 3000,
        status: "failed",
        errorType: "Error",
        errorMessage: "provider failed",
        startedAt: "2026-07-04T12:00:00.000Z",
      }),
      usageRecord({
        requestId: "usage_3",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        source: "missing",
        totalTokens: null,
        promptTokens: null,
        completionTokens: null,
        durationMs: 2000,
        startedAt: "2026-07-04T13:00:00.000Z",
      }),
    ];
    const payload = await usageSummaryPayload({
      requestUrl: new URL("http://127.0.0.1/v1/usage?range=7d&visibility=all&status=all"),
      store: usageStore(records),
      now: new Date("2026-07-04T20:00:00.000Z"),
    });

    expect(payload.totals).toMatchObject({
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
      p95FirstTokenMs: 100,
      failureRate: 0.3333,
      activeModelCount: 2,
      peakDailyTokens: 1500,
      longestRequestMs: 3000,
      activeDays: 1,
      currentStreakDays: 1,
      longestStreakDays: 1,
    });
    expect(payload.daily).toEqual([
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
    ]);
    expect(payload.models[0]).toMatchObject({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      requests: 2,
      totalTokens: 1200,
    });
    expect(payload.threads[0]).toMatchObject({
      sessionId: "session_usage",
      title: "Usage thread",
      requests: 3,
    });
    expect(payload.commands[0]).toMatchObject({
      commandName: "/skill",
      commandSource: "composer_selection",
      requests: 1,
      totalTokens: 1200,
    });
    expect(payload.routes[0]).toMatchObject({
      route: "local_byok",
      requests: 3,
      failures: 1,
      failureRate: 0.3333,
    });
    expect(payload.statuses.map((row) => [row.status, row.requests, row.totalTokens])).toEqual([
      ["completed", 2, 1200],
      ["failed", 1, 300],
    ]);
    expect(payload.sources.map((row) => [row.source, row.requests, row.totalTokens])).toEqual([
      ["provider_usage", 2, 1500],
      ["missing", 1, null],
    ]);
  });

  test("returns bounded records with filters and hasMore", async () => {
    const records = [
      usageRecord({ requestId: "usage_1", startedAt: "2026-07-04T10:00:00.000Z" }),
      usageRecord({ requestId: "usage_2", startedAt: "2026-07-04T11:00:00.000Z" }),
      usageRecord({ requestId: "usage_3", source: "missing", startedAt: "2026-07-04T12:00:00.000Z" }),
    ];
    const payload = await usageRecordsPayload({
      requestUrl: new URL("http://127.0.0.1/v1/usage/records?range=7d&status=missing&limit=1"),
      store: usageStore(records),
      now: new Date("2026-07-04T20:00:00.000Z"),
    });

    expect(payload.limit).toBe(1);
    expect(payload.hasMore).toBe(false);
    expect(payload.records.map((record) => record.requestId)).toEqual(["usage_3"]);
    expect(payload.filters.status).toBe("missing");
  });

  test("filters summaries and records to one provider model", async () => {
    const records = [
      usageRecord({ requestId: "usage_codex", provider: "codex", model: "gpt-5.6", totalTokens: 800 }),
      usageRecord({ requestId: "usage_openrouter", provider: "openrouter", model: "anthropic/claude-sonnet-4", totalTokens: 1200 }),
    ];
    const store = usageStore(records);
    const summary = await usageSummaryPayload({
      requestUrl: new URL("http://127.0.0.1/v1/usage?range=all&provider=codex&model=gpt-5.6"),
      store,
      now: new Date("2026-07-04T20:00:00.000Z"),
    });
    const recordPayload = await usageRecordsPayload({
      requestUrl: new URL("http://127.0.0.1/v1/usage/records?range=all&provider=codex&model=gpt-5.6"),
      store,
      now: new Date("2026-07-04T20:00:00.000Z"),
    });

    expect(summary.filters).toMatchObject({ provider: "codex", model: "gpt-5.6" });
    expect(summary.totals.requests).toBe(1);
    expect(summary.models.map((row) => [row.provider, row.model])).toEqual([["codex", "gpt-5.6"]]);
    expect(recordPayload.records.map((record) => record.requestId)).toEqual(["usage_codex"]);
  });
});

function usageStore(records: ModelUsageRecord[]) {
  return {
    async listModelUsageRecords(query: {
      sessionId?: string | null;
      turnId?: string | null;
      provider?: ModelUsageRecord["provider"] | null;
      model?: string | null;
      startedAtFrom?: string | null;
      startedAtTo?: string | null;
      visibility?: string | null;
      status?: string | null;
      limit?: number;
    } = {}) {
      const filtered = records
        .filter((record) => !query.sessionId || record.sessionId === query.sessionId)
        .filter((record) => !query.turnId || record.turnId === query.turnId)
        .filter((record) => !query.provider || record.provider === query.provider)
        .filter((record) => !query.model || record.model === query.model)
        .filter((record) => !query.startedAtFrom || record.startedAt >= query.startedAtFrom)
        .filter((record) => !query.startedAtTo || record.startedAt <= query.startedAtTo)
        .filter((record) => !query.visibility || query.visibility === "all" || record.visibility === query.visibility)
        .filter((record) => {
          if (!query.status || query.status === "all") return true;
          if (query.status === "missing") return record.source === "missing";
          return record.status === query.status;
        })
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
      return query.limit ? filtered.slice(0, query.limit) : filtered;
    },
    async sessionShells() {
      return [usageSession()];
    },
  };
}

function usageRecord(patch: Partial<ModelUsageRecord> = {}): ModelUsageRecord {
  return {
    id: `record_${patch.requestId ?? "usage_default"}`,
    requestId: "usage_default",
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
    firstTokenMs: 100,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    errorType: null,
    errorMessage: null,
    attribution: {
      surface: "chat",
      workflowKind: "direct_chat",
      sessionId: "session_usage",
      turnId: "turn_usage",
      insightRunId: null,
      goalId: null,
      createImproveRunId: null,
      commandName: null,
      commandSource: null,
      appId: null,
      workspaceKind: "local_project",
      workspaceId: "project_usage",
      localProjectId: "project_usage",
      cloudProjectId: null,
      sourceEventSequence: null,
    },
    ...patch,
  };
}

function usageSession(): Session {
  return {
    id: "session_usage",
    provider: "openrouter",
    modelRef: { providerId: "openrouter", modelId: "anthropic/claude-sonnet-4" },
    title: "Usage thread",
    appId: null,
    appName: null,
    workspaceKind: "local_project",
    workspaceId: "project_usage",
    workspaceName: "Project",
    localProjectId: "project_usage",
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/tmp/openpond",
    codexThreadId: null,
    createdAt: "2026-07-04T10:00:00.000Z",
    updatedAt: "2026-07-04T10:00:00.000Z",
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
  };
}
