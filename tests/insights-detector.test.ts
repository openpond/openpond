import { describe, expect, test } from "bun:test";
import type {
  CreatePipelineRequest,
  CreatePipelineSnapshot,
  ModelUsageRecord,
  RuntimeEvent,
} from "@openpond/contracts";
import {
  detectCreateEditInsights,
} from "../apps/server/src/insights/create-edit-insights";
import { detectUsageAnomalyInsights } from "../apps/server/src/insights/usage-anomaly-insights";

const timestamp = "2026-07-01T10:00:00.000Z";

describe("create/edit insights detector", () => {
  test("creates active insights for waiting and blocked create/edit pipelines", () => {
    const createWaiting = createPipelineSnapshot("create_pipeline_waiting", "create", "awaiting_plan_approval");
    const editBlocked = createPipelineSnapshot("create_pipeline_blocked", "edit", "blocked");
    const candidates = detectCreateEditInsights(
      [
        eventEntry(1, createWaiting),
        eventEntry(2, editBlocked),
      ],
      timestamp,
    );

    expect(candidates.map((candidate) => candidate.item?.type)).toEqual([
      "create_edit.awaiting_plan_approval",
      "create_edit.blocked",
    ]);
    expect(candidates[0]?.item).toMatchObject({
      severity: "concern",
      status: "active",
      title: "Create agent is waiting for plan approval",
      payload: {
        createPipelineId: "create_pipeline_waiting",
        createPipelineOperation: "create",
        sourceEventSequence: 1,
      },
    });
    expect(candidates[1]?.item).toMatchObject({
      severity: "blocker",
      title: "Edit agent is blocked",
      payload: {
        createPipelineId: "create_pipeline_blocked",
        createPipelineOperation: "edit",
      },
    });
  });

  test("returns a resolve candidate when the latest pipeline state no longer needs attention", () => {
    const ready = createPipelineSnapshot("create_pipeline_ready", "create", "ready_local");
    const candidates = detectCreateEditInsights([eventEntry(3, ready)], timestamp);

    expect(candidates).toEqual([
      {
        createPipelineId: "create_pipeline_ready",
        keepFingerprint: null,
        item: null,
      },
    ]);
  });

  test("ignores non-create-edit pipeline operations", () => {
    const imported = createPipelineSnapshot("create_pipeline_import", "import", "blocked");
    expect(detectCreateEditInsights([eventEntry(4, imported)], timestamp)).toEqual([]);
  });

  test("keeps blocked summaries short", () => {
    const blocked = {
      ...createPipelineSnapshot("create_pipeline_long", "create", "blocked"),
      blockedReason: "failure ".repeat(200),
    };
    const [candidate] = detectCreateEditInsights([eventEntry(5, blocked)], timestamp);
    expect(candidate?.item?.summary.length).toBeLessThanOrEqual(360);
    expect(candidate?.item?.summary.endsWith("...")).toBe(true);
  });
});

