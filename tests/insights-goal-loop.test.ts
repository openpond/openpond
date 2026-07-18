import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  AppPreferencesSchema,
  type AppPreferences,
  type CreateImproveRun,
  type ModelUsageRecord,
  type RuntimeEvent,
  type Turn,
} from "@openpond/contracts";
import { createInsightsService } from "../apps/server/src/insights/create-edit-insights";
import { INSIGHTS_SYSTEM_KIND } from "../apps/server/src/insights/insights-system";
import { createSessionStore } from "../apps/server/src/store/session-store";
import { SqliteStore } from "../apps/server/src/store/store";
import { event, now } from "../apps/server/src/utils";
import { listLocalProjects } from "../apps/server/src/workspace/local-projects";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";

const timestamp = "2026-07-01T10:00:00.000Z";

describe("Insights goal loop", () => {
  test("runs scans through the hidden Insights system session and links rows to the run turn", async () => {
    await withStoreDir(async (storeDir) => {
      const harness = createInsightsHarness(storeDir);
      const { appendRuntimeEvent, service, store } = harness;
      const snapshot = createPipelineSnapshot("create_pipeline_waiting", "create", "awaiting_plan_approval");
      await appendRuntimeEvent({
        id: "source_event_1",
        sessionId: "source_session",
        turnId: "source_turn",
        name: "create_improve.updated",
        timestamp,
        source: "server",
        status: "pending",
        data: { createImproveRun: snapshot },
      });

      const response = await service.scan({ force: true, trigger: "manual" });
      const [item] = response.items;
      const [run] = response.runs;
      const systemSession = response.systemSession;
      const projects = await listLocalProjects(store);

      expect(response.scanned).toBe(true);
      expect(systemSession).toMatchObject({
        systemKind: INSIGHTS_SYSTEM_KIND,
        hiddenFromDefaultSidebar: true,
      });
      expect(projects.find((project) => project.systemKind === INSIGHTS_SYSTEM_KIND)).toMatchObject({
        hiddenFromDefaultSidebar: true,
      });
      expect(run).toMatchObject({
        sessionId: systemSession?.id,
        turnId: "insights_turn_1",
        trigger: "manual",
        status: "completed",
        findingCount: 1,
        elapsedMs: expect.any(Number),
        usage: {
          usedTokens: 42,
          source: "provider_usage",
        },
      });
      expect(item).toMatchObject({
        status: "active",
        lastRunId: run?.id,
        lastRunSessionId: systemSession?.id,
        lastRunTurnId: "insights_turn_1",
        payload: {
          sessionId: "source_session",
          turnId: "source_turn",
          createImproveRunId: "create_pipeline_waiting",
          insightsRunId: run?.id,
          insightsRunSessionId: systemSession?.id,
          insightsRunTurnId: "insights_turn_1",
        },
      });
      const [turn] = await store.turnsForSession(systemSession!.id);
      expect(turn?.metadata.insightsRun).toMatchObject({
        id: run?.id,
        status: "completed",
        findingCount: 1,
        elapsedMs: expect.any(Number),
        usage: {
          usedTokens: 42,
        },
      });
      expect(turn?.metadata.insightsEvidencePreview).toMatchObject({
        eventCount: expect.any(Number),
        totalCount: 1,
        items: [
          expect.objectContaining({
            evidenceSource: "create_edit",
            evidenceKey: "create_pipeline_waiting",
          }),
        ],
      });

      await store.close();
    });
  });

  test("uses Insights preferences for background enablement and model selection", async () => {
    await withStoreDir(async (storeDir) => {
      const harness = createInsightsHarness(
        storeDir,
        AppPreferencesSchema.parse({
          insightsEnabled: false,
          insightsModelRef: { providerId: "openai", modelId: "gpt-4.1-mini" },
        }),
      );
      const snapshot = createPipelineSnapshot("create_pipeline_background", "edit", "blocked");
      await harness.appendRuntimeEvent({
        id: "source_event_background",
        sessionId: "source_session",
        turnId: "source_turn",
        name: "create_improve.updated",
        timestamp,
        source: "server",
        status: "failed",
        data: { createImproveRun: snapshot },
      });

      const skipped = await harness.service.scan({ trigger: "startup" });
      expect(skipped.scanned).toBe(false);
      expect(harness.sentTurns).toHaveLength(0);

      const manual = await harness.service.scan({ force: true, trigger: "manual" });
      expect(manual.scanned).toBe(true);
      expect(harness.sentTurns[0]?.modelRef).toEqual({ providerId: "openai", modelId: "gpt-4.1-mini" });
      expect(manual.systemSession).toMatchObject({
        provider: "openai",
        modelRef: { providerId: "openai", modelId: "gpt-4.1-mini" },
      });

      await harness.store.close();
    });
  });

  test("creates a separate Insights chat session for each executed scan", async () => {
    await withStoreDir(async (storeDir) => {
      const harness = createInsightsHarness(storeDir);
      const snapshot = createPipelineSnapshot("create_pipeline_per_run_session", "create", "awaiting_questions");
      await harness.appendRuntimeEvent({
        id: "source_event_per_run_session",
        sessionId: "source_session",
        turnId: "source_turn",
        name: "create_improve.updated",
        timestamp,
        source: "server",
        status: "pending",
        data: { createImproveRun: snapshot },
      });

      const first = await harness.service.scan({ force: true, trigger: "manual" });
      const second = await harness.service.scan({ force: true, trigger: "manual" });
      const listed = await harness.service.list();

      expect(first.systemSessionId).toBeTruthy();
      expect(second.systemSessionId).toBeTruthy();
      expect(second.systemSessionId).not.toBe(first.systemSessionId);
      expect(harness.sentTurns.map((turn) => turn.sessionId)).toEqual([
        first.systemSessionId,
        second.systemSessionId,
      ]);
      expect(listed.runs.map((run) => run.sessionId)).toEqual([
        second.systemSessionId,
        first.systemSessionId,
      ]);

      await harness.store.close();
    });
  });

  test("answers /insights questions in the Insights system session using run evidence", async () => {
    await withStoreDir(async (storeDir) => {
      const harness = createInsightsHarness(storeDir);
      const snapshot = createPipelineSnapshot("create_pipeline_question", "create", "awaiting_questions");
      await harness.appendRuntimeEvent({
        id: "source_event_question",
        sessionId: "source_session",
        turnId: "source_turn",
        name: "create_improve.updated",
        timestamp,
        source: "server",
        status: "pending",
        data: { createImproveRun: snapshot },
      });
      await harness.service.scan({ force: true, trigger: "manual" });

      const response = await harness.service.ask("Why is the create agent waiting?");
      const [scanTurn, questionTurn] = harness.sentTurns;

      expect(response.turnId).toBe("insights_turn_2");
      expect(response.systemSessionId).toBe(response.systemSession?.id);
      expect(questionTurn?.sessionId).toBe(response.systemSession?.id);
      expect(questionTurn?.prompt).toContain("User question:");
      expect(questionTurn?.prompt).toContain("Why is the create agent waiting?");
      expect(questionTurn?.prompt).toContain(scanTurn?.id ?? "");
      expect(questionTurn?.metadata.insightsQuestion).toMatchObject({
        question: "Why is the create agent waiting?",
        runCount: 1,
      });

      await harness.store.close();
    });
  });

  test("preserves dismissed insights when later scans see the same evidence", async () => {
    await withStoreDir(async (storeDir) => {
      const harness = createInsightsHarness(storeDir);
      const snapshot = createPipelineSnapshot("create_pipeline_dismissed", "edit", "blocked");
      await harness.appendRuntimeEvent({
        id: "source_event_dismissed",
        sessionId: "source_session",
        turnId: "source_turn",
        name: "create_improve.updated",
        timestamp,
        source: "server",
        status: "failed",
        data: { createImproveRun: snapshot },
      });

      const first = await harness.service.scan({ force: true, trigger: "manual" });
      const firstItem = first.items[0]!;
      await harness.service.patchStatus(firstItem.id, "dismissed");

      const second = await harness.service.scan({ force: true, trigger: "manual" });
      const dismissed = second.items.find((item) => item.id === firstItem.id);

      expect(dismissed).toMatchObject({
        id: firstItem.id,
        status: "dismissed",
        lastRunTurnId: "insights_turn_2",
      });

      await harness.store.close();
    });
  });

  test("records provider configuration failures as inspectable failed Insights runs", async () => {
    await withStoreDir(async (storeDir) => {
      const harness = createInsightsHarness(storeDir, AppPreferencesSchema.parse({}), {
        sendTurnError: new Error("Insights model is not configured."),
      });
      const snapshot = createPipelineSnapshot("create_pipeline_model_missing", "create", "blocked");
      await harness.appendRuntimeEvent({
        id: "source_event_model_missing",
        sessionId: "source_session",
        turnId: "source_turn",
        name: "create_improve.updated",
        timestamp,
        source: "server",
        status: "failed",
        data: { createImproveRun: snapshot },
      });

      const response = await harness.service.scan({ force: true, trigger: "manual" });
      const [run] = response.runs;
      const [turn] = await harness.store.turnsForSession(response.systemSessionId!);

      expect(response.scanned).toBe(true);
      expect(harness.sentTurns).toHaveLength(0);
      expect(run).toMatchObject({
        status: "failed",
        error: "Insights model is not configured.",
        turnId: turn?.id,
        elapsedMs: expect.any(Number),
      });
      expect(turn).toMatchObject({
        status: "failed",
        error: "Insights model is not configured.",
      });
      expect(turn?.metadata.insightsRun).toMatchObject({
        status: "failed",
        error: "Insights model is not configured.",
      });

      await harness.store.close();
    });
  });

  test("marks invalid structured output as a failed run without writing insight rows", async () => {
    await withStoreDir(async (storeDir) => {
      const harness = createInsightsHarness(storeDir, AppPreferencesSchema.parse({}), {
        buildStructuredOutput: async () => ({ summary: "", actions: [] }),
      });
      const snapshot = createPipelineSnapshot("create_pipeline_invalid_output", "create", "blocked");
      await harness.appendRuntimeEvent({
        id: "source_event_invalid_output",
        sessionId: "source_session",
        turnId: "source_turn",
        name: "create_improve.updated",
        timestamp,
        source: "server",
        status: "failed",
        data: { createImproveRun: snapshot },
      });

      const response = await harness.service.scan({ force: true, trigger: "manual" });
      const [run] = response.runs;

      expect(response.items).toHaveLength(0);
      expect(run).toMatchObject({
        status: "failed",
      });
      expect(run?.error).toContain("Too small");

      await harness.store.close();
    });
  });

  test("collects broader evidence sources and filters rows and runs by source", async () => {
    await withStoreDir(async (storeDir) => {
      const harness = createInsightsHarness(storeDir);
      await appendToolFailureEvidence(harness, "source_session_tools");
      await appendRepeatedCorrectionEvidence(harness, "source_session_corrections");
      await appendAbandonedGoalEvidence(harness, "source_session_goal");
      await appendUsageSpikeEvidence(harness);
      await harness.store.insertTurn(turnFixture({
        id: "failed_turn_1",
        sessionId: "source_session_failed",
        status: "failed",
        error: "Provider failed.",
      }));
      for (let index = 0; index < 8; index += 1) {
        await harness.store.insertTurn(turnFixture({
          id: `long_turn_${index}`,
          sessionId: "source_session_long",
          status: index === 7 ? "failed" : "completed",
          error: index === 7 ? "No resolution." : null,
        }));
      }

      const response = await harness.service.scan({ force: true, trigger: "manual" });
      const sources = response.items.map((item) => item.payload.evidenceSource).sort();

      expect(sources).toContain("tool_failure");
      expect(sources).toContain("user_correction");
      expect(sources).toContain("abandoned_goal");
      expect(sources).toContain("stuck_turn");
      expect(sources).toContain("unresolved_conversation");
      expect(sources).toContain("usage_anomaly");
      expect(response.runs[0]?.evidenceSources).toEqual(
        expect.arrayContaining([
          "tool_failure",
          "user_correction",
          "abandoned_goal",
          "stuck_turn",
          "unresolved_conversation",
          "usage_anomaly",
        ]),
      );

      const toolOnly = await harness.service.list({ evidenceSource: "tool_failure", runTrigger: "manual" });
      expect(toolOnly.items).toHaveLength(1);
      expect(toolOnly.items[0]?.payload.evidenceSource).toBe("tool_failure");
      expect(toolOnly.runs).toHaveLength(1);
      expect(toolOnly.runs[0]?.trigger).toBe("manual");
      const usageOnly = await harness.service.list({ evidenceSource: "usage_anomaly", runTrigger: "manual" });
      expect(usageOnly.items).toHaveLength(1);
      expect(usageOnly.items[0]?.payload).toMatchObject({
        detector: "usage-anomaly",
        anomalyKind: "model_usage_spike",
        provider: "openrouter",
        visibility: "user_facing",
      });

      const failedRuns = await harness.service.list({ runStatus: "failed" });
      expect(failedRuns.runs).toHaveLength(0);

      await harness.store.close();
    });
  });

  test("honors per-evidence-source enablement settings", async () => {
    await withStoreDir(async (storeDir) => {
      const harness = createInsightsHarness(
        storeDir,
        AppPreferencesSchema.parse({
          insightsEvidenceSources: {
            createEdit: false,
            stuckTurns: false,
            toolFailures: false,
            abandonedGoals: false,
            userCorrections: false,
            unresolvedConversations: false,
            usageAnomalies: false,
          },
        }),
      );
      await appendToolFailureEvidence(harness, "source_session_tools");

      const response = await harness.service.scan({ force: true, trigger: "manual" });

      expect(response.items).toHaveLength(0);
      expect(response.runs[0]?.evidenceSources).toEqual([]);

      await harness.store.close();
    });
  });

  test("defaults evidence source settings for legacy preferences during scans", async () => {
    await withStoreDir(async (storeDir) => {
      const legacyPreferences = {
        ...AppPreferencesSchema.parse({}),
        insightsEvidenceSources: undefined,
      } as unknown as AppPreferences;
      const harness = createInsightsHarness(storeDir, legacyPreferences);
      const snapshot = createPipelineSnapshot("legacy_preferences_pipeline", "edit", "awaiting_questions");
      await harness.appendRuntimeEvent({
        id: "legacy_preferences_event",
        sessionId: "legacy_preferences_session",
        turnId: "legacy_preferences_turn",
        name: "create_improve.updated",
        timestamp,
        source: "server",
        status: "pending",
        data: { createImproveRun: snapshot },
      });

      const response = await harness.service.scan({ force: true, trigger: "manual" });

      expect(response.items).toHaveLength(1);
      expect(response.runs[0]?.evidenceSources).toEqual(["create_edit"]);

      await harness.store.close();
    });
  });
});

