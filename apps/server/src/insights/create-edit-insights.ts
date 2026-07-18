import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CreateImproveRunSchema,
  InsightsAskResponseSchema,
  InsightsListResponseSchema,
  InsightsScanResponseSchema,
  InsightsEvidenceSourceSettingsSchema,
  InsightItemSchema,
  type AppPreferences,
  type CreateImproveRun,
  type InsightItem,
  type InsightEvidenceSource,
  type InsightRun,
  type InsightRunStatus,
  type InsightRunTrigger,
  type InsightSeverity,
  type InsightStatus,
  type InsightSummary,
  type InsightsListResponse,
  type InsightsScanResponse,
  type InsightsAskResponse,
  type ModelUsageRecord,
  type RuntimeEvent,
  type Session,
  type Turn,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { event, now } from "../utils.js";
import {
  INSIGHTS_SYSTEM_KIND,
  createInsightsSystemSession,
  ensureInsightsSystemProject,
  listInsightsRunsForSessions,
  listInsightsSystemSessions,
  initialInsightsRunMetadata,
  withInsightsRunMetadata,
  type InsightsRunMetadata,
} from "./insights-system.js";
import {
  detectUsageAnomalyInsights,
  type UsageAnomalyInsightDetectorCandidate,
} from "./usage-anomaly-insights.js";
import {
  detectAbandonedGoals,
  detectLongRunningUnresolvedConversations,
  detectRepeatedToolFailures,
  detectRepeatedUserCorrections,
  detectStuckOrFailedTurns,
  type InsightEvidenceCandidate,
  type RuntimeEventEntry,
} from "./insight-evidence-detectors.js";

const MAX_INSIGHT_SUMMARY_CHARS = 360;
const INSIGHTS_RUN_PROMPT_MAX_JSON_CHARS = 14_000;
const USAGE_ANOMALY_SCAN_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;

export type CreateEditInsightDetectorCandidate = {
  item: InsightItem | null;
  createImproveRunId: string;
  keepFingerprint: string | null;
};

type InsightsListQuery = {
  status?: InsightStatus | "all" | null;
  limit?: number;
  evidenceSource?: InsightEvidenceSource | "all" | null;
  runStatus?: InsightRunStatus | "all" | null;
  runTrigger?: InsightRunTrigger | "all" | null;
  runModel?: string | null;
};

type BuildStructuredInsightsOutput = (input: {
  candidates: InsightEvidenceCandidate[];
  schema: unknown;
  prompt: string;
  turn: Turn;
}) => Promise<unknown>;

type InsightsLogger = {
  warn(message: string, metadata?: Record<string, unknown>): void;
};

const InsightsStructuredActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("upsert"),
    item: InsightItemSchema,
  }),
  z.object({
    action: z.literal("resolve"),
    insightId: z.string().trim().min(1),
    fingerprint: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  }),
  z.object({
    action: z.literal("dismiss"),
    insightId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  }),
  z.object({
    action: z.literal("no_op"),
    createImproveRunId: z.string().trim().min(1).nullable(),
    reason: z.string().trim().min(1),
  }),
]);

const InsightsStructuredRunOutputSchema = z.object({
  summary: z.string().trim().min(1),
  actions: z.array(InsightsStructuredActionSchema),
});

type InsightsStructuredRunOutput = z.infer<typeof InsightsStructuredRunOutputSchema>;

export type InsightsService = {
  list: (query?: InsightsListQuery) => Promise<InsightsListResponse>;
  scan: (options?: { force?: boolean; trigger?: InsightRunTrigger }) => Promise<InsightsScanResponse>;
  ask: (question: string) => Promise<InsightsAskResponse>;
  patchStatus: (id: string, status: InsightStatus) => Promise<InsightsListResponse>;
};