describe("usage anomaly insights detector", () => {
  test("detects model token spikes with baseline floors and ignores Insights self-usage", () => {
    const records = [
      usageRecord({ requestId: "baseline_1", startedAt: "2026-06-28T09:00:00.000Z", totalTokens: 1000 }),
      usageRecord({ requestId: "baseline_2", startedAt: "2026-06-29T09:00:00.000Z", totalTokens: 1000 }),
      usageRecord({ requestId: "baseline_3", startedAt: "2026-06-30T09:00:00.000Z", totalTokens: 1000 }),
      usageRecord({ requestId: "current_1", startedAt: "2026-07-01T09:00:00.000Z", totalTokens: 6200 }),
      usageRecord({
        requestId: "insights_self_usage",
        sessionId: "insights_session",
        turnId: "insights_turn",
        startedAt: "2026-07-01T09:10:00.000Z",
        requestKind: "insights_scan",
        visibility: "system",
        totalTokens: 200_000,
        attribution: {
          ...usageRecord().attribution,
          surface: "insights",
          workflowKind: "scan",
          sessionId: "insights_session",
          turnId: "insights_turn",
          insightRunId: "insights_run_1",
        },
      }),
    ];

    const candidates = detectUsageAnomalyInsights(records, timestamp);
    const spike = candidates.find((candidate) => candidate.item?.type === "usage.model_usage_spike");

    expect(spike?.item).toMatchObject({
      severity: "blocker",
      title: "openrouter/anthropic/claude-sonnet-4 spiked",
      payload: {
        detector: "usage-anomaly",
        evidenceSource: "usage_anomaly",
        anomalyKind: "model_usage_spike",
        metric: "total_tokens",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        visibility: "user_facing",
        current: {
          totalTokens: 6200,
        },
        baseline: {
          activeDays: 3,
          medianTotalTokens: 1000,
        },
        ratio: 6.2,
        absoluteFloor: 5000,
        drilldown: {
          visibility: "user_facing",
          status: "all",
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4",
        },
        linkedSessionIds: ["session_usage"],
      },
    });
    expect(candidates.some((candidate) => candidate.item?.payload.provider === "openpond")).toBe(false);
  });

  test("requires enough baseline days and absolute floors", () => {
    expect(detectUsageAnomalyInsights([
      usageRecord({ requestId: "baseline_1", startedAt: "2026-06-30T09:00:00.000Z", totalTokens: 1000 }),
      usageRecord({ requestId: "current_1", startedAt: "2026-07-01T09:00:00.000Z", totalTokens: 6200 }),
    ], timestamp)).toEqual([]);

    expect(detectUsageAnomalyInsights([
      usageRecord({ requestId: "baseline_1", startedAt: "2026-06-28T09:00:00.000Z", totalTokens: 1000 }),
      usageRecord({ requestId: "baseline_2", startedAt: "2026-06-29T09:00:00.000Z", totalTokens: 1000 }),
      usageRecord({ requestId: "baseline_3", startedAt: "2026-06-30T09:00:00.000Z", totalTokens: 1000 }),
      usageRecord({ requestId: "current_1", startedAt: "2026-07-01T09:00:00.000Z", totalTokens: 4000 }),
    ], timestamp)).toEqual([]);
  });

  test("detects request-count spikes when token totals do not spike", () => {
    const records: ModelUsageRecord[] = [];
    for (const day of ["2026-06-28", "2026-06-29", "2026-06-30"]) {
      records.push(usageRecord({ requestId: `${day}_baseline_1`, startedAt: `${day}T09:00:00.000Z`, totalTokens: 10 }));
      records.push(usageRecord({ requestId: `${day}_baseline_2`, startedAt: `${day}T09:10:00.000Z`, totalTokens: 10 }));
    }
    for (let index = 0; index < 12; index += 1) {
      records.push(usageRecord({
        requestId: `current_request_spike_${index}`,
        startedAt: `2026-07-01T09:${String(index).padStart(2, "0")}:00.000Z`,
        totalTokens: 10,
      }));
    }

    const requestSpike = detectUsageAnomalyInsights(records, timestamp)
      .find((candidate) => candidate.item?.payload.metric === "requests");

    expect(requestSpike?.item).toMatchObject({
      type: "usage.model_usage_spike",
      payload: {
        anomalyKind: "model_usage_spike",
        metric: "requests",
        current: {
          requests: 12,
        },
        baseline: {
          medianRequests: 2,
        },
        ratio: 6,
      },
    });
  });

  test("detects latency, failure, and missing-usage anomalies with stable fingerprints", () => {
    const records: ModelUsageRecord[] = [];
    for (const day of ["2026-06-28", "2026-06-29", "2026-06-30"]) {
      for (let index = 0; index < 5; index += 1) {
        records.push(usageRecord({
          requestId: `${day}_latency_${index}`,
          model: "latency-model",
          startedAt: `${day}T09:0${index}:00.000Z`,
          durationMs: 1000,
          totalTokens: 100,
        }));
      }
      records.push(usageRecord({
        requestId: `${day}_failure_baseline`,
        model: "failure-model",
        startedAt: `${day}T09:40:00.000Z`,
        totalTokens: 100,
      }));
      records.push(usageRecord({
        requestId: `${day}_missing_baseline`,
        model: "missing-model",
        startedAt: `${day}T09:50:00.000Z`,
        totalTokens: 100,
      }));
    }
    for (let index = 0; index < 5; index += 1) {
      records.push(usageRecord({
        requestId: `current_latency_${index}`,
        model: "latency-model",
        startedAt: `2026-07-01T09:0${index}:00.000Z`,
        durationMs: 12_000,
        totalTokens: 100,
      }));
    }
    for (let index = 0; index < 4; index += 1) {
      records.push(usageRecord({
        requestId: `current_failure_${index}`,
        model: "failure-model",
        startedAt: `2026-07-01T09:1${index}:00.000Z`,
        status: "failed",
        totalTokens: null,
      }));
    }
    for (let index = 0; index < 3; index += 1) {
      records.push(usageRecord({
        requestId: `current_missing_${index}`,
        model: "missing-model",
        startedAt: `2026-07-01T09:2${index}:00.000Z`,
        source: "missing",
        totalTokens: null,
      }));
    }

    const first = detectUsageAnomalyInsights(records, timestamp);
    const second = detectUsageAnomalyInsights(records, timestamp);

    expect(first.map((candidate) => candidate.keepFingerprint)).toEqual(second.map((candidate) => candidate.keepFingerprint));
    expect(first.some((candidate) => candidate.item?.type === "usage.latency_regression")).toBe(true);
    expect(first.some((candidate) => candidate.item?.type === "usage.failure_cluster")).toBe(true);
    expect(first.some((candidate) => candidate.item?.type === "usage.missing_usage_frames")).toBe(true);
  });
});