function createInsightsHarness(
  storeDir: string,
  preferences: AppPreferences = AppPreferencesSchema.parse({}),
  options: {
    sendTurnError?: Error;
    buildStructuredOutput?: Parameters<typeof createInsightsService>[0]["buildStructuredOutput"];
  } = {},
) {
  const store = new SqliteStore(storeDir);
  const sentTurns: Turn[] = [];
  const appendRuntimeEvent = async (runtimeEvent: RuntimeEvent) => {
    await store.appendRuntimeEvent(runtimeEvent);
  };
  const sessionStore = createSessionStore({
    store,
    defaultSessionCwd: () => storeDir,
    appendRuntimeEvent,
  });
  const sendTurn = async (sessionId: string, payload: unknown): Promise<Turn> => {
    if (options.sendTurnError) throw options.sendTurnError;
    const input = payload as {
      prompt: string;
      modelRef?: Turn["modelRef"];
      metadata?: Turn["metadata"];
    };
    const turnNumber = sentTurns.length + 1;
    const startedAt = now();
    const turn: Turn = {
      id: `insights_turn_${turnNumber}`,
      sessionId,
      providerTurnId: `stub_provider_turn_${turnNumber}`,
      modelRef: input.modelRef ?? null,
      prompt: input.prompt,
      startedAt,
      completedAt: startedAt,
      status: "completed",
      error: null,
      metadata: input.metadata ?? {},
      createImproveRun: null,
    };
    await store.insertTurn(turn);
    sentTurns.push(turn);
    await appendRuntimeEvent(
      event({
        sessionId,
        turnId: turn.id,
        name: "turn.started",
        source: "chat_action",
        status: "started",
        args: { prompt: input.prompt, ...(input.metadata ?? {}) },
      }),
    );
    await appendRuntimeEvent(
      event({
        sessionId,
        turnId: turn.id,
        name: "session.context.updated",
        source: "server",
        status: "completed",
        data: {
          provider: input.modelRef?.providerId ?? "openpond",
          model: input.modelRef?.modelId ?? "openpond-chat",
          usedTokens: 42,
          maxContextTokens: 128000,
          usableContextTokens: 120000,
          percentFull: 1,
          source: "provider_usage",
          updatedAtEventId: null,
        },
      }),
    );
    await appendRuntimeEvent(
      event({
        sessionId,
        turnId: turn.id,
        name: "turn.completed",
        source: "provider",
        status: "completed",
      }),
    );
    return turn;
  };
  const service = createInsightsService({
    store,
    storeDir,
    createSession: sessionStore.createSession,
    updateSession: sessionStore.updateSession,
    sendTurn,
    appendRuntimeEvent,
    loadAppPreferences: async () => preferences,
    buildStructuredOutput: options.buildStructuredOutput,
  });
  return {
    appendRuntimeEvent,
    sentTurns,
    service,
    store,
  };
}