export function createInsightsService(options: {
  store: SqliteStore;
  storeDir: string;
  createSession: (payload: unknown) => Promise<Session>;
  updateSession: (sessionId: string, patch: Partial<Session>) => Promise<Session>;
  sendTurn: (sessionId: string, payload: unknown) => Promise<Turn>;
  appendRuntimeEvent: (runtimeEvent: RuntimeEvent) => Promise<void>;
  loadAppPreferences: () => Promise<AppPreferences>;
  buildStructuredOutput?: BuildStructuredInsightsOutput;
  logger?: InsightsLogger;
}): InsightsService {
  const { store, logger } = options;
  let lastScannedCreatePipelineSequence = 0;

  async function list(query: InsightsListQuery = {}): Promise<InsightsListResponse> {
    await ensureInsightsSystemProject({ store, storeDir: options.storeDir });
    const systemSessions = await listInsightsSystemSessions(store);
    const [rawItems, rawRuns] = await Promise.all([
      store.listInsights(query),
      listInsightsRunsForSessions(store, systemSessions),
    ]);
    const items = filterInsightItems(rawItems, query);
    const runs = filterInsightRuns(rawRuns, query);
    const latestSession = systemSessions[0] ?? null;
    return insightsListResponse(items, {
      runs,
      systemSessionId: latestSession?.id ?? null,
      systemSession: latestSession,
    });
  }

  async function scan(scanOptions: { force?: boolean; trigger?: InsightRunTrigger } = {}): Promise<InsightsScanResponse> {
    const timestamp = now();
    const trigger = scanOptions.trigger ?? "manual";
    const preferences = await options.loadAppPreferences();
    if (!preferences.insightsEnabled && (trigger === "startup" || trigger === "interval")) {
      return InsightsScanResponseSchema.parse({
        ...(await list()),
        scannedAt: timestamp,
        scanned: false,
      });
    }
    const enabledSources = enabledInsightEvidenceSources(preferences);
    const previousSessions = await listInsightsSystemSessions(store);
    const previousRuns = await listInsightsRunsForSessions(store, previousSessions, 50);
    const previousConsumedSequence = Math.max(
      lastScannedCreatePipelineSequence,
      ...previousRuns.map((run) => run.sourceEventSequence ?? 0),
    );
    const latestSequence = await store.latestEventSequence();
    const afterSequence = scanOptions.force ? 0 : previousConsumedSequence;
    const usageStartedAtFrom = enabledSources.has("usage_anomaly")
      ? new Date(Date.parse(timestamp) - USAGE_ANOMALY_SCAN_WINDOW_MS).toISOString()
      : null;
    const [eventWindow, pageRows, turns, usageRecords] = await Promise.all([
      store.recentRuntimeEventWindow(2_000),
      store.runtimeEventPageRows({
        sessionId: null,
        afterSequence,
        beforeSequence: null,
        limit: 2_000,
      }),
      store.recentTurns(2_000),
      usageStartedAtFrom
        ? store.listModelUsageRecords({
            startedAtFrom: usageStartedAtFrom,
            startedAtTo: timestamp,
            limit: 10_000,
          })
        : Promise.resolve([] as ModelUsageRecord[]),
    ]);
    const entries = scanOptions.force ? eventWindow.entries : pageRows.entries;
    const candidates = collectInsightEvidence({
      entries,
      contextEntries: eventWindow.entries,
      turns,
      usageRecords,
      enabledSources,
      timestamp,
    });
    const evidenceSources = Array.from(new Set(candidates.map((candidate) => candidate.evidenceSource))).sort();

    if (!scanOptions.force && latestSequence <= previousConsumedSequence && candidates.length === 0) {
      lastScannedCreatePipelineSequence = Math.max(lastScannedCreatePipelineSequence, latestSequence);
      return InsightsScanResponseSchema.parse({
        ...(await list()),
        scannedAt: timestamp,
        scanned: false,
      });
    }

    const evidenceHash = insightEvidenceHash(entries, candidates);
    if (!scanOptions.force && previousRuns.some((run) => run.evidenceHash === evidenceHash)) {
      lastScannedCreatePipelineSequence = Math.max(lastScannedCreatePipelineSequence, latestSequence);
      return InsightsScanResponseSchema.parse({
        ...(await list()),
        scannedAt: timestamp,
        scanned: false,
      });
    }

    const session = await createInsightsSystemSession(options, {
      title: insightsRunSessionTitle(trigger, timestamp),
    });
    const runMetadata = initialInsightsRunMetadata({
      id: `insights_run_${hashId(`${session.id}:${trigger}:${timestamp}:${evidenceHash}`)}`,
      trigger,
      evidenceHash,
      sourceEventSequence: latestSequence,
      evidenceSources,
    });
    const prompt = insightsRunPrompt({
      trigger,
      afterSequence,
      latestSequence,
      entries,
      candidates,
      evidenceSources,
    });
    const evidencePreview = insightsRunEvidencePreview({
      trigger,
      afterSequence,
      latestSequence,
      entries,
      candidates,
      evidenceSources,
    });
    let turn: Turn;
    try {
      turn = await options.sendTurn(session.id, {
        prompt,
        cwd: session.cwd,
        modelRef: session.modelRef ?? undefined,
        metadata: {
          insightsRun: runMetadata,
          insightsEvidencePreview: evidencePreview,
          threadGoal: insightsThreadGoal(runMetadata),
        },
      });
    } catch (error) {
      const failedMetadata = completeInsightsRunMetadata(runMetadata, {
        status: "failed",
        completedAt: now(),
        error: errorMessage(error, "Insights model run failed before a turn could start."),
      });
      const failedTurn = await insertFailedInsightsTurn({
        session,
        prompt,
        metadata: failedMetadata,
        evidencePreview,
        error: failedMetadata.error ?? "Insights model run failed.",
      });
      await appendInsightsGoalEvent(session, failedTurn.id, failedMetadata);
      lastScannedCreatePipelineSequence = Math.max(lastScannedCreatePipelineSequence, latestSequence);
      return InsightsScanResponseSchema.parse({
        ...(await list()),
        scannedAt: timestamp,
        scanned: true,
      });
    }

    if (turn.status !== "completed") {
      const failedMetadata = await completeInsightsRunMetadataForTurn(runMetadata, turn, {
        status: "failed",
        completedAt: turn.completedAt ?? now(),
        error: turn.error ?? "Insights model run failed.",
      });
      await store.updateTurn(turn.id, (current) => withInsightsRunMetadata(current, failedMetadata));
      await appendInsightsGoalEvent(session, turn.id, failedMetadata);
      lastScannedCreatePipelineSequence = Math.max(lastScannedCreatePipelineSequence, latestSequence);
      return InsightsScanResponseSchema.parse({
        ...(await list()),
        scannedAt: timestamp,
        scanned: true,
      });
    }

    let stats: Awaited<ReturnType<typeof persistInsightCandidates>>;
    try {
      stats = await persistInsightCandidates({
        candidates,
        prompt,
        turn,
        latestSequence,
        runSessionId: session.id,
        runTurnId: turn.id,
        runId: runMetadata.id,
      });
    } catch (error) {
      const failedMetadata = await completeInsightsRunMetadataForTurn(runMetadata, turn, {
        status: "failed",
        completedAt: turn.completedAt ?? now(),
        error: errorMessage(error, "Insights structured output was invalid."),
      });
      await store.updateTurn(turn.id, (current) => withInsightsRunMetadata(current, failedMetadata));
      await appendInsightsGoalEvent(session, turn.id, failedMetadata);
      lastScannedCreatePipelineSequence = Math.max(lastScannedCreatePipelineSequence, latestSequence);
      return InsightsScanResponseSchema.parse({
        ...(await list()),
        scannedAt: timestamp,
        scanned: true,
      });
    }
    if (entries.length > 0 && candidates.length === 0) {
      logger?.warn("insights scan found runtime events but produced no candidates", {
        eventCount: entries.length,
        afterSequence,
        latestSequence,
      });
    }
    const completedMetadata = await completeInsightsRunMetadataForTurn(runMetadata, turn, {
      status: "completed",
      completedAt: now(),
      findingCount: stats.findingCount,
      createdCount: stats.createdCount,
      updatedCount: stats.updatedCount,
      resolvedCount: stats.resolvedCount,
      summary: insightRunSummary(stats),
      error: null,
    });
    await store.updateTurn(turn.id, (current) => withInsightsRunMetadata(current, completedMetadata));
    await appendInsightsGoalEvent(session, turn.id, completedMetadata);
    lastScannedCreatePipelineSequence = Math.max(lastScannedCreatePipelineSequence, latestSequence);

    return InsightsScanResponseSchema.parse({
      ...(await list()),
      scannedAt: timestamp,
      scanned: true,
    });
  }

  async function persistInsightCandidates(input: {
    candidates: InsightEvidenceCandidate[];
    prompt: string;
    turn: Turn;
    latestSequence: number;
    runSessionId: string;
    runTurnId: string;
    runId: string;
  }): Promise<{
    findingCount: number;
    createdCount: number;
    updatedCount: number;
    resolvedCount: number;
  }> {
    const output = InsightsStructuredRunOutputSchema.parse(
      await structuredOutputForTurn({
        candidates: input.candidates,
        prompt: input.prompt,
        turn: input.turn,
      }),
    );
    return applyStructuredRunOutput({
      output,
      latestSequence: input.latestSequence,
      runSessionId: input.runSessionId,
      runTurnId: input.runTurnId,
      runId: input.runId,
    });
  }

  async function buildStructuredRunOutput(input: {
    candidates: InsightEvidenceCandidate[];
  }): Promise<InsightsStructuredRunOutput> {
    const { candidates } = input;
    const currentByEvidenceId = new Map<string, Set<string>>();
    const currentEvidenceSources = new Set<InsightEvidenceSource>();
    const actions: InsightsStructuredRunOutput["actions"] = [];
    let upsertCount = 0;
    let noOpCount = 0;
    let resolveCount = 0;

    for (const candidate of candidates) {
      currentEvidenceSources.add(candidate.evidenceSource);
      const evidenceId = evidenceIdentity(candidate.evidenceSource, candidate.evidenceKey);
      const keep = currentByEvidenceId.get(evidenceId) ?? new Set<string>();
      if (candidate.keepFingerprint) keep.add(candidate.keepFingerprint);
      currentByEvidenceId.set(evidenceId, keep);
      if (candidate.item) {
        upsertCount += 1;
        actions.push({
          action: "upsert",
          item: candidate.item,
        });
      } else {
        noOpCount += 1;
        actions.push({
          action: "no_op",
          createImproveRunId: candidate.evidenceKey,
          reason: "Latest evidence state does not need an active insight.",
        });
      }
    }

    if (currentByEvidenceId.size > 0) {
      const activeItems = await store.listInsights({ status: "active", limit: 500 });
      for (const item of activeItems) {
        const evidenceSource = insightEvidenceSource(item) ?? "create_edit";
        if (!currentEvidenceSources.has(evidenceSource)) continue;
        const evidenceKey = insightEvidenceKey(item);
        if (!evidenceKey) continue;
        const keep = currentByEvidenceId.get(evidenceIdentity(evidenceSource, evidenceKey));
        if (!keep || keep.has(item.fingerprint)) continue;
        resolveCount += 1;
        actions.push({
          action: "resolve",
          insightId: item.id,
          fingerprint: item.fingerprint,
          reason: "Latest Create/Improve state no longer matches this active insight.",
        });
      }
    }

    return InsightsStructuredRunOutputSchema.parse({
      summary: structuredRunOutputSummary({
        upsertCount,
        resolveCount,
        noOpCount,
      }),
      actions,
    });
  }

  async function structuredOutputForTurn(input: {
    candidates: InsightEvidenceCandidate[];
    prompt: string;
    turn: Turn;
  }): Promise<unknown> {
    const turnOutput = input.turn.metadata?.insightsStructuredOutput;
    if (turnOutput !== undefined) return turnOutput;
    if (options.buildStructuredOutput) {
      return options.buildStructuredOutput({
        candidates: input.candidates,
        schema: insightsStructuredOutputSchemaDescription(),
        prompt: input.prompt,
        turn: input.turn,
      });
    }
    return buildStructuredRunOutput({ candidates: input.candidates });
  }

  async function applyStructuredRunOutput(input: {
    output: InsightsStructuredRunOutput;
    latestSequence: number;
    runSessionId: string;
    runTurnId: string;
    runId: string;
  }): Promise<{
    findingCount: number;
    createdCount: number;
    updatedCount: number;
    resolvedCount: number;
  }> {
    let createdCount = 0;
    let updatedCount = 0;
    let resolvedCount = 0;
    let findingCount = 0;

    for (const action of input.output.actions) {
      if (action.action === "no_op") continue;
      if (action.action === "dismiss") {
        await store.patchInsightStatus(action.insightId, "dismissed");
        continue;
      }
      if (action.action === "resolve") {
        const resolved = await store.patchInsightStatus(action.insightId, "resolved");
        if (!resolved) continue;
        resolvedCount += 1;
        await store.upsertInsightItem(
          linkInsightItemToRun(resolved, {
            runId: input.runId,
            runSessionId: input.runSessionId,
            runTurnId: input.runTurnId,
            sourceEventSequence: input.latestSequence,
          }),
        );
        continue;
      }
      const item = action.item;
      findingCount += 1;
      const existing = await store.getInsightItem(item.id);
      await store.upsertInsightItem(
        linkInsightItemToRun(item, {
          runId: input.runId,
          runSessionId: input.runSessionId,
          runTurnId: input.runTurnId,
          sourceEventSequence: input.latestSequence,
        }),
      );
      if (existing) updatedCount += 1;
      else createdCount += 1;
    }

    return {
      findingCount,
      createdCount,
      updatedCount,
      resolvedCount,
    };
  }

  async function appendInsightsGoalEvent(
    session: Session,
    turnId: string,
    metadata: InsightsRunMetadata,
  ): Promise<void> {
    await options.appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId,
        name: "diagnostic",
        source: "server",
        appId: session.appId,
        status: metadata.status === "failed" ? "failed" : "completed",
        output: metadata.summary ?? metadata.error ?? "Insights goal updated",
        data: {
          kind: "thread_goal",
          provider: INSIGHTS_SYSTEM_KIND,
          goal: insightsThreadGoal(metadata),
        },
      }),
    );
  }

  async function insertFailedInsightsTurn(input: {
    session: Session;
    prompt: string;
    metadata: InsightsRunMetadata;
    evidencePreview?: Record<string, unknown>;
    error: string;
  }): Promise<Turn> {
    const turn: Turn = {
      id: `insights_failed_turn_${hashId(`${input.session.id}:${input.metadata.id}:${input.metadata.completedAt}`)}`,
      sessionId: input.session.id,
      providerTurnId: null,
      modelRef: input.session.modelRef ?? null,
      prompt: input.prompt,
      startedAt: input.metadata.startedAt,
      completedAt: input.metadata.completedAt ?? now(),
      status: "failed",
      error: input.error,
      metadata: {
        insightsRun: input.metadata,
        ...(input.evidencePreview ? { insightsEvidencePreview: input.evidencePreview } : {}),
        threadGoal: insightsThreadGoal(input.metadata),
      },
      createImproveRun: null,
    };
    await store.insertTurn(turn);
    await options.appendRuntimeEvent(
      event({
        sessionId: input.session.id,
        turnId: turn.id,
        name: "turn.started",
        source: "server",
        appId: input.session.appId,
        args: {
          prompt: input.prompt,
          insightsRun: input.metadata,
          ...(input.evidencePreview ? { insightsEvidencePreview: input.evidencePreview } : {}),
          threadGoal: insightsThreadGoal(input.metadata),
        },
        status: "started",
      }),
    );
    await options.appendRuntimeEvent(
      event({
        sessionId: input.session.id,
        turnId: turn.id,
        name: "turn.failed",
        source: "server",
        appId: input.session.appId,
        status: "failed",
        output: input.error,
        error: input.error,
      }),
    );
    return turn;
  }

  async function completeInsightsRunMetadataForTurn(
    metadata: InsightsRunMetadata,
    turn: Turn,
    patch: Partial<InsightsRunMetadata> & {
      status: InsightsRunMetadata["status"];
      completedAt: string;
    },
  ): Promise<InsightsRunMetadata> {
    return completeInsightsRunMetadata(metadata, {
      ...patch,
      usage: await store.latestContextUsageForTurn(turn.sessionId, turn.id),
    });
  }

  async function patchStatus(id: string, status: InsightStatus): Promise<InsightsListResponse> {
    const updated = await store.patchInsightStatus(id, status);
    if (!updated) throw new Error("Insight not found");
    return list();
  }

  async function ask(question: string): Promise<InsightsAskResponse> {
    const [items, systemSessions] = await Promise.all([
      store.listInsights({ status: "all", limit: 200 }),
      listInsightsSystemSessions(store),
    ]);
    const runs = await listInsightsRunsForSessions(store, systemSessions, 20);
    const prompt = insightsQuestionPrompt({
      question,
      items,
      runs,
    });
    const startedAt = now();
    const session = await createInsightsSystemSession(options, {
      title: insightsQuestionSessionTitle(startedAt),
    });
    const goal = {
      id: `insights_question_${hashId(`${session.id}:${startedAt}:${question}`)}`,
      provider: INSIGHTS_SYSTEM_KIND,
      objective: `Answer an Insights question: ${compactInsightSummary(question)}`,
      status: "active",
      startedAt,
    };
    const turn = await options.sendTurn(session.id, {
      prompt,
      cwd: session.cwd,
      modelRef: session.modelRef ?? undefined,
      metadata: {
        insightsQuestion: {
          question,
          runCount: runs.length,
          insightCount: items.length,
          startedAt,
        },
        threadGoal: goal,
      },
    });
    await options.appendRuntimeEvent(
      event({
        sessionId: session.id,
        turnId: turn.id,
        name: "diagnostic",
        source: "server",
        appId: session.appId,
        status: turn.status === "failed" ? "failed" : "completed",
        output: turn.status === "failed" ? turn.error ?? "Insights question failed" : "Insights question answered",
        data: {
          kind: "thread_goal",
          provider: INSIGHTS_SYSTEM_KIND,
          goal: {
            ...goal,
            status: turn.status === "failed" ? "blocked" : "complete",
            completedAt: turn.completedAt ?? now(),
            error: turn.error ?? null,
          },
        },
      }),
    );
    return InsightsAskResponseSchema.parse({
      ...insightsListResponse(items, {
        runs,
        systemSessionId: session.id,
        systemSession: session,
      }),
      turnId: turn.id,
    });
  }

  return { list, scan, ask, patchStatus };
}