function eventEntry(
  sequence: number,
  snapshot: CreatePipelineSnapshot,
): { sequence: number; event: RuntimeEvent } {
  return {
    sequence,
    event: {
      id: `event_${sequence}`,
      sequence,
      sessionId: "session_1",
      turnId: "turn_1",
      name: "create_pipeline.updated",
      timestamp,
      source: "server",
      status: "pending",
      data: {
        createPipelineRequest: snapshot.request,
        createPipeline: snapshot,
      },
    },
  };
}

function createPipelineSnapshot(
  id: string,
  operation: CreatePipelineRequest["operation"],
  state: CreatePipelineSnapshot["state"],
): CreatePipelineSnapshot {
  const request = createPipelineRequest(`${id}_request`, operation);
  return {
    schemaVersion: "openpond.createPipeline.snapshot.v1",
    id,
    goalId: `${id}_goal`,
    state,
    request,
    plan: {
      schemaVersion: "openpond.createPipeline.plan.v1",
      id: `${id}_plan`,
      goalId: `${id}_goal`,
      requestId: request.id,
      status: "pending_approval",
      objective: request.objective,
      summary: "Build the requested agent.",
      capturedContextSummary: "User asked for an agent.",
      defaultChatAction: { key: "chat", label: "Chat", required: true },
      sourcePlan: [],
      requirements: [],
      checks: [],
      approvalId: `${id}_approval`,
      approvedAt: null,
      editedFromPlanId: null,
      metadata: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    workflowCapture: null,
    approvalIds: [`${id}_approval`],
    questionIds: [],
    questions: [],
    checkRefs: [],
    sourceRefs: [],
    localGoalId: null,
    localProfileCommit: null,
    hostedGoalId: null,
    hostedSourceCommit: null,
    hostedSourceRef: null,
    blockedReason: state === "blocked" ? "Source application failed." : null,
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createPipelineRequest(
  id: string,
  operation: CreatePipelineRequest["operation"],
): CreatePipelineRequest {
  return {
    schemaVersion: "openpond.createPipeline.request.v1",
    id,
    operation,
    surface: operation === "edit" ? "direct_prompt_edit" : "direct_prompt_create",
    command: operation === "edit" ? "/edit" : "/create",
    objective: operation === "edit" ? "Refine an agent" : "Create an agent",
    adapter: {
      kind: "local",
      sourceAuthority: "local_profile",
      activeProfile: "default",
      repoPath: "/tmp/openpond-profile",
      sourcePath: "/tmp/openpond-profile/agents",
      localHead: null,
      confirmationPolicy: "always_require_plan_approval",
    },
    actor: { id: null, kind: "user", label: null },
    scope: {
      conversationId: "session_1",
      workItemId: null,
      projectId: null,
      targetProject: null,
    },
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      targetRepoAssumptions: [],
    },
    targetAgent: {
      agentId: null,
      displayName: null,
      defaultActionKey: "chat",
    },
    metadata: {},
    createdAt: timestamp,
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
    startedAt: "2026-07-01T09:00:00.000Z",
    completedAt: "2026-07-01T09:00:01.000Z",
    durationMs: 1000,
    firstTokenMs: 100,
    promptTokens: null,
    completionTokens: null,
    totalTokens: 1000,
    errorType: null,
    errorMessage: null,
    attribution: {
      surface: "chat",
      workflowKind: "direct_chat",
      sessionId: "session_usage",
      turnId: "turn_usage",
      insightRunId: null,
      goalId: null,
      createPipelineRequestId: null,
      createPipelineId: null,
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
    attribution: {
      surface: "chat",
      workflowKind: "direct_chat",
      sessionId: patch.sessionId ?? "session_usage",
      turnId: patch.turnId ?? "turn_usage",
      insightRunId: null,
      goalId: null,
      createPipelineRequestId: null,
      createPipelineId: null,
      commandName: null,
      commandSource: null,
      appId: null,
      workspaceKind: "local_project",
      workspaceId: "project_usage",
      localProjectId: "project_usage",
      cloudProjectId: null,
      sourceEventSequence: null,
      ...(patch.attribution ?? {}),
    },
  };
}
