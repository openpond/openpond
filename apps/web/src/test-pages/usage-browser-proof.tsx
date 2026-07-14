import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ModelUsageRecord, UsageRecordsResponse, UsageSummaryResponse } from "@openpond/contracts";
import { UsageSettingsContent } from "../components/settings/UsageSettingsSection";
import "../styles.css";

const NOW = "2026-07-04T20:00:00.000Z";

function UsageBrowserProof() {
  const [openedSessionId, setOpenedSessionId] = useState<string | null>(null);

  return (
    <div className="usage-browser-proof-shell">
      <UsageSettingsContent
        summary={usageSummary()}
        recordsResponse={usageRecords()}
        loading={false}
        error={null}
        range="30d"
        visibility="all"
        status="all"
        onRangeChange={() => undefined}
        onVisibilityChange={() => undefined}
        onStatusChange={() => undefined}
        onRefresh={() => undefined}
        onOpenSourceSession={setOpenedSessionId}
      />
      <output data-testid="usage-opened-session">{openedSessionId ?? "none"}</output>
    </div>
  );
}

function usageSummary(): UsageSummaryResponse {
  const daily = Array.from({ length: 14 }, (_, index) => {
    const day = index + 1;
    const date = new Date(Date.UTC(2026, 5, 21 + index)).toISOString().slice(0, 10);
    return {
      date,
      totalTokens: 1000 + day * 650,
      requests: 3 + (index % 5),
      models: [
        {
          provider: "openrouter" as const,
          model: "anthropic/claude-sonnet-4",
          totalTokens: 800 + day * 260,
          requests: 2 + (index % 3),
        },
        {
          provider: "openai" as const,
          model: "gpt-4.1",
          totalTokens: 400 + day * 210,
          requests: 1 + (index % 2),
        },
        {
          provider: "google" as const,
          model: "gemini-2.5-pro",
          totalTokens: 240 + day * 180,
          requests: 1,
        },
      ],
    };
  });

  return {
    generatedAt: NOW,
    range: { from: "2026-06-21T00:00:00.000Z", to: NOW, bucket: "day" },
    filters: { visibility: "all", status: "all" },
    totals: {
      requests: 72,
      completedRequests: 68,
      failedRequests: 3,
      missingUsageRequests: 1,
      promptTokens: 48_200,
      completionTokens: 16_640,
      totalTokens: 64_840,
      averageLatencyMs: 1880,
      p95LatencyMs: 4200,
      averageFirstTokenMs: 220,
      p95FirstTokenMs: 460,
      failureRate: 0.0416,
      activeModelCount: 3,
    },
    daily,
    models: [
      modelBreakdown("openrouter", "anthropic/claude-sonnet-4", "local_byok", 31_200),
      modelBreakdown("openai", "gpt-4.1", "local_byok", 20_300),
      modelBreakdown("google", "gemini-2.5-pro", "local_byok", 13_340),
    ],
    threads: [
      {
        ...breakdown(24_200),
        sessionId: "session_usage_browser_primary",
        title: "Usage browser proof thread",
        workspaceKind: "local_project",
        workspaceId: "local_project_usage_browser",
      },
      {
        ...breakdown(16_800),
        sessionId: "session_usage_browser_secondary",
        title: "Long-running usage review",
        workspaceKind: "local_project",
        workspaceId: "local_project_usage_browser",
      },
    ],
    commands: [
      {
        ...breakdown(12_400),
        commandName: "/skill",
        commandSource: "composer_selection",
      },
      {
        ...breakdown(9_600),
        commandName: "/create",
        commandSource: "prompt_parse",
      },
    ],
    insightRuns: [
      {
        ...breakdown(4200),
        insightRunId: "insight_run_usage_browser",
        status: "completed",
        trigger: "manual",
        findingCount: 3,
        sessionId: "session_usage_browser_insights",
        turnId: "turn_usage_browser_insights",
      },
    ],
    routes: [
      { ...breakdown(50_200), route: "local_byok" },
      { ...breakdown(14_640), route: "openpond_hosted" },
    ],
    statuses: [
      { ...breakdown(60_000), status: "completed", failures: 0, failureRate: 0 },
      { ...breakdown(4840), status: "failed", failures: 3, failureRate: 1 },
    ],
    sources: [
      { ...breakdown(63_400), source: "provider_usage" },
      { ...breakdown(null), source: "missing", requests: 1 },
    ],
  };
}