export function detectCreateEditInsights(
  entries: RuntimeEventEntry[],
  timestamp: string = now(),
): CreateEditInsightDetectorCandidate[] {
  const latestByRunId = new Map<string, RuntimeEventEntry>();
  for (const entry of entries) {
    const run = parseCreateImproveRunFromEvent(entry.event);
    if (!run || !isCreateImproveRun(run)) continue;
    latestByRunId.set(run.id, entry);
  }

  const candidates: CreateEditInsightDetectorCandidate[] = [];
  for (const entry of latestByRunId.values()) {
    const run = parseCreateImproveRunFromEvent(entry.event);
    if (!run) continue;
    const attention = attentionForRun(run);
    if (!attention) {
      candidates.push({
        createImproveRunId: run.id,
        keepFingerprint: null,
        item: null,
      });
      continue;
    }
    const item = insightItemForRun({
      entry,
      run,
      attention,
      timestamp,
    });
    candidates.push({
      createImproveRunId: run.id,
      keepFingerprint: item.fingerprint,
      item,
    });
  }
  return candidates;
}

function collectInsightEvidence(input: {
  entries: RuntimeEventEntry[];
  contextEntries: RuntimeEventEntry[];
  turns: Turn[];
  usageRecords: ModelUsageRecord[];
  enabledSources: Set<InsightEvidenceSource>;
  timestamp: string;
}): InsightEvidenceCandidate[] {
  const candidates: InsightEvidenceCandidate[] = [];
  if (input.enabledSources.has("create_edit")) {
    candidates.push(
      ...detectCreateEditInsights(input.entries, input.timestamp).map((candidate) =>
        createEditEvidenceCandidate(candidate),
      ),
    );
  }
  if (input.enabledSources.has("tool_failure")) {
    candidates.push(...detectRepeatedToolFailures(input.contextEntries, input.timestamp));
  }
  if (input.enabledSources.has("stuck_turn")) {
    candidates.push(...detectStuckOrFailedTurns(input.turns, input.timestamp));
  }
  if (input.enabledSources.has("abandoned_goal")) {
    candidates.push(...detectAbandonedGoals(input.contextEntries, input.timestamp));
  }
  if (input.enabledSources.has("user_correction")) {
    candidates.push(...detectRepeatedUserCorrections(input.contextEntries, input.timestamp));
  }
  if (input.enabledSources.has("unresolved_conversation")) {
    candidates.push(...detectLongRunningUnresolvedConversations(input.turns, input.timestamp));
  }
  if (input.enabledSources.has("usage_anomaly")) {
    candidates.push(
      ...detectUsageAnomalyInsights(input.usageRecords, input.timestamp).map((candidate) =>
        usageAnomalyEvidenceCandidate(candidate),
      ),
    );
  }
  return candidates;
}