async function withStoreDir(fn: (storeDir: string) => Promise<void>): Promise<void> {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-insights-test-"));
  try {
    await fn(storeDir);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
}

async function appendToolFailureEvidence(
  harness: ReturnType<typeof createInsightsHarness>,
  sessionId: string,
): Promise<void> {
  for (let index = 0; index < 2; index += 1) {
    await harness.appendRuntimeEvent({
      id: `tool_failure_${index}`,
      sessionId,
      turnId: `tool_turn_${index}`,
      name: "tool.completed",
      timestamp,
      source: "server",
      action: "workspace.apply",
      status: "failed",
      error: "Patch failed.",
      args: { action: "workspace.apply" },
    });
  }
}

async function appendRepeatedCorrectionEvidence(
  harness: ReturnType<typeof createInsightsHarness>,
  sessionId: string,
): Promise<void> {
  const prompts = [
    "I told you to use the existing goal loop.",
    "You did not do what I asked, fix this.",
  ];
  for (let index = 0; index < prompts.length; index += 1) {
    await harness.appendRuntimeEvent({
      id: `correction_${index}`,
      sessionId,
      turnId: `correction_turn_${index}`,
      name: "turn.started",
      timestamp,
      source: "chat_action",
      status: "started",
      args: { prompt: prompts[index] },
    });
  }
}

async function appendAbandonedGoalEvidence(
  harness: ReturnType<typeof createInsightsHarness>,
  sessionId: string,
): Promise<void> {
  await harness.appendRuntimeEvent({
    id: "abandoned_goal_1",
    sessionId,
    turnId: "goal_turn_1",
    name: "diagnostic",
    timestamp: "2026-07-01T09:00:00.000Z",
    source: "server",
    status: "completed",
    data: {
      kind: "thread_goal",
      goal: {
        id: "goal_abandoned_1",
        objective: "Finish the current task",
        status: "active",
        startedAt: "2026-07-01T09:00:00.000Z",
      },
    },
  });
}

async function appendUsageSpikeEvidence(
  harness: ReturnType<typeof createInsightsHarness>,
): Promise<void> {
  const anchorMs = Date.now();
  for (let index = 0; index < 3; index += 1) {
    await harness.store.upsertModelUsageRecord(usageRecord({
      requestId: `usage_baseline_${index}`,
      startedAt: new Date(anchorMs - (index + 2) * 24 * 60 * 60 * 1000).toISOString(),
      totalTokens: 1000,
    }));
  }
  await harness.store.upsertModelUsageRecord(usageRecord({
    requestId: "usage_current_spike",
    startedAt: new Date(anchorMs - 60 * 60 * 1000).toISOString(),
    totalTokens: 6200,
  }));
  await harness.store.upsertModelUsageRecord(usageRecord({
    requestId: "usage_insights_self",
    sessionId: "insights_self_session",
    turnId: "insights_self_turn",
    startedAt: new Date(anchorMs - 30 * 60 * 1000).toISOString(),
    requestKind: "insights_scan",
    visibility: "system",
    totalTokens: 200_000,
    attribution: {
      ...usageRecord().attribution,
      surface: "insights",
      workflowKind: "scan",
      sessionId: "insights_self_session",
      turnId: "insights_self_turn",
      insightRunId: "insights_self_run",
    },
  }));
}

function usageRecord(patch: Partial<ModelUsageRecord> = {}): ModelUsageRecord {
  return {
    id: `record_${patch.requestId ?? "usage_default"}`,
    requestId: "usage_default",
    requestOrdinal: 0,
    sessionId: "source_session_usage",
    turnId: "source_turn_usage",
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    route: "local_byok",
    source: "provider_usage",
    requestKind: "chat_turn",
    visibility: "user_facing",
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 1000,
    firstTokenMs: 100,
    promptTokens: null,
    completionTokens: null,
    totalTokens: 1000,
    errorType: null,
    errorMessage: null,
    ...patch,
    attribution: {
      surface: "chat",
      workflowKind: "direct_chat",
      sessionId: patch.sessionId ?? "source_session_usage",
      turnId: patch.turnId ?? "source_turn_usage",
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
      ...(patch.attribution ?? {}),
    },
  };
}

function turnFixture(input: {
  id: string;
  sessionId: string;
  status: Turn["status"];
  error?: string | null;
}): Turn {
  return {
    id: input.id,
    sessionId: input.sessionId,
    providerTurnId: null,
    modelRef: { providerId: "openpond", modelId: "openpond-chat" },
    prompt: `Prompt for ${input.id}`,
    startedAt: "2026-07-01T09:00:00.000Z",
    completedAt: input.status === "in_progress" ? null : "2026-07-01T09:01:00.000Z",
    status: input.status,
    error: input.error ?? null,
    metadata: {},
    createImproveRun: null,
  };
}

function createPipelineSnapshot(
  id: string,
  operation: "create" | "edit",
  state: CreateImproveRun["state"],
): CreateImproveRun {
  const canonicalOperation = operation === "edit" ? "improve" : "create";
  return createImproveRunFixture({
    id,
    operation: canonicalOperation,
    surface: canonicalOperation === "improve" ? "direct_prompt_improve" : "direct_prompt_create",
    command: canonicalOperation === "improve" ? "/edit" : "/create",
    objective: canonicalOperation === "improve" ? "Refine an agent" : "Create an agent",
    state,
    blockedReason: state === "blocked" ? "Source application failed." : null,
    scope: {
      profileId: "default",
      conversationId: "source_session",
      originTurnId: "source_turn",
      workItemId: null,
      projectId: null,
      targetProject: null,
    },
    target: {
      kind: "agent",
      id: "insights-agent",
      displayName: "Insights Agent",
      defaultActionKey: "insights-agent.chat",
    },
    updatedAt: timestamp,
    createdAt: timestamp,
  });
}