function usageRecords(): UsageRecordsResponse {
  return {
    generatedAt: NOW,
    range: { from: "2026-06-21T00:00:00.000Z", to: NOW, bucket: "day" },
    filters: { visibility: "all", status: "all", sessionId: null, turnId: null },
    limit: 100,
    hasMore: false,
    records: [
      usageRecord("model_usage_browser_1", "session_usage_browser_primary", "turn_usage_browser_1", "anthropic/claude-sonnet-4", 4200),
      usageRecord("model_usage_browser_2", "session_usage_browser_insights", "turn_usage_browser_insights", "gpt-4.1", 3100, {
        requestKind: "insights_scan",
        visibility: "system",
        insightRunId: "insight_run_usage_browser",
      }),
      usageRecord("model_usage_browser_3", null, null, "gemini-2.5-pro", null, {
        requestKind: "context_compaction",
        visibility: "background",
        source: "missing",
      }),
    ],
  };
}

function modelBreakdown(
  provider: "openrouter" | "openai" | "google",
  model: string,
  route: "local_byok" | "openpond_hosted",
  totalTokens: number,
): UsageSummaryResponse["models"][number] {
  return {
    ...breakdown(totalTokens),
    provider,
    model,
    route,
  };
}

function breakdown(totalTokens: number | null): Omit<UsageSummaryResponse["models"][number], "provider" | "model" | "route"> {
  return {
    requests: 12,
    promptTokens: totalTokens === null ? null : Math.round(totalTokens * 0.74),
    completionTokens: totalTokens === null ? null : Math.round(totalTokens * 0.26),
    totalTokens,
    averageLatencyMs: 1800,
    p95LatencyMs: 4200,
    averageFirstTokenMs: 180,
    p95FirstTokenMs: 360,
    failures: 1,
    failureRate: 0.083,
    firstSeenAt: "2026-06-21T10:00:00.000Z",
    lastSeenAt: "2026-07-04T18:00:00.000Z",
  };
}

function usageRecord(
  id: string,
  sessionId: string | null,
  turnId: string | null,
  model: string,
  totalTokens: number | null,
  patch: Partial<ModelUsageRecord> & {
    insightRunId?: string | null;
  } = {},
): ModelUsageRecord {
  const { insightRunId, ...recordPatch } = patch;
  return {
    id,
    requestId: `${turnId ?? id}:model:0`,
    requestOrdinal: 0,
    sessionId,
    turnId,
    provider: model === "gpt-4.1" ? "openai" : model.startsWith("gemini") ? "google" : "openrouter",
    model,
    route: "local_byok",
    source: "provider_usage",
    requestKind: "chat_turn",
    visibility: "user_facing",
    status: "completed",
    startedAt: "2026-07-04T18:00:00.000Z",
    completedAt: "2026-07-04T18:00:02.000Z",
    durationMs: 2000,
    firstTokenMs: 180,
    promptTokens: totalTokens === null ? null : Math.round(totalTokens * 0.75),
    completionTokens: totalTokens === null ? null : Math.round(totalTokens * 0.25),
    totalTokens,
    errorType: null,
    errorMessage: null,
    attribution: {
      surface: "chat",
      workflowKind: "direct_chat",
      sessionId,
      turnId,
      insightRunId: insightRunId ?? null,
      goalId: null,
      subagentRunId: null,
      subagentRoleId: null,
      createPipelineRequestId: null,
      createPipelineId: null,
      commandName: null,
      commandSource: null,
      appId: "app_usage_browser",
      workspaceKind: "local_project",
      workspaceId: "local_project_usage_browser",
      localProjectId: "local_project_usage_browser",
      cloudProjectId: null,
      sourceEventSequence: null,
    },
    ...recordPatch,
  };
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(
  <StrictMode>
    <UsageBrowserProof />
  </StrictMode>,
);