function createEditEvidenceCandidate(candidate: CreateEditInsightDetectorCandidate): InsightEvidenceCandidate {
  return {
    item: candidate.item ? withEvidencePayload(candidate.item, "create_edit", candidate.createImproveRunId) : null,
    evidenceSource: "create_edit",
    evidenceKey: candidate.createImproveRunId,
    keepFingerprint: candidate.keepFingerprint,
  };
}

function usageAnomalyEvidenceCandidate(candidate: UsageAnomalyInsightDetectorCandidate): InsightEvidenceCandidate {
  return {
    item: candidate.item,
    evidenceSource: "usage_anomaly",
    evidenceKey: candidate.evidenceKey,
    keepFingerprint: candidate.keepFingerprint,
  };
}

function parseCreateImproveRunFromEvent(event: RuntimeEvent): CreateImproveRun | null {
  if (event.name !== "create_improve.updated") return null;
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
  const parsedRun = CreateImproveRunSchema.safeParse(data.createImproveRun);
  if (parsedRun.success) return parsedRun.data;
  return null;
}

function isCreateImproveRun(run: CreateImproveRun): boolean {
  const parsed = CreateImproveRunSchema.safeParse(run);
  return parsed.success && (parsed.data.operation === "create" || parsed.data.operation === "improve");
}

function attentionForRun(run: CreateImproveRun): {
  severity: InsightSeverity;
  type: string;
  title: string;
  summary: string;
} | null {
  const operationLabel = run.operation === "improve" ? "Improve workproduct" : "Create workproduct";
  if (run.state === "awaiting_questions") {
    return {
      severity: "concern",
      type: "create_edit.awaiting_questions",
      title: `${operationLabel} is waiting for answers`,
      summary: compactInsightSummary(
        run.questions.find((question) => question.status === "pending")?.prompt ??
          `${operationLabel} needs user input before planning can continue.`,
      ),
    };
  }
  if (run.state === "awaiting_plan_approval") {
    return {
      severity: "concern",
      type: "create_edit.awaiting_plan_approval",
      title: `${operationLabel} is waiting for plan approval`,
      summary: compactInsightSummary(
        run.plan?.summary ?? `${operationLabel} needs plan approval before source changes run.`,
      ),
    };
  }
  if (run.state === "blocked") {
    return {
      severity: "blocker",
      type: "create_edit.blocked",
      title: `${operationLabel} is blocked`,
      summary: compactInsightSummary(
        run.blockedReason ?? `${operationLabel} cannot continue until the blocker is resolved.`,
      ),
    };
  }
  if (run.state === "failed") {
    return {
      severity: "blocker",
      type: "create_edit.failed",
      title: `${operationLabel} failed`,
      summary: compactInsightSummary(
        run.blockedReason ?? `${operationLabel} failed during the Create/Improve flow.`,
      ),
    };
  }
  return null;
}

function compactInsightSummary(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_INSIGHT_SUMMARY_CHARS) return normalized;
  return `${normalized.slice(0, MAX_INSIGHT_SUMMARY_CHARS - 3).trimEnd()}...`;
}

function insightItemForRun(input: {
  entry: RuntimeEventEntry;
  run: CreateImproveRun;
  attention: NonNullable<ReturnType<typeof attentionForRun>>;
  timestamp: string;
}): InsightItem {
  const { entry, run, attention, timestamp } = input;
  const scopeType = entry.event.sessionId ? "session" : "global";
  const scopeId = entry.event.sessionId ?? "local";
  const fingerprint = [
    "openpond.insights",
    "create-edit",
    run.id,
    run.state,
  ].join(":");
  return {
    id: `insight_${hashId(fingerprint)}`,
    scopeType,
    scopeId,
    severity: attention.severity,
    type: attention.type,
    status: "active",
    fingerprint,
    title: attention.title,
    summary: attention.summary,
    payload: {
      detector: "create-improve-run-state",
      evidenceSource: "create_edit",
      evidenceKey: run.id,
      sessionId: entry.event.sessionId ?? null,
      turnId: entry.event.turnId ?? null,
      createImproveRunId: run.id,
      createImproveRunState: run.state,
      createImproveRunOperation: run.operation,
      sourceEventId: entry.event.id,
      sourceEventSequence: entry.sequence,
    },
    lastRunId: null,
    lastRunSessionId: null,
    lastRunTurnId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    resolvedAt: null,
    dismissedAt: null,
  };
}

function withEvidencePayload(
  item: InsightItem,
  evidenceSource: InsightEvidenceSource,
  evidenceKey: string,
): InsightItem {
  return {
    ...item,
    payload: {
      ...item.payload,
      evidenceSource,
      evidenceKey,
    },
  };
}

function insightEvidenceKey(item: InsightItem): string | null {
  const evidenceKey = item.payload.evidenceKey;
  if (typeof evidenceKey === "string" && evidenceKey.trim()) return evidenceKey;
  const value = item.payload.createImproveRunId;
  return typeof value === "string" && value.trim() ? value : null;
}

function insightEvidenceSource(item: InsightItem): InsightEvidenceSource | null {
  const value = item.payload.evidenceSource;
  return isInsightEvidenceSource(value) ? value : null;
}

function evidenceIdentity(source: InsightEvidenceSource, key: string): string {
  return `${source}\u0000${key}`;
}

function enabledInsightEvidenceSources(preferences: AppPreferences): Set<InsightEvidenceSource> {
  const settings = InsightsEvidenceSourceSettingsSchema.parse(preferences.insightsEvidenceSources ?? {});
  const sources: InsightEvidenceSource[] = [];
  if (settings.createEdit) sources.push("create_edit");
  if (settings.stuckTurns) sources.push("stuck_turn");
  if (settings.toolFailures) sources.push("tool_failure");
  if (settings.abandonedGoals) sources.push("abandoned_goal");
  if (settings.userCorrections) sources.push("user_correction");
  if (settings.unresolvedConversations) sources.push("unresolved_conversation");
  if (settings.usageAnomalies) sources.push("usage_anomaly");
  return new Set(sources);
}

function isInsightEvidenceSource(value: unknown): value is InsightEvidenceSource {
  return (
    value === "create_edit" ||
    value === "stuck_turn" ||
    value === "tool_failure" ||
    value === "abandoned_goal" ||
    value === "user_correction" ||
    value === "unresolved_conversation" ||
    value === "usage_anomaly"
  );
}

function linkInsightItemToRun(input: InsightItem, run: {
  runId: string;
  runSessionId: string;
  runTurnId: string;
  sourceEventSequence: number;
}): InsightItem {
  return {
    ...input,
    lastRunId: run.runId,
    lastRunSessionId: run.runSessionId,
    lastRunTurnId: run.runTurnId,
    payload: {
      ...input.payload,
      insightsRunId: run.runId,
      insightsRunSessionId: run.runSessionId,
      insightsRunTurnId: run.runTurnId,
      insightsRunSourceEventSequence: run.sourceEventSequence,
    },
  };
}

function insightsListResponse(
  items: InsightItem[],
  options: { runs?: InsightRun[]; systemSessionId?: string | null; systemSession?: Session | null } = {},
): InsightsListResponse {
  return InsightsListResponseSchema.parse({
    items,
    runs: options.runs ?? [],
    systemSessionId: options.systemSessionId ?? null,
    systemSession: "systemSession" in options ? options.systemSession : null,
    summary: summarizeInsights(items),
    generatedAt: now(),
    nextScanAt: null,
    scanRunning: false,
    scanStartedAt: null,
  });
}

function filterInsightItems(items: InsightItem[], query: InsightsListQuery): InsightItem[] {
  const evidenceSource = query.evidenceSource && query.evidenceSource !== "all" ? query.evidenceSource : null;
  if (!evidenceSource) return items;
  return items.filter((item) => insightEvidenceSource(item) === evidenceSource);
}

function filterInsightRuns(runs: InsightRun[], query: InsightsListQuery): InsightRun[] {
  return runs.filter((run) => {
    if (query.runStatus && query.runStatus !== "all" && run.status !== query.runStatus) return false;
    if (query.runTrigger && query.runTrigger !== "all" && run.trigger !== query.runTrigger) return false;
    if (query.runModel?.trim()) {
      const needle = query.runModel.trim().toLowerCase();
      const model = run.modelRef ? `${run.modelRef.providerId}/${run.modelRef.modelId}`.toLowerCase() : "";
      if (!model.includes(needle)) return false;
    }
    if (query.evidenceSource && query.evidenceSource !== "all") {
      if (!run.evidenceSources.includes(query.evidenceSource)) return false;
    }
    return true;
  });
}

function insightsStructuredOutputSchemaDescription(): Record<string, unknown> {
  return {
    type: "object",
    required: ["summary", "actions"],
    properties: {
      summary: { type: "string", minLength: 1 },
      actions: {
        type: "array",
        items: {
          oneOf: [
            { type: "object", required: ["action", "item"], properties: { action: { const: "upsert" }, item: "InsightItem" } },
            { type: "object", required: ["action", "insightId", "fingerprint", "reason"], properties: { action: { const: "resolve" } } },
            { type: "object", required: ["action", "insightId", "reason"], properties: { action: { const: "dismiss" } } },
            { type: "object", required: ["action", "createImproveRunId", "reason"], properties: { action: { const: "no_op" } } },
          ],
        },
      },
    },
  };
}

function insightRunSummary(stats: {
  findingCount: number;
  createdCount: number;
  updatedCount: number;
  resolvedCount: number;
}): string {
  if (stats.findingCount === 0 && stats.resolvedCount === 0) return "No active Create/Improve insights found.";
  const parts = [
    `${stats.findingCount} finding${stats.findingCount === 1 ? "" : "s"}`,
    `${stats.createdCount} new`,
    `${stats.updatedCount} updated`,
    `${stats.resolvedCount} resolved`,
  ];
  return `Insights scan completed: ${parts.join(", ")}.`;
}

function structuredRunOutputSummary(stats: {
  upsertCount: number;
  resolveCount: number;
  noOpCount: number;
}): string {
  if (stats.upsertCount === 0 && stats.resolveCount === 0) {
    return stats.noOpCount > 0
      ? "Structured Insights output found no active findings to write."
      : "Structured Insights output had no actions.";
  }
  return `Structured Insights output: ${stats.upsertCount} upsert, ${stats.resolveCount} resolve, ${stats.noOpCount} no-op.`;
}

function insightEvidenceHash(
  entries: RuntimeEventEntry[],
  candidates: InsightEvidenceCandidate[],
): string {
  return hashId(JSON.stringify({
    source: "runtime evidence",
    entries: entries.map((entry) => ({
      sequence: entry.sequence,
      eventId: entry.event.id,
      sessionId: entry.event.sessionId ?? null,
      turnId: entry.event.turnId ?? null,
    })),
    candidates: candidates.map((candidate) => ({
      evidenceSource: candidate.evidenceSource,
      evidenceKey: candidate.evidenceKey,
      keepFingerprint: candidate.keepFingerprint,
      item: candidate.item
        ? {
            fingerprint: candidate.item.fingerprint,
            severity: candidate.item.severity,
            type: candidate.item.type,
            title: candidate.item.title,
            summary: candidate.item.summary,
            payload: candidate.item.payload,
          }
        : null,
    })),
  }));
}

function insightsRunPrompt(input: {
  trigger: InsightRunTrigger;
  afterSequence: number;
  latestSequence: number;
  entries: RuntimeEventEntry[];
  candidates: InsightEvidenceCandidate[];
  evidenceSources: InsightEvidenceSource[];
}): string {
  const evidence = insightsEvidenceItems(input.candidates);
  const body = JSON.stringify({
    trigger: input.trigger,
    source: "OpenPond runtime events and turn state",
    evidenceSources: input.evidenceSources,
    afterSequence: input.afterSequence,
    latestSequence: input.latestSequence,
    eventCount: input.entries.length,
    evidence,
  }, null, 2);
  const compactBody = body.length > INSIGHTS_RUN_PROMPT_MAX_JSON_CHARS
    ? `${body.slice(0, INSIGHTS_RUN_PROMPT_MAX_JSON_CHARS)}\n...truncated`
    : body;
  return [
    "You are the built-in OpenPond Insights agent.",
    "Goal: review the compact Create/Improve evidence and summarize actionable blockers or concerns for the user.",
    "Do not modify files or run tools. Keep the answer concise and reference the source sessions or turns when present.",
    "The app will persist structured insight rows separately from this transcript.",
    "",
    "Evidence JSON:",
    compactBody,
  ].join("\n");
}

function insightsRunSessionTitle(trigger: InsightRunTrigger, timestamp: string): string {
  return `Insights ${triggerLabel(trigger)} scan ${shortTime(timestamp)}`;
}

function insightsQuestionSessionTitle(timestamp: string): string {
  return `Insights question ${shortTime(timestamp)}`;
}

function triggerLabel(trigger: InsightRunTrigger): string {
  switch (trigger) {
    case "slash_command":
      return "slash";
    default:
      return trigger;
  }
}

function shortTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function insightsRunEvidencePreview(input: {
  trigger: InsightRunTrigger;
  afterSequence: number;
  latestSequence: number;
  entries: RuntimeEventEntry[];
  candidates: InsightEvidenceCandidate[];
  evidenceSources: InsightEvidenceSource[];
}): Record<string, unknown> {
  const evidence = insightsEvidenceItems(input.candidates);
  const fullBodyLength = JSON.stringify({
    trigger: input.trigger,
    source: "OpenPond runtime events and turn state",
    evidenceSources: input.evidenceSources,
    afterSequence: input.afterSequence,
    latestSequence: input.latestSequence,
    eventCount: input.entries.length,
    evidence,
  }).length;
  return {
    trigger: input.trigger,
    afterSequence: input.afterSequence,
    latestSequence: input.latestSequence,
    eventCount: input.entries.length,
    evidenceSources: input.evidenceSources,
    totalCount: evidence.length,
    truncated: fullBodyLength > INSIGHTS_RUN_PROMPT_MAX_JSON_CHARS,
    items: evidence,
  };
}

function insightsEvidenceItems(candidates: InsightEvidenceCandidate[]): Array<Record<string, unknown>> {
  return candidates.map((candidate) => ({
    evidenceSource: candidate.evidenceSource,
    evidenceKey: candidate.evidenceKey,
    fingerprint: candidate.keepFingerprint,
    insight: candidate.item
      ? {
          severity: candidate.item.severity,
          type: candidate.item.type,
          title: candidate.item.title,
          summary: candidate.item.summary,
          sourceSessionId: candidate.item.payload.sessionId ?? null,
          sourceTurnId: candidate.item.payload.turnId ?? null,
          createImproveRunState: candidate.item.payload.createImproveRunState ?? null,
          sourceEventSequence: candidate.item.payload.sourceEventSequence ?? null,
        }
      : null,
  }));
}

function insightsQuestionPrompt(input: {
  question: string;
  items: InsightItem[];
  runs: InsightRun[];
}): string {
  const activeItems = input.items.filter((item) => item.status === "active");
  const evidence = {
    question: input.question,
    runs: input.runs.map((run) => ({
      id: run.id,
      turnId: run.turnId,
      trigger: run.trigger,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      modelRef: run.modelRef ?? null,
      findingCount: run.findingCount,
      createdCount: run.createdCount,
      updatedCount: run.updatedCount,
      resolvedCount: run.resolvedCount,
      summary: run.summary,
      error: run.error,
      evidenceHash: run.evidenceHash,
      sourceEventSequence: run.sourceEventSequence,
    })),
    insights: input.items.map((item) => ({
      id: item.id,
      status: item.status,
      severity: item.severity,
      type: item.type,
      title: item.title,
      summary: item.summary,
      updatedAt: item.updatedAt,
      sourceSessionId: item.payload.sessionId ?? null,
      sourceTurnId: item.payload.turnId ?? null,
      createImproveRunId: item.payload.createImproveRunId ?? null,
      createImproveRunState: item.payload.createImproveRunState ?? null,
      createImproveRunOperation: item.payload.createImproveRunOperation ?? null,
      sourceEventSequence: item.payload.sourceEventSequence ?? null,
      lastRunSessionId: item.lastRunSessionId ?? null,
      lastRunTurnId: item.lastRunTurnId ?? null,
    })),
  };
  const body = JSON.stringify(evidence, null, 2);
  const compactBody = body.length > 18_000 ? `${body.slice(0, 18_000)}\n...truncated` : body;
  return [
    "You are the built-in OpenPond Insights agent.",
    "Answer the user's question using only the compact Insights run history and linked source evidence below.",
    "If the evidence is insufficient, say what is missing and where the user should inspect next.",
    `Active insight count: ${activeItems.length}.`,
    "",
    "User question:",
    input.question,
    "",
    "Insights evidence JSON:",
    compactBody,
  ].join("\n");
}

function insightsThreadGoal(metadata: InsightsRunMetadata): Record<string, unknown> {
  return {
    id: metadata.id,
    provider: INSIGHTS_SYSTEM_KIND,
    objective: "Review recent OpenPond Create/Improve activity and summarize actionable insights.",
    status: metadata.status === "failed"
      ? "blocked"
      : metadata.status === "completed" || metadata.status === "skipped"
        ? "complete"
        : "active",
    trigger: metadata.trigger,
    evidenceSources: metadata.evidenceSources,
    evidenceHash: metadata.evidenceHash,
    sourceEventSequence: metadata.sourceEventSequence,
    startedAt: metadata.startedAt,
    completedAt: metadata.completedAt,
    elapsedMs: metadata.elapsedMs,
    usage: metadata.usage,
    findingCount: metadata.findingCount,
    error: metadata.error,
  };
}

function completeInsightsRunMetadata(
  metadata: InsightsRunMetadata,
  patch: Partial<InsightsRunMetadata> & {
    status: InsightsRunMetadata["status"];
    completedAt: string;
  },
): InsightsRunMetadata {
  const completedAt = patch.completedAt;
  return {
    ...metadata,
    ...patch,
    completedAt,
    elapsedMs: elapsedMsBetween(metadata.startedAt, completedAt),
    usage: patch.usage === undefined ? metadata.usage : patch.usage,
  };
}

function elapsedMsBetween(startedAt: string, completedAt: string): number | null {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
  return completed - started;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function summarizeInsights(items: InsightItem[]): InsightSummary {
  let activeCount = 0;
  let resolvedCount = 0;
  let dismissedCount = 0;
  let highestActiveSeverity: InsightSeverity | null = null;
  for (const item of items) {
    if (item.status === "active") {
      activeCount += 1;
      highestActiveSeverity = higherSeverity(highestActiveSeverity, item.severity);
    } else if (item.status === "resolved") {
      resolvedCount += 1;
    } else if (item.status === "dismissed") {
      dismissedCount += 1;
    }
  }
  return {
    totalCount: items.length,
    activeCount,
    resolvedCount,
    dismissedCount,
    highestActiveSeverity,
  };
}

function higherSeverity(current: InsightSeverity | null, next: InsightSeverity): InsightSeverity {
  if (!current) return next;
  return severityRank(next) > severityRank(current) ? next : current;
}

function severityRank(severity: InsightSeverity): number {
  if (severity === "blocker") return 3;
  if (severity === "concern") return 2;
  return 1;
}

function hashId(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}
