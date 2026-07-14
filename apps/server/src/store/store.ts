import { promises as fs } from "node:fs";
import path from "node:path";
import sqlite3 from "sqlite3";
import type {
  Approval,
  ContextUsageSnapshot,
  InsightItem,
  InsightStatus,
  RuntimeEvent,
  Session,
  SidebarAppPreference,
  SidebarAppPreferences,
  SubagentMessage,
  SubagentRun,
  Turn,
  LocalAgentSchedule,
  LocalAgentScheduleRun,
  LocalAgentScheduleRunStatus,
  ModelUsageRecord,
  ModelUsageStatus,
  ModelUsageVisibility,
  TrainingSourceRef,
  TrainingChatSearchResult,
  TaskCreationSnapshot,
  Taskset,
  TaskCandidate,
  TaskCandidateStatus,
  TaskAttemptResult,
  TaskAttemptArtifact,
  GradeResult,
  BaselineReport,
  GraderAuditReport,
  TasksetReadinessReport,
  TaskMinerConfig,
  TaskMinerRun,
  TrainingPlan,
  TrainingApproval,
  TrainingBundleManifest,
  TrainingJob,
  TrainingJobEvent,
  TrainingArtifact,
  ModelArtifactLineage,
} from "@openpond/contracts";
import {
  ContextUsageSnapshotSchema,
  ModelUsageRecordSchema,
  SubagentMessageSchema,
  SubagentRunSchema,
  TrainingSourceRefSchema,
  TaskCreationSnapshotSchema,
  TaskCreationTranscriptSchema,
  TaskDesignProposalSchema,
  TasksetSchema,
  TaskCandidateSchema,
  TaskAttemptResultSchema,
  TaskAttemptArtifactSchema,
  GradeResultSchema,
  BaselineReportSchema,
  GraderAuditReportSchema,
  TasksetReadinessReportSchema,
  TaskMinerConfigSchema,
  TaskMinerRunSchema,
  TrainingPlanSchema,
  TrainingApprovalSchema,
  TrainingBundleManifestSchema,
  TrainingJobSchema,
  TrainingJobEventSchema,
  TrainingArtifactSchema,
  ModelArtifactLineageSchema,
} from "@openpond/contracts";
import type {
  CacheEntry,
  CacheEntryRow,
  CacheRow,
  PayloadRow,
  SidebarAppPreferenceRow,
  StoreData,
} from "../types.js";
import type { Logger } from "../logger.js";
import { normalizeSidebarAppPreference } from "../preferences.js";
import { sanitizeRuntimeEvent } from "../runtime/runtime-event-sanitizer.js";
import { now } from "../utils.js";
import { CURRENT_SQLITE_SCHEMA_VERSION, SQLITE_CREATE_SCHEMA_SQL } from "./store-schema.js";
import { normalizeSessionPayload, persistStoreData, readStoreData } from "./store-persistence.js";
import {
  openPondThreadGoalMutationFromEvent,
  isTerminalOpenPondGoalStatus,
  recordValue,
  stringValue,
  localAgentScheduleFromRow,
  subagentRunFromRow,
  subagentRunParams,
  subagentMessageFromRow,
  subagentMessageParams,
  localAgentScheduleParams,
  localAgentScheduleRunFromRow,
  localAgentScheduleRunParams,
  insightItemFromRow,
  insightItemParams,
  modelUsageRecordFromRow,
  modelUsageRecordParams,
  timestampForPath,
  runtimeEventWithSequence,
  recordFromUnknown,
  threadDetailProjectionFromRow,
  threadDetailProjectionPayload,
  type ThreadDetailProjection,
} from "./store-codecs.js";
import { SqliteStoreCore } from "./store-core.js";

export { CURRENT_SQLITE_SCHEMA_VERSION } from "./store-schema.js";
export type { ThreadDetailProjection } from "./store-codecs.js";

type UserVersionRow = {
  user_version: number;
};

type QuickCheckRow = {
  quick_check: string;
};

type TableInfoRow = {
  name: string;
};

type EventPagePayloadRow = PayloadRow & {
  sequence: number;
};

export type TrainingChatSearchDocument = {
  sessionId: string;
  source: "openpond" | "codex";
  signature: string;
  title: string;
  body: string;
  updatedAt: string;
  eligible: boolean;
  bodyIndexed: boolean;
};

type TrainingChatSearchDocumentRow = {
  session_id: string;
  signature: string;
};

type TrainingChatSearchResultRow = {
  session_id: string;
  title: string;
  updated_at: string;
  snippet: string | null;
};

type TrainingChatSearchEvidenceRow = {
  session_id: string;
  payload: string;
};

type OpenPondThreadGoalRow = {
  session_id: string;
  goal_id: string;
  status: string;
  provisional: number;
  updated_at: string;
};

type OpenPondThreadGoalMutation =
  | { kind: "clear"; sessionId: string }
  | { kind: "upsert"; sessionId: string; goalId: string; status: string; updatedAt: string };

type InsightItemRow = {
  id: string;
  scope_type: string;
  scope_id: string;
  severity: string;
  type: string;
  status: string;
  fingerprint: string;
  title: string;
  summary: string;
  payload: string;
  last_run_id: string | null;
  last_run_session_id: string | null;
  last_run_turn_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  dismissed_at: string | null;
};

type ModelUsageRecordRow = {
  id: string;
  request_id: string;
  request_ordinal: number;
  session_id: string | null;
  turn_id: string | null;
  provider: string;
  model: string;
  route: string;
  source: string;
  request_kind: string;
  visibility: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  first_token_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  error_type: string | null;
  error_message: string | null;
  attribution_json: string;
};

type LocalAgentScheduleRow = PayloadRow & {
  id: string;
  local_project_id: string;
  schedule_name: string;
  enabled: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

type LocalAgentScheduleRunRow = PayloadRow & {
  id: string;
  schedule_id: string;
  local_project_id: string;
  schedule_name: string;
  scheduled_for: string;
  trigger: LocalAgentScheduleRun["trigger"];
  status: LocalAgentScheduleRunStatus;
  created_at: string;
  updated_at: string;
};

type SubagentRunRow = PayloadRow & {
  id: string;
  parent_session_id: string;
  parent_turn_id: string | null;
  parent_goal_id: string | null;
  child_session_id: string | null;
  role_id: string;
  status: SubagentRun["status"];
  created_at: string;
  updated_at: string;
};

type SubagentRunScopeRow = {
  parent_session_id: string;
  parent_goal_id: string | null;
};

type SubagentMessageRow = PayloadRow & {
  id: string;
  parent_goal_id: string | null;
  from_run_id: string;
  to_run_id: string | null;
  to_role: string | null;
  kind: SubagentMessage["kind"];
  created_at: string;
};

const NON_TERMINAL_SUBAGENT_STATUSES: readonly SubagentRun["status"][] = [
  "queued",
  "running",
  "blocked",
  "submitted_for_review",
  "needs_revision",
  "needs_user_input",
  "failed_with_artifacts",
  "needs_resume",
];

type ThreadDetailProjectionRow = PayloadRow & {
  session_id: string;
  event_count: number;
  latest_event_sequence: number;
  latest_event_at: string | null;
  latest_turn_id: string | null;
  latest_turn_status: Turn["status"] | null;
  pending_approval_count: number;
  updated_at: string;
};

type RuntimeEventPageQuery = {
  sessionId: string | null;
  afterSequence: number;
  beforeSequence: number | null;
  limit: number;
};

type RuntimeEventPageRows = {
  entries: Array<{ sequence: number; event: RuntimeEvent }>;
  totalMatchingEvents: number;
  remainingMatchingEvents: number;
};

type RuntimeEventRecentWindow = {
  entries: Array<{ sequence: number; event: RuntimeEvent }>;
  latestSequence: number;
  oldestSequence: number;
  totalEvents: number;
  hasMoreBefore: boolean;
  limit: number;
};

export class SqliteStore extends SqliteStoreCore {

  async snapshot(): Promise<StoreData> {
    await this.ready;
    await this.writeQueue;
    return structuredClone(this.data);
  }

  async sessionShells(): Promise<Session[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>(
      "SELECT payload FROM projection_session_shells ORDER BY sort_index ASC",
    );
    return rows.map((row) => normalizeSessionPayload(JSON.parse(row.payload)));
  }

  async getSession(sessionId: string): Promise<Session | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>("SELECT payload FROM projection_session_shells WHERE id = ?", [sessionId]);
    return row ? normalizeSessionPayload(JSON.parse(row.payload)) : null;
  }

  async pendingApprovals(): Promise<Approval[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>(
      "SELECT payload FROM projection_approvals WHERE status = ? ORDER BY sort_index ASC",
      ["pending"],
    );
    return rows.map((row) => JSON.parse(row.payload) as Approval);
  }

  async turnByProviderTurnId(providerTurnId: string): Promise<Turn | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>(
      "SELECT payload FROM turns WHERE provider_turn_id = ? ORDER BY sort_index DESC LIMIT 1",
      [providerTurnId],
    );
    return row ? JSON.parse(row.payload) as Turn : null;
  }

  async latestTurnForSession(sessionId: string, status?: Turn["status"]): Promise<Turn | null> {
    await this.ready;
    await this.writeQueue;
    if (!status) {
      const row = await this.get<PayloadRow>(
        "SELECT payload FROM projection_latest_turns WHERE session_id = ?",
        [sessionId],
      );
      return row ? JSON.parse(row.payload) as Turn : null;
    }
    const row = status
      ? await this.get<PayloadRow>(
          "SELECT payload FROM turns WHERE session_id = ? AND status = ? ORDER BY sort_index DESC LIMIT 1",
          [sessionId, status],
        )
      : null;
    return row ? JSON.parse(row.payload) as Turn : null;
  }

  async turnsForSession(sessionId: string, limit = 50): Promise<Turn[]> {
    await this.ready;
    await this.writeQueue;
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = await this.all<PayloadRow>(
      `SELECT payload FROM turns
       WHERE session_id = ?
       ORDER BY sort_index DESC
       LIMIT ?`,
      [sessionId, boundedLimit],
    );
    return rows.map((row) => JSON.parse(row.payload) as Turn);
  }

  async countTurnsForSession(sessionId: string): Promise<number> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM turns WHERE session_id = ?",
      [sessionId],
    );
    return row?.count ?? 0;
  }

  async trainingChatSearchSignatures(source: TrainingChatSearchDocument["source"]): Promise<Map<string, string>> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<TrainingChatSearchDocumentRow>(
      "SELECT session_id, signature FROM training_chat_search_documents WHERE source = ?",
      [source],
    );
    return new Map(rows.map((row) => [row.session_id, row.signature]));
  }

  async openPondTrainingChatSearchEvidence(candidateIdsInput: string[]): Promise<Array<{ session: Session; body: string }>> {
    await this.ready;
    await this.writeQueue;
    const candidateIds = [...new Set(candidateIdsInput)].slice(0, 500);
    if (!candidateIds.length) return [];
    const placeholders = candidateIds.map(() => "?").join(", ");
    const [sessionRows, turnRows, eventRows] = await Promise.all([
      this.all<PayloadRow>(
        `SELECT payload FROM projection_session_shells WHERE id IN (${placeholders})`,
        candidateIds,
      ),
      this.all<TrainingChatSearchEvidenceRow>(
        `SELECT session_id, payload FROM turns WHERE session_id IN (${placeholders}) ORDER BY sort_index ASC`,
        candidateIds,
      ),
      this.all<TrainingChatSearchEvidenceRow>(
        `SELECT session_id, payload FROM events
         WHERE name = 'assistant.delta' AND session_id IN (${placeholders})
         ORDER BY sequence ASC`,
        candidateIds,
      ),
    ]);
    const textBySession = new Map<string, string[]>();
    for (const row of turnRows) {
      const turn = JSON.parse(row.payload) as Turn;
      if (turn.prompt.trim()) appendTrainingChatSearchText(textBySession, row.session_id, turn.prompt);
    }
    for (const row of eventRows) {
      const event = JSON.parse(row.payload) as RuntimeEvent;
      if (event.output?.trim()) appendTrainingChatSearchText(textBySession, row.session_id, event.output);
    }
    return sessionRows.map((row) => {
      const session = normalizeSessionPayload(JSON.parse(row.payload));
      return { session, body: textBySession.get(session.id)?.join("\n") ?? "" };
    });
  }

  async syncTrainingChatSearchDocuments(
    source: TrainingChatSearchDocument["source"],
    documents: TrainingChatSearchDocument[],
  ): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const existingRows = await this.all<TrainingChatSearchDocumentRow>(
        "SELECT session_id, signature FROM training_chat_search_documents WHERE source = ?",
        [source],
      );
      const existing = new Map(existingRows.map((row) => [row.session_id, row.signature]));
      const incomingIds = new Set(documents.map((document) => document.sessionId));
      await this.exec("BEGIN IMMEDIATE");
      try {
        for (const sessionId of existing.keys()) {
          if (incomingIds.has(sessionId)) continue;
          await this.run("DELETE FROM training_chat_search_fts WHERE session_id = ?", [sessionId]);
          await this.run("DELETE FROM training_chat_search_documents WHERE session_id = ?", [sessionId]);
        }
        for (const document of documents) {
          if (existing.get(document.sessionId) === document.signature) continue;
          await this.run("DELETE FROM training_chat_search_fts WHERE session_id = ?", [document.sessionId]);
          await this.run(
            `INSERT INTO training_chat_search_documents (session_id, source, signature, title, updated_at, eligible, body_indexed)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               source = excluded.source,
               signature = excluded.signature,
               title = excluded.title,
               updated_at = excluded.updated_at,
               eligible = excluded.eligible,
               body_indexed = excluded.body_indexed`,
            [document.sessionId, document.source, document.signature, document.title, document.updatedAt, document.eligible ? 1 : 0, document.bodyIndexed ? 1 : 0],
          );
          await this.run(
            "INSERT INTO training_chat_search_fts (session_id, title, body) VALUES (?, ?, ?)",
            [document.sessionId, document.title, document.body],
          );
        }
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async upsertTrainingChatSearchDocument(document: TrainingChatSearchDocument): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        await this.run("DELETE FROM training_chat_search_fts WHERE session_id = ?", [document.sessionId]);
        await this.run(
          `INSERT INTO training_chat_search_documents (session_id, source, signature, title, updated_at, eligible, body_indexed)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             source = excluded.source,
             signature = excluded.signature,
             title = excluded.title,
             updated_at = excluded.updated_at,
             eligible = excluded.eligible,
             body_indexed = excluded.body_indexed`,
          [document.sessionId, document.source, document.signature, document.title, document.updatedAt, document.eligible ? 1 : 0, document.bodyIndexed ? 1 : 0],
        );
        await this.run(
          "INSERT INTO training_chat_search_fts (session_id, title, body) VALUES (?, ?, ?)",
          [document.sessionId, document.title, document.body],
        );
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async searchTrainingChats(input: { query: string; offset: number; limit: number; candidateIds: string[] }): Promise<TrainingChatSearchResult> {
    await this.ready;
    await this.writeQueue;
    const query = input.query.trim();
    const offset = Math.max(0, Math.trunc(input.offset));
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    const candidateIds = [...new Set(input.candidateIds)].slice(0, 500);
    if (!candidateIds.length) return trainingChatSearchResult(query, offset, limit, 0, [], 0, 0);
    const candidatePlaceholders = candidateIds.map(() => "?").join(", ");
    const progress = await this.get<{ indexed: number; total: number }>(
      `SELECT SUM(CASE WHEN body_indexed = 1 THEN 1 ELSE 0 END) AS indexed, COUNT(*) AS total
       FROM training_chat_search_documents
       WHERE eligible = 1 AND session_id IN (${candidatePlaceholders})`,
      candidateIds,
    );
    const indexedChats = progress?.indexed ?? 0;
    const totalChats = progress?.total ?? 0;
    if (!query) {
      const total = await this.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM training_chat_search_documents
         WHERE eligible = 1 AND session_id IN (${candidatePlaceholders})`,
        candidateIds,
      );
      const rows = await this.all<TrainingChatSearchResultRow>(
        `SELECT session_id, title, updated_at, NULL AS snippet
         FROM training_chat_search_documents
         WHERE eligible = 1 AND session_id IN (${candidatePlaceholders})
         ORDER BY updated_at DESC, session_id ASC
         LIMIT ? OFFSET ?`,
        [...candidateIds, limit, offset],
      );
      return trainingChatSearchResult(query, offset, limit, total?.count ?? 0, rows, indexedChats, totalChats);
    }
    const match = trainingChatFtsQuery(query);
    if (!match) return trainingChatSearchResult(query, offset, limit, 0, [], indexedChats, totalChats);
    const total = await this.get<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM training_chat_search_fts
       JOIN training_chat_search_documents AS documents
         ON documents.session_id = training_chat_search_fts.session_id
       WHERE training_chat_search_fts MATCH ? AND documents.eligible = 1
         AND documents.session_id IN (${candidatePlaceholders})`,
      [match, ...candidateIds],
    );
    const rows = await this.all<TrainingChatSearchResultRow>(
      `SELECT documents.session_id, documents.title, documents.updated_at,
              snippet(training_chat_search_fts, 2, '', '', ' … ', 22) AS snippet
       FROM training_chat_search_fts
       JOIN training_chat_search_documents AS documents
         ON documents.session_id = training_chat_search_fts.session_id
       WHERE training_chat_search_fts MATCH ? AND documents.eligible = 1
         AND documents.session_id IN (${candidatePlaceholders})
       ORDER BY bm25(training_chat_search_fts, 0.0, 8.0, 1.0), documents.updated_at DESC
       LIMIT ? OFFSET ?`,
      [match, ...candidateIds, limit, offset],
    );
    return trainingChatSearchResult(query, offset, limit, total?.count ?? 0, rows, indexedChats, totalChats);
  }

  async hasSubagentParentWakeTurn(sessionId: string, messageId: string): Promise<boolean> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM turns
       WHERE session_id = ?
         AND json_extract(payload, '$.metadata.subagentParentWake.messageId') = ?`,
      [sessionId, messageId],
    );
    return (row?.count ?? 0) > 0;
  }

  async countSubagentParentWakeTurns(sessionId: string, fromRunId: string): Promise<number> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM turns
       WHERE session_id = ?
         AND json_extract(payload, '$.metadata.subagentParentWake.fromRunId') = ?`,
      [sessionId, fromRunId],
    );
    return row?.count ?? 0;
  }

  async latestEventSequence(): Promise<number> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ sequence: number | null }>(
      "SELECT MAX(sequence) AS sequence FROM events",
      [],
    );
    return row?.sequence ?? 0;
  }

  async threadDetailProjection(sessionId: string): Promise<ThreadDetailProjection | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<ThreadDetailProjectionRow>(
      "SELECT * FROM projection_thread_details WHERE session_id = ?",
      [sessionId],
    );
    return row ? threadDetailProjectionFromRow(row) : null;
  }

  async runtimeEventPageRows(query: RuntimeEventPageQuery): Promise<RuntimeEventPageRows> {
    await this.ready;
    await this.writeQueue;
    const whereSession = query.sessionId ? "session_id = ?" : "1 = 1";
    const sessionParams = query.sessionId ? [query.sessionId] : [];
    const total = await this.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM events WHERE ${whereSession}`,
      sessionParams,
    );
    if (query.beforeSequence !== null) {
      const remainingParams = [...sessionParams, query.beforeSequence];
      const remaining = await this.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM events WHERE ${whereSession} AND sequence < ?`,
        remainingParams,
      );
      const rows = await this.all<EventPagePayloadRow>(
        `SELECT sequence, payload FROM events
         WHERE ${whereSession} AND sequence < ?
         ORDER BY sequence DESC
         LIMIT ?`,
        [...remainingParams, query.limit],
      );
      return {
        entries: rows
          .map((row) => ({
            sequence: row.sequence,
            event: runtimeEventWithSequence(row.payload, row.sequence),
          }))
          .reverse(),
        totalMatchingEvents: total?.count ?? 0,
        remainingMatchingEvents: remaining?.count ?? 0,
      };
    }

    const remainingParams = [...sessionParams, query.afterSequence];
    const remaining = await this.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM events WHERE ${whereSession} AND sequence > ?`,
      remainingParams,
    );
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE ${whereSession} AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
      [...remainingParams, query.limit],
    );
    return {
      entries: rows.map((row) => ({
        sequence: row.sequence,
        event: runtimeEventWithSequence(row.payload, row.sequence),
      })),
      totalMatchingEvents: total?.count ?? 0,
      remainingMatchingEvents: remaining?.count ?? 0,
    };
  }

  async runtimeEventsForSession(
    sessionId: string,
    query: {
      afterSequence?: number | null;
      names?: readonly RuntimeEvent["name"][];
      limit?: number | null;
    } = {},
  ): Promise<RuntimeEvent[]> {
    await this.ready;
    await this.writeQueue;
    const where = ["session_id = ?"];
    const params: unknown[] = [sessionId];
    if (query.afterSequence !== undefined && query.afterSequence !== null) {
      where.push("sequence > ?");
      params.push(Math.max(0, Math.trunc(query.afterSequence)));
    }
    if (query.names && query.names.length > 0) {
      where.push(`name IN (${query.names.map(() => "?").join(", ")})`);
      params.push(...query.names);
    }
    const limit = query.limit === undefined || query.limit === null
      ? null
      : Math.max(1, Math.min(100_000, Math.trunc(query.limit)));
    if (limit !== null) params.push(limit);
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE ${where.join(" AND ")}
       ORDER BY sequence ASC
       ${limit === null ? "" : "LIMIT ?"}`,
      params,
    );
    return rows.map((row) => runtimeEventWithSequence(row.payload, row.sequence));
  }

  async latestAssistantTextForSession(sessionId: string): Promise<string | null> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE session_id = ? AND name = ?
       ORDER BY sequence DESC
       LIMIT 25`,
      [sessionId, "assistant.delta"],
    );
    for (const row of rows) {
      const output = runtimeEventWithSequence(row.payload, row.sequence).output?.trim();
      if (output) return output;
    }
    return null;
  }

  async currentOpenPondThreadGoal(sessionId: string): Promise<Record<string, unknown> | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<OpenPondThreadGoalRow>(
      "SELECT * FROM openpond_thread_goals WHERE session_id = ?",
      [sessionId],
    );
    if (!row) return null;
    return this.openPondThreadGoalById(sessionId, row.goal_id);
  }

  async openPondThreadGoalById(
    sessionId: string,
    goalId: string,
  ): Promise<Record<string, unknown> | null> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE session_id = ? AND name = ?
       ORDER BY sequence DESC`,
      [sessionId, "diagnostic"],
    );
    for (const row of rows) {
      const runtimeEvent = runtimeEventWithSequence(row.payload, row.sequence);
      const data = recordFromUnknown(runtimeEvent.data);
      if (data?.kind !== "thread_goal") continue;
      const goal = recordFromUnknown(data.goal);
      if (goal?.id === goalId) return goal;
    }
    return null;
  }

  async recentRuntimeEventWindow(limit: number): Promise<RuntimeEventRecentWindow> {
    await this.ready;
    await this.writeQueue;
    const normalizedLimit = Math.max(0, Math.trunc(limit));
    const total = await this.get<{ count: number }>("SELECT COUNT(*) AS count FROM events", []);
    const latest = await this.latestEventSequence();
    if (normalizedLimit === 0) {
      return {
        entries: [],
        latestSequence: latest,
        oldestSequence: latest,
        totalEvents: total?.count ?? 0,
        hasMoreBefore: (total?.count ?? 0) > 0,
        limit: normalizedLimit,
      };
    }
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       ORDER BY sequence DESC
       LIMIT ?`,
      [normalizedLimit],
    );
    const entries = rows
      .map((row) => ({
        sequence: row.sequence,
        event: runtimeEventWithSequence(row.payload, row.sequence),
      }))
      .reverse();
    const oldestSequence = entries[0]?.sequence ?? latest;
    return {
      entries,
      latestSequence: latest,
      oldestSequence,
      totalEvents: total?.count ?? 0,
      hasMoreBefore: oldestSequence > 1,
      limit: normalizedLimit,
    };
  }

  async recentDiagnostics(limit: number): Promise<RuntimeEvent[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE name = ?
       ORDER BY sequence DESC
       LIMIT ?`,
      ["diagnostic", Math.max(0, Math.trunc(limit))],
    );
    return rows
      .map((row) => runtimeEventWithSequence(row.payload, row.sequence))
      .reverse();
  }

  async latestRuntimeEventSequenceByName(name: RuntimeEvent["name"]): Promise<number> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ sequence: number | null }>(
      "SELECT MAX(sequence) AS sequence FROM events WHERE name = ?",
      [name],
    );
    return row?.sequence ?? 0;
  }

  async runtimeEventRowsByNameAfter(
    name: RuntimeEvent["name"],
    afterSequence: number,
  ): Promise<Array<{ sequence: number; event: RuntimeEvent }>> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE name = ? AND sequence > ?
       ORDER BY sequence ASC`,
      [name, Math.max(0, Math.trunc(afterSequence))],
    );
    return rows.map((row) => ({
      sequence: row.sequence,
      event: runtimeEventWithSequence(row.payload, row.sequence),
    }));
  }

  async upsertModelUsageRecord(record: ModelUsageRecord): Promise<ModelUsageRecord> {
    await this.ready;
    const parsed = ModelUsageRecordSchema.parse(record);
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO model_usage_records (
           id,
           request_id,
           request_ordinal,
           session_id,
           turn_id,
           provider,
           model,
           route,
           source,
           request_kind,
           visibility,
           status,
           started_at,
           completed_at,
           duration_ms,
           first_token_ms,
           prompt_tokens,
           completion_tokens,
           total_tokens,
           error_type,
           error_message,
           attribution_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id)
         DO UPDATE SET
           id = excluded.id,
           request_ordinal = excluded.request_ordinal,
           session_id = excluded.session_id,
           turn_id = excluded.turn_id,
           provider = excluded.provider,
           model = excluded.model,
           route = excluded.route,
           source = excluded.source,
           request_kind = excluded.request_kind,
           visibility = excluded.visibility,
           status = excluded.status,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at,
           duration_ms = excluded.duration_ms,
           first_token_ms = excluded.first_token_ms,
           prompt_tokens = excluded.prompt_tokens,
           completion_tokens = excluded.completion_tokens,
           total_tokens = excluded.total_tokens,
           error_type = excluded.error_type,
           error_message = excluded.error_message,
           attribution_json = excluded.attribution_json`,
        modelUsageRecordParams(parsed),
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return (await this.getModelUsageRecordByRequestId(parsed.requestId)) ?? parsed;
  }

  async getModelUsageRecordByRequestId(requestId: string): Promise<ModelUsageRecord | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<ModelUsageRecordRow>(
      "SELECT * FROM model_usage_records WHERE request_id = ?",
      [requestId],
    );
    return row ? modelUsageRecordFromRow(row) : null;
  }

  async listModelUsageRecords(query: {
    sessionId?: string | null;
    turnId?: string | null;
    startedAtFrom?: string | null;
    startedAtTo?: string | null;
    visibility?: ModelUsageVisibility | "all" | null;
    status?: ModelUsageStatus | "missing" | "all" | null;
    limit?: number;
  } = {}): Promise<ModelUsageRecord[]> {
    await this.ready;
    await this.writeQueue;
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.sessionId) {
      where.push("session_id = ?");
      params.push(query.sessionId);
    }
    if (query.turnId) {
      where.push("turn_id = ?");
      params.push(query.turnId);
    }
    if (query.startedAtFrom) {
      where.push("started_at >= ?");
      params.push(query.startedAtFrom);
    }
    if (query.startedAtTo) {
      where.push("started_at <= ?");
      params.push(query.startedAtTo);
    }
    if (query.visibility && query.visibility !== "all") {
      where.push("visibility = ?");
      params.push(query.visibility);
    }
    if (query.status && query.status !== "all") {
      if (query.status === "missing") {
        where.push("source = ?");
        params.push("missing");
      } else {
        where.push("status = ?");
        params.push(query.status);
      }
    }
    const limitSql = query.limit === undefined
      ? ""
      : "LIMIT ?";
    if (query.limit !== undefined) {
      params.push(Math.max(1, Math.min(10_000, Math.trunc(query.limit))));
    }
    const rows = await this.all<ModelUsageRecordRow>(
      `SELECT * FROM model_usage_records
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY started_at DESC, request_ordinal DESC
       ${limitSql}`,
      params,
    );
    return rows.map(modelUsageRecordFromRow);
  }

  async latestContextUsageForTurn(sessionId: string, turnId: string): Promise<ContextUsageSnapshot | null> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<EventPagePayloadRow>(
      `SELECT sequence, payload FROM events
       WHERE session_id = ? AND turn_id = ? AND name = ?
       ORDER BY sequence DESC
       LIMIT 10`,
      [sessionId, turnId, "session.context.updated"],
    );
    for (const row of rows) {
      const runtimeEvent = runtimeEventWithSequence(row.payload, row.sequence);
      const parsed = ContextUsageSnapshotSchema.safeParse(runtimeEvent.data);
      if (parsed.success) return parsed.data;
    }
    return null;
  }

  async listInsights(query: {
    status?: InsightStatus | "all" | null;
    limit?: number;
  } = {}): Promise<InsightItem[]> {
    await this.ready;
    await this.writeQueue;
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 200)));
    const status = query.status && query.status !== "all" ? query.status : null;
    const rows = status
      ? await this.all<InsightItemRow>(
          `SELECT * FROM insight_items
           WHERE status = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
          [status, limit],
        )
      : await this.all<InsightItemRow>(
          `SELECT * FROM insight_items
           ORDER BY
             CASE status
               WHEN 'active' THEN 0
               WHEN 'resolved' THEN 1
               ELSE 2
             END,
             updated_at DESC
           LIMIT ?`,
          [limit],
        );
    return rows.map(insightItemFromRow);
  }

  async upsertInsightItem(item: InsightItem): Promise<InsightItem> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO insight_items (
           id,
           scope_type,
           scope_id,
           severity,
           type,
           status,
           fingerprint,
           title,
           summary,
           payload,
           last_run_id,
           last_run_session_id,
           last_run_turn_id,
           created_at,
           updated_at,
           resolved_at,
           dismissed_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id)
         DO UPDATE SET
           scope_type = excluded.scope_type,
           scope_id = excluded.scope_id,
           severity = excluded.severity,
           type = excluded.type,
           fingerprint = excluded.fingerprint,
           title = excluded.title,
           summary = excluded.summary,
           payload = excluded.payload,
           last_run_id = excluded.last_run_id,
           last_run_session_id = excluded.last_run_session_id,
           last_run_turn_id = excluded.last_run_turn_id,
           updated_at = excluded.updated_at,
           status = CASE
             WHEN insight_items.status = 'dismissed' THEN insight_items.status
             ELSE excluded.status
           END,
           resolved_at = CASE
             WHEN insight_items.status = 'dismissed' THEN insight_items.resolved_at
             ELSE excluded.resolved_at
           END,
           dismissed_at = CASE
             WHEN insight_items.status = 'dismissed' THEN insight_items.dismissed_at
             ELSE excluded.dismissed_at
           END`,
        insightItemParams(item),
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return (await this.getInsightItem(item.id)) ?? item;
  }

  async getInsightItem(id: string): Promise<InsightItem | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<InsightItemRow>("SELECT * FROM insight_items WHERE id = ?", [id]);
    return row ? insightItemFromRow(row) : null;
  }

  async patchInsightStatus(id: string, status: InsightStatus): Promise<InsightItem | null> {
    await this.ready;
    const updatedAt = now();
    const resolvedAt = status === "resolved" ? updatedAt : null;
    const dismissedAt = status === "dismissed" ? updatedAt : null;
    const write = this.writeQueue.then(async () => {
      await this.run(
        `UPDATE insight_items
         SET status = ?,
             updated_at = ?,
             resolved_at = ?,
             dismissed_at = ?
         WHERE id = ?`,
        [status, updatedAt, resolvedAt, dismissedAt, id],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return this.getInsightItem(id);
  }

  async listLocalAgentSchedules(query: {
    localProjectId?: string | null;
    enabled?: boolean | null;
  } = {}): Promise<LocalAgentSchedule[]> {
    await this.ready;
    await this.writeQueue;
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.localProjectId) {
      where.push("local_project_id = ?");
      params.push(query.localProjectId);
    }
    if (query.enabled !== undefined && query.enabled !== null) {
      where.push("enabled = ?");
      params.push(query.enabled ? 1 : 0);
    }
    const rows = await this.all<LocalAgentScheduleRow>(
      `SELECT * FROM local_agent_schedules
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY local_project_id ASC, schedule_name ASC`,
      params,
    );
    return rows.map(localAgentScheduleFromRow);
  }

  async listDueLocalAgentSchedules(nowIso: string, limit = 25): Promise<LocalAgentSchedule[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<LocalAgentScheduleRow>(
      `SELECT * FROM local_agent_schedules
       WHERE enabled = 1
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
       ORDER BY next_run_at ASC
       LIMIT ?`,
      [nowIso, Math.max(1, Math.min(100, Math.trunc(limit)))],
    );
    return rows.map(localAgentScheduleFromRow);
  }

  async getLocalAgentSchedule(id: string): Promise<LocalAgentSchedule | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<LocalAgentScheduleRow>(
      "SELECT * FROM local_agent_schedules WHERE id = ?",
      [id],
    );
    return row ? localAgentScheduleFromRow(row) : null;
  }

  async upsertLocalAgentSchedule(schedule: LocalAgentSchedule): Promise<LocalAgentSchedule> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO local_agent_schedules (
           id,
           local_project_id,
           schedule_name,
           enabled,
           next_run_at,
           payload,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id)
         DO UPDATE SET
           local_project_id = excluded.local_project_id,
           schedule_name = excluded.schedule_name,
           enabled = excluded.enabled,
           next_run_at = excluded.next_run_at,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        localAgentScheduleParams(schedule),
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return (await this.getLocalAgentSchedule(schedule.id)) ?? schedule;
  }

  async deleteLocalAgentSchedulesNotIn(
    localProjectId: string,
    scheduleIds: string[],
  ): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      if (scheduleIds.length === 0) {
        await this.run("DELETE FROM local_agent_schedules WHERE local_project_id = ?", [localProjectId]);
        return;
      }
      const placeholders = scheduleIds.map(() => "?").join(", ");
      await this.run(
        `DELETE FROM local_agent_schedules
         WHERE local_project_id = ?
           AND id NOT IN (${placeholders})`,
        [localProjectId, ...scheduleIds],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async patchLocalAgentSchedule(
    id: string,
    updater: (schedule: LocalAgentSchedule) => LocalAgentSchedule,
  ): Promise<LocalAgentSchedule | null> {
    await this.ready;
    let updated: LocalAgentSchedule | null = null;
    const write = this.writeQueue.then(async () => {
      const row = await this.get<LocalAgentScheduleRow>(
        "SELECT * FROM local_agent_schedules WHERE id = ?",
        [id],
      );
      if (!row) return;
      updated = updater(localAgentScheduleFromRow(row));
      await this.run(
        `UPDATE local_agent_schedules
         SET enabled = ?,
             next_run_at = ?,
             payload = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          updated.enabled ? 1 : 0,
          updated.nextRunAt,
          JSON.stringify(updated),
          updated.updatedAt,
          id,
        ],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async insertLocalAgentScheduleRun(
    run: LocalAgentScheduleRun,
  ): Promise<LocalAgentScheduleRun> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO local_agent_schedule_runs (
           id,
           schedule_id,
           local_project_id,
           schedule_name,
           scheduled_for,
           trigger,
           status,
           payload,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        localAgentScheduleRunParams(run),
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return (await this.getLocalAgentScheduleRun(run.id)) ?? run;
  }

  async getLocalAgentScheduleRun(id: string): Promise<LocalAgentScheduleRun | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<LocalAgentScheduleRunRow>(
      "SELECT * FROM local_agent_schedule_runs WHERE id = ?",
      [id],
    );
    return row ? localAgentScheduleRunFromRow(row) : null;
  }

  async listLocalAgentScheduleRuns(
    scheduleId: string,
    limit = 25,
  ): Promise<LocalAgentScheduleRun[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<LocalAgentScheduleRunRow>(
      `SELECT * FROM local_agent_schedule_runs
       WHERE schedule_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [scheduleId, Math.max(1, Math.min(100, Math.trunc(limit)))],
    );
    return rows.map(localAgentScheduleRunFromRow);
  }

  async patchLocalAgentScheduleRun(
    id: string,
    updater: (run: LocalAgentScheduleRun) => LocalAgentScheduleRun,
  ): Promise<LocalAgentScheduleRun | null> {
    await this.ready;
    let updated: LocalAgentScheduleRun | null = null;
    const write = this.writeQueue.then(async () => {
      const row = await this.get<LocalAgentScheduleRunRow>(
        "SELECT * FROM local_agent_schedule_runs WHERE id = ?",
        [id],
      );
      if (!row) return;
      updated = updater(localAgentScheduleRunFromRow(row));
      await this.run(
        `UPDATE local_agent_schedule_runs
         SET status = ?,
             payload = ?,
             updated_at = ?
         WHERE id = ?`,
        [updated.status, JSON.stringify(updated), updated.updatedAt, id],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async upsertSubagentRun(run: SubagentRun): Promise<SubagentRun> {
    await this.ready;
    const parsed = SubagentRunSchema.parse(run);
    const updatedAt = now();
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO subagent_runs (
           id,
           parent_session_id,
           parent_turn_id,
           parent_goal_id,
           child_session_id,
           role_id,
           status,
           payload,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id)
         DO UPDATE SET
           parent_session_id = excluded.parent_session_id,
           parent_turn_id = excluded.parent_turn_id,
           parent_goal_id = excluded.parent_goal_id,
           child_session_id = excluded.child_session_id,
           role_id = excluded.role_id,
           status = excluded.status,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        subagentRunParams(parsed, updatedAt),
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return (await this.getSubagentRun(parsed.id)) ?? parsed;
  }

  async recordRetainedWorkspaceExpiryWarning(
    runId: string,
    warning: Record<string, unknown>,
  ): Promise<SubagentRun | null> {
    await this.ready;
    let updated: SubagentRun | null = null;
    const write = this.writeQueue.then(async () => {
      const row = await this.get<SubagentRunRow>("SELECT * FROM subagent_runs WHERE id = ?", [runId]);
      if (!row) return;
      const current = subagentRunFromRow(row);
      updated = SubagentRunSchema.parse({
        ...current,
        metadata: {
          ...(current.metadata ?? {}),
          retainedWorkspaceExpiryWarning: warning,
        },
      });
      await this.run(
        `UPDATE subagent_runs
         SET payload = ?
         WHERE id = ?`,
        [JSON.stringify(updated), runId],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async getSubagentRun(id: string): Promise<SubagentRun | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<SubagentRunRow>("SELECT * FROM subagent_runs WHERE id = ?", [id]);
    return row ? subagentRunFromRow(row) : null;
  }

  async listSubagentRuns(query: {
    parentSessionId?: string | null;
    parentGoalId?: string | null;
    childSessionId?: string | null;
    status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
    limit?: number;
  } = {}): Promise<SubagentRun[]> {
    await this.ready;
    await this.writeQueue;
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.parentSessionId) {
      where.push("parent_session_id = ?");
      params.push(query.parentSessionId);
    }
    if (query.parentGoalId) {
      where.push("parent_goal_id = ?");
      params.push(query.parentGoalId);
    }
    if (query.childSessionId) {
      where.push("child_session_id = ?");
      params.push(query.childSessionId);
    }
    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      if (statuses.length === 1) {
        where.push("status = ?");
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        params.push(...statuses);
      }
    }
    const limitSql = query.limit === undefined ? "" : "LIMIT ?";
    if (query.limit !== undefined) params.push(Math.max(1, Math.min(1000, Math.trunc(query.limit))));
    const rows = await this.all<SubagentRunRow>(
      `SELECT * FROM subagent_runs
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY updated_at DESC, created_at DESC
       ${limitSql}`,
      params,
    );
    return rows.map(subagentRunFromRow);
  }

  async listActiveSubagentRuns(query: {
    parentSessionId?: string | null;
    parentGoalId?: string | null;
    childSessionId?: string | null;
    status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
    limit?: number;
  } = {}): Promise<SubagentRun[]> {
    return this.listSubagentRuns({
      ...query,
      status: query.status ?? NON_TERMINAL_SUBAGENT_STATUSES,
    });
  }

  async listSubagentRunScopes(query: {
    status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
    updatedAtFrom?: string | null;
    limit?: number;
  } = {}): Promise<Array<{ parentSessionId: string; parentGoalId: string | null }>> {
    await this.ready;
    await this.writeQueue;
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      if (statuses.length === 1) {
        where.push("status = ?");
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        params.push(...statuses);
      }
    }
    if (query.updatedAtFrom) {
      where.push("updated_at >= ?");
      params.push(query.updatedAtFrom);
    }
    const limitSql = query.limit === undefined ? "" : "LIMIT ?";
    if (query.limit !== undefined) params.push(Math.max(1, Math.min(1000, Math.trunc(query.limit))));
    const rows = await this.all<SubagentRunScopeRow>(
      `SELECT parent_session_id, parent_goal_id
       FROM subagent_runs
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       GROUP BY parent_session_id, parent_goal_id
       ORDER BY MAX(updated_at) DESC
       ${limitSql}`,
      params,
    );
    return rows.map((row) => ({
      parentSessionId: row.parent_session_id,
      parentGoalId: row.parent_goal_id,
    }));
  }

  async listStaleSubagentRuns(query: {
    olderThanMs: number;
    nowIso?: string | null;
    parentSessionId?: string | null;
    parentGoalId?: string | null;
    childSessionId?: string | null;
    status?: SubagentRun["status"] | readonly SubagentRun["status"][] | null;
    limit?: number;
  }): Promise<SubagentRun[]> {
    await this.ready;
    await this.writeQueue;
    const nowMs = Date.parse(query.nowIso ?? now());
    const cutoff = new Date(nowMs - Math.max(0, Math.trunc(query.olderThanMs))).toISOString();
    const where: string[] = ["updated_at <= ?"];
    const params: unknown[] = [cutoff];
    if (query.parentSessionId) {
      where.push("parent_session_id = ?");
      params.push(query.parentSessionId);
    }
    if (query.parentGoalId) {
      where.push("parent_goal_id = ?");
      params.push(query.parentGoalId);
    }
    if (query.childSessionId) {
      where.push("child_session_id = ?");
      params.push(query.childSessionId);
    }
    const statuses = query.status
      ? Array.isArray(query.status)
        ? query.status
        : [query.status]
      : NON_TERMINAL_SUBAGENT_STATUSES;
    if (statuses.length === 1) {
      where.push("status = ?");
      params.push(statuses[0]);
    } else if (statuses.length > 1) {
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    const limitSql = query.limit === undefined ? "" : "LIMIT ?";
    if (query.limit !== undefined) params.push(Math.max(1, Math.min(1000, Math.trunc(query.limit))));
    const rows = await this.all<SubagentRunRow>(
      `SELECT * FROM subagent_runs
       WHERE ${where.join(" AND ")}
       ORDER BY updated_at ASC, created_at ASC
       ${limitSql}`,
      params,
    );
    return rows.map(subagentRunFromRow);
  }

  async appendSubagentMessage(message: SubagentMessage): Promise<SubagentMessage> {
    await this.ready;
    const parsed = SubagentMessageSchema.parse(message);
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO subagent_messages (
           id,
           parent_goal_id,
           from_run_id,
           to_run_id,
           to_role,
           kind,
           payload,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        subagentMessageParams(parsed),
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return parsed;
  }

  async listSubagentMessages(query: {
    parentGoalId?: string | null;
    fromRunId?: string | null;
    toRunId?: string | null;
    toRole?: string | null;
    limit?: number;
  } = {}): Promise<SubagentMessage[]> {
    await this.ready;
    await this.writeQueue;
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.parentGoalId) {
      where.push("parent_goal_id = ?");
      params.push(query.parentGoalId);
    }
    if (query.fromRunId) {
      where.push("from_run_id = ?");
      params.push(query.fromRunId);
    }
    if (query.toRunId) {
      where.push("to_run_id = ?");
      params.push(query.toRunId);
    }
    if (query.toRole) {
      where.push("to_role = ?");
      params.push(query.toRole);
    }
    const limitSql = query.limit === undefined ? "" : "LIMIT ?";
    if (query.limit !== undefined) params.push(Math.max(1, Math.min(1000, Math.trunc(query.limit))));
    const rows = await this.all<SubagentMessageRow>(
      `SELECT * FROM subagent_messages
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at ASC
       ${limitSql}`,
      params,
    );
    return rows.map(subagentMessageFromRow);
  }

  async sessionCount(): Promise<number> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<{ count: number }>("SELECT COUNT(*) AS count FROM sessions", []);
    return row?.count ?? 0;
  }

  async insertSessionAtFront(session: Session): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        await this.run("UPDATE sessions SET sort_index = sort_index + 1", []);
        await this.run("UPDATE projection_session_shells SET sort_index = sort_index + 1", []);
        await this.run(
          "INSERT INTO sessions (id, sort_index, payload, updated_at) VALUES (?, ?, ?, ?)",
          [session.id, 0, JSON.stringify(session), session.updatedAt],
        );
        await this.upsertSessionShellProjection(session, 0);
        await this.rebuildThreadDetailProjectionForSession(session.id);
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
      this.data.sessions.unshift(session);
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async updateSession(sessionId: string, updater: (session: Session) => Session): Promise<Session | null> {
    await this.ready;
    let updated: Session | null = null;
    const write = this.writeQueue.then(async () => {
      const index = this.data.sessions.findIndex((session) => session.id === sessionId);
      if (index === -1) return;
      updated = updater(this.data.sessions[index]!);
      await this.run(
        "UPDATE sessions SET payload = ?, updated_at = ? WHERE id = ?",
        [JSON.stringify(updated), updated.updatedAt, sessionId],
      );
      await this.upsertSessionShellProjection(updated, index);
      await this.rebuildThreadDetailProjectionForSession(sessionId);
      this.data.sessions[index] = updated;
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async updateSessionsWhere(
    predicate: (session: Session) => boolean,
    updater: (session: Session) => Session,
  ): Promise<Session[]> {
    await this.ready;
    const updated: Session[] = [];
    const write = this.writeQueue.then(async () => {
      const updates = this.data.sessions
        .map((session, index) => ({ session, index }))
        .filter(({ session }) => predicate(session))
        .map(({ session, index }) => ({ index, session: updater(session) }));
      if (updates.length === 0) return;
      await this.exec("BEGIN IMMEDIATE");
      try {
        for (const update of updates) {
          await this.run(
            "UPDATE sessions SET payload = ?, updated_at = ? WHERE id = ?",
            [JSON.stringify(update.session), update.session.updatedAt, update.session.id],
          );
          await this.upsertSessionShellProjection(update.session, update.index);
          await this.rebuildThreadDetailProjectionForSession(update.session.id);
        }
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
      for (const update of updates) {
        this.data.sessions[update.index] = update.session;
        updated.push(update.session);
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async getTurn(turnId: string): Promise<Turn | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>("SELECT payload FROM turns WHERE id = ?", [turnId]);
    return row ? JSON.parse(row.payload) as Turn : null;
  }

  async insertTurn(turn: Turn): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const index = this.data.turns.length;
      await this.run(
        "INSERT INTO turns (id, session_id, provider_turn_id, status, sort_index, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          turn.id,
          turn.sessionId,
          turn.providerTurnId,
          turn.status,
          index,
          JSON.stringify(turn),
          turn.completedAt ?? turn.startedAt,
        ],
      );
      await this.rebuildLatestTurnProjectionForSession(turn.sessionId);
      await this.rebuildThreadDetailProjectionForSession(turn.sessionId);
      this.data.turns.push(turn);
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async updateTurn(turnId: string, updater: (turn: Turn) => Turn): Promise<Turn | null> {
    await this.ready;
    let updated: Turn | null = null;
    const write = this.writeQueue.then(async () => {
      const index = this.data.turns.findIndex((turn) => turn.id === turnId);
      if (index === -1) return;
      const previousSessionId = this.data.turns[index]!.sessionId;
      updated = updater(this.data.turns[index]!);
      await this.run(
        "UPDATE turns SET session_id = ?, provider_turn_id = ?, status = ?, payload = ?, updated_at = ? WHERE id = ?",
        [
          updated.sessionId,
          updated.providerTurnId,
          updated.status,
          JSON.stringify(updated),
          updated.completedAt ?? updated.startedAt,
          turnId,
        ],
      );
      await this.rebuildLatestTurnProjectionForSession(previousSessionId);
      if (updated.sessionId !== previousSessionId) await this.rebuildLatestTurnProjectionForSession(updated.sessionId);
      await this.rebuildThreadDetailProjectionForSession(previousSessionId);
      if (updated.sessionId !== previousSessionId) await this.rebuildThreadDetailProjectionForSession(updated.sessionId);
      this.data.turns[index] = updated;
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async getApproval(approvalId: string): Promise<Approval | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>("SELECT payload FROM approvals WHERE id = ?", [approvalId]);
    return row ? JSON.parse(row.payload) as Approval : null;
  }

  async upsertApproval(approval: Approval): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const index = this.data.approvals.findIndex((candidate) => candidate.id === approval.id);
      const previousSessionId = index === -1 ? null : this.data.approvals[index]!.sessionId;
      const sortIndex = index === -1 ? this.data.approvals.length : index;
      await this.run(
        `INSERT INTO approvals (id, session_id, status, sort_index, payload, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id)
         DO UPDATE SET
           session_id = excluded.session_id,
           status = excluded.status,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        [approval.id, approval.sessionId, approval.status, sortIndex, JSON.stringify(approval), now()],
      );
      await this.upsertApprovalProjection(approval, sortIndex);
      await this.rebuildThreadDetailProjectionForSession(approval.sessionId);
      if (previousSessionId && previousSessionId !== approval.sessionId) {
        await this.rebuildThreadDetailProjectionForSession(previousSessionId);
      }
      if (index === -1) this.data.approvals.push(approval);
      else this.data.approvals[index] = approval;
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async getCacheEntry<T>(type: string, key: string): Promise<CacheEntry<T> | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<CacheRow>(
      "SELECT payload, updated_at, error FROM cache_entries WHERE type = ? AND cache_key = ?",
      [type, key]
    );
    if (!row) return null;
    return {
      payload: JSON.parse(row.payload) as T,
      updatedAt: row.updated_at,
      error: row.error,
    };
  }

  async getCacheEntriesByType<T>(type: string): Promise<Record<string, CacheEntry<T>>> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<CacheEntryRow>(
      "SELECT cache_key, payload, updated_at, error FROM cache_entries WHERE type = ?",
      [type]
    );
    const entries: Record<string, CacheEntry<T>> = {};
    for (const row of rows) {
      entries[row.cache_key] = {
        payload: JSON.parse(row.payload) as T,
        updatedAt: row.updated_at,
        error: row.error,
      };
    }
    return entries;
  }

  async setCacheEntry<T>(type: string, key: string, payload: T, error: string | null = null): Promise<CacheEntry<T>> {
    await this.ready;
    const updatedAt = now();
    const entry: CacheEntry<T> = { payload, updatedAt, error };
    const write = this.writeQueue.then(async () => {
      await this.run(
        `INSERT INTO cache_entries (type, cache_key, payload, updated_at, error)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(type, cache_key)
         DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, error = excluded.error`,
        [type, key, JSON.stringify(payload), updatedAt, error]
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return entry;
  }

  async setCacheError(type: string, key: string, fallbackPayload: unknown, error: string): Promise<void> {
    const existing = await this.getCacheEntry<unknown>(type, key);
    await this.setCacheEntry(type, key, existing?.payload ?? fallbackPayload, error);
  }

  async getSidebarAppPreferences(scope: string): Promise<SidebarAppPreferences> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<SidebarAppPreferenceRow>(
      `SELECT app_id, pinned, archived, sort_order
       FROM sidebar_app_preferences
       WHERE scope = ?`,
      [scope]
    );
    const preferences: SidebarAppPreferences = {};
    for (const row of rows) {
      preferences[row.app_id] = {
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        ...(row.sort_order === null ? {} : { order: row.sort_order }),
      };
    }
    return preferences;
  }

  async patchSidebarAppPreference(
    scope: string,
    appId: string,
    patch: SidebarAppPreference
  ): Promise<SidebarAppPreference> {
    await this.ready;
    let updated: SidebarAppPreference = {};
    const write = this.writeQueue.then(async () => {
      const row = await this.get<SidebarAppPreferenceRow>(
        `SELECT app_id, pinned, archived, sort_order
         FROM sidebar_app_preferences
         WHERE scope = ? AND app_id = ?`,
        [scope, appId]
      );
      const existing: SidebarAppPreference = row
        ? {
            pinned: row.pinned === 1,
            archived: row.archived === 1,
            ...(row.sort_order === null ? {} : { order: row.sort_order }),
          }
        : {};
      updated = normalizeSidebarAppPreference({ ...existing, ...patch });
      await this.run(
        `INSERT INTO sidebar_app_preferences (scope, app_id, pinned, archived, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, app_id)
         DO UPDATE SET
           pinned = excluded.pinned,
           archived = excluded.archived,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
        [scope, appId, updated.pinned ? 1 : 0, updated.archived ? 1 : 0, updated.order ?? null, now()]
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return updated;
  }

  async reorderSidebarApps(scope: string, appIds: string[]): Promise<SidebarAppPreferences> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const updatedAt = now();
      await this.exec("BEGIN IMMEDIATE");
      try {
        for (const [index, appId] of appIds.entries()) {
          await this.run(
            `INSERT INTO sidebar_app_preferences (scope, app_id, pinned, archived, sort_order, updated_at)
             VALUES (?, ?, 0, 0, ?, ?)
             ON CONFLICT(scope, app_id)
             DO UPDATE SET sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
            [scope, appId, index, updatedAt]
          );
        }
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK");
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return this.getSidebarAppPreferences(scope);
  }

  async mutate(fn: (data: StoreData) => void): Promise<StoreData> {
    await this.ready;
    let snapshot: StoreData = { sessions: [], turns: [], events: [], approvals: [] };
    const write = this.writeQueue.then(async () => {
      fn(this.data);
      await this.persist();
      await this.createOpenPondThreadGoalTable();
      await this.rebuildReadModels();
      snapshot = structuredClone(this.data);
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return snapshot;
  }

  async claimOpenPondThreadGoal(input: {
    sessionId: string;
    goalId: string;
    status: string;
    updatedAt: string;
  }): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        await this.upsertOpenPondThreadGoal({
          kind: "upsert",
          sessionId: input.sessionId,
          goalId: input.goalId,
          status: input.status,
          updatedAt: input.updatedAt,
        }, true);
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async releaseOpenPondThreadGoalClaim(sessionId: string, goalId: string): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.run(
        "DELETE FROM openpond_thread_goals WHERE session_id = ? AND goal_id = ? AND provisional = 1",
        [sessionId, goalId],
      );
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async appendRuntimeEvent(runtimeEvent: StoreData["events"][number]): Promise<RuntimeEvent> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      const safeRuntimeEvent = sanitizeRuntimeEvent(runtimeEvent);
      const goalMutation = openPondThreadGoalMutationFromEvent(safeRuntimeEvent);
      let persistedRuntimeEvent: RuntimeEvent;
      if (goalMutation) await this.exec("BEGIN IMMEDIATE");
      try {
        if (goalMutation) await this.upsertOpenPondThreadGoal(goalMutation, false);
        persistedRuntimeEvent = await this.insertRuntimeEventRecord(safeRuntimeEvent);
        if (goalMutation) await this.exec("COMMIT");
      } catch (error) {
        if (goalMutation) await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
      this.data.events.push(persistedRuntimeEvent);
      return persistedRuntimeEvent;
    });
    this.writeQueue = write.then(() => undefined, () => undefined);
    return await write;
  }

  private async insertRuntimeEventRecord(runtimeEvent: RuntimeEvent): Promise<RuntimeEvent> {
    const index = this.data.events.length;
    const sequence = await this.nextEventSequence();
    const persistedRuntimeEvent = { ...runtimeEvent, sequence };
    await this.run(
      "INSERT INTO events (id, session_id, turn_id, name, timestamp, sequence, sort_index, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        runtimeEvent.id,
        runtimeEvent.sessionId ?? null,
        runtimeEvent.turnId ?? null,
        runtimeEvent.name,
        runtimeEvent.timestamp,
        sequence,
        index,
        JSON.stringify(persistedRuntimeEvent),
      ],
    );
    if (runtimeEvent.sessionId) {
      await this.updateThreadDetailProjectionForEvent(persistedRuntimeEvent, sequence);
    }
    return persistedRuntimeEvent;
  }

  private async upsertOpenPondThreadGoal(
    mutation: OpenPondThreadGoalMutation,
    provisional: boolean,
  ): Promise<void> {
    if (mutation.kind === "clear") {
      await this.run("DELETE FROM openpond_thread_goals WHERE session_id = ?", [mutation.sessionId]);
      return;
    }
    const existing = await this.get<OpenPondThreadGoalRow>(
      "SELECT * FROM openpond_thread_goals WHERE session_id = ?",
      [mutation.sessionId],
    );
    if (isTerminalOpenPondGoalStatus(mutation.status)) {
      if (existing?.goal_id === mutation.goalId) {
        await this.run("DELETE FROM openpond_thread_goals WHERE session_id = ? AND goal_id = ?", [
          mutation.sessionId,
          mutation.goalId,
        ]);
      }
      return;
    }
    if (existing && existing.goal_id !== mutation.goalId) {
      throw new Error(
        `OpenPond goal ${existing.goal_id} is already ${existing.status} for session ${mutation.sessionId}. Complete, stop, or restart it before starting another current goal.`,
      );
    }
    await this.run(
      `INSERT INTO openpond_thread_goals (session_id, goal_id, status, provisional, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id)
       DO UPDATE SET
         goal_id = excluded.goal_id,
         status = excluded.status,
         provisional = CASE
           WHEN openpond_thread_goals.provisional = 0 THEN 0
           ELSE excluded.provisional
         END,
         updated_at = excluded.updated_at`,
      [mutation.sessionId, mutation.goalId, mutation.status, provisional ? 1 : 0, mutation.updatedAt],
    );
  }

  async runtimeEventContext(
    sessionId: string,
    providerTurnId?: string | null
  ): Promise<{ appId?: string | null; turnId?: string | null }> {
    await this.ready;
    await this.writeQueue;
    const turn = providerTurnId
      ? await this.turnByProviderTurnId(providerTurnId)
      : await this.latestTurnForSession(sessionId, "in_progress");
    const session = await this.getSession(sessionId);
    return {
      appId: session?.appId,
      turnId: turn?.id,
    };
  }

  async listTrainingSources(profileId: string): Promise<TrainingSourceRef[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>("SELECT payload FROM training_sources WHERE profile_id = ? ORDER BY updated_at DESC", [profileId]);
    return rows.map((row) => TrainingSourceRefSchema.parse(JSON.parse(row.payload)));
  }

  async getTrainingSource(id: string): Promise<TrainingSourceRef | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>("SELECT payload FROM training_sources WHERE id = ?", [id]);
    return row ? TrainingSourceRefSchema.parse(JSON.parse(row.payload)) : null;
  }

  async upsertTrainingSource(sourceInput: TrainingSourceRef): Promise<TrainingSourceRef> {
    const source = TrainingSourceRefSchema.parse(sourceInput);
    await this.ready;
    const timestamp = now();
    const write = this.writeQueue.then(() => this.run(
      `INSERT INTO training_sources (id, profile_id, session_id, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, session_id = excluded.session_id, payload = excluded.payload, updated_at = excluded.updated_at`,
      [source.id, source.profileId, source.sessionId, JSON.stringify(source), timestamp, timestamp],
    ));
    this.writeQueue = write.catch(() => undefined);
    await write;
    return source;
  }

  async deleteTrainingSource(id: string): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(() => this.run("DELETE FROM training_sources WHERE id = ?", [id]));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async listTaskCreationSnapshots(profileId: string): Promise<TaskCreationSnapshot[]> {
    return this.listParsedPayloads("SELECT payload FROM task_creation_snapshots WHERE profile_id = ? ORDER BY updated_at DESC", [profileId], TaskCreationSnapshotSchema.parse);
  }

  async getTaskCreationSnapshot(id: string): Promise<TaskCreationSnapshot | null> {
    return this.getParsedPayload("SELECT payload FROM task_creation_snapshots WHERE id = ?", [id], TaskCreationSnapshotSchema.parse);
  }

  async upsertTaskCreationSnapshot(snapshotInput: TaskCreationSnapshot): Promise<TaskCreationSnapshot> {
    const snapshot = TaskCreationSnapshotSchema.parse(snapshotInput);
    const transcript = TaskCreationTranscriptSchema.parse({ schemaVersion: "openpond.taskCreationTranscript.v1", creationId: snapshot.id, profileId: snapshot.request.profileId, messages: snapshot.transcript, updatedAt: snapshot.updatedAt });
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        await this.run(`INSERT INTO task_creation_snapshots (id, profile_id, state, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, state = excluded.state, payload = excluded.payload, updated_at = excluded.updated_at`, [snapshot.id, snapshot.request.profileId, snapshot.state, JSON.stringify(snapshot), snapshot.createdAt, snapshot.updatedAt]);
        await this.run(`INSERT INTO task_creation_transcripts (creation_id, profile_id, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(creation_id) DO UPDATE SET profile_id = excluded.profile_id, payload = excluded.payload, updated_at = excluded.updated_at`, [snapshot.id, snapshot.request.profileId, JSON.stringify(transcript), snapshot.updatedAt]);
        if (snapshot.proposal) await this.run(`INSERT INTO task_design_proposals (creation_id, proposal_id, profile_id, state, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(creation_id) DO UPDATE SET proposal_id = excluded.proposal_id, profile_id = excluded.profile_id, state = excluded.state, payload = excluded.payload, updated_at = excluded.updated_at`, [snapshot.id, snapshot.proposal.id, snapshot.request.profileId, snapshot.state, JSON.stringify(snapshot.proposal), snapshot.updatedAt]);
        else await this.run("DELETE FROM task_design_proposals WHERE creation_id = ?", [snapshot.id]);
        await this.exec("COMMIT");
      } catch (error) { await this.exec("ROLLBACK").catch(() => undefined); throw error; }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    return snapshot;
  }

  async getTaskCreationTranscript(creationId: string) {
    return this.getParsedPayload("SELECT payload FROM task_creation_transcripts WHERE creation_id = ?", [creationId], TaskCreationTranscriptSchema.parse);
  }

  async getTaskDesignProposal(creationId: string) {
    return this.getParsedPayload("SELECT payload FROM task_design_proposals WHERE creation_id = ?", [creationId], TaskDesignProposalSchema.parse);
  }

  async listTasksets(profileId: string): Promise<Taskset[]> {
    return this.listParsedPayloads("SELECT payload FROM tasksets WHERE profile_id = ? ORDER BY updated_at DESC", [profileId], TasksetSchema.parse);
  }

  async getTaskset(id: string): Promise<Taskset | null> {
    return this.getParsedPayload("SELECT payload FROM tasksets WHERE id = ?", [id], TasksetSchema.parse);
  }

  async upsertTaskset(tasksetInput: Taskset): Promise<Taskset> {
    const taskset = TasksetSchema.parse(tasksetInput);
    await this.upsertPayload(
      `INSERT INTO tasksets (id, profile_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
      [taskset.id, taskset.profileId, taskset.status, JSON.stringify(taskset), taskset.createdAt, taskset.updatedAt],
    );
    return taskset;
  }

  async deleteTasksetData(id: string): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(async () => {
      await this.exec("BEGIN IMMEDIATE");
      try {
        await this.run("DELETE FROM grade_results WHERE attempt_id IN (SELECT id FROM task_attempts WHERE taskset_id = ?)", [id]);
        await this.run("DELETE FROM task_attempt_artifacts WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM task_attempts WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM baseline_reports WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM grader_audit_reports WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM readiness_reports WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM training_artifacts WHERE job_id IN (SELECT id FROM training_jobs WHERE plan_id IN (SELECT id FROM training_plans WHERE taskset_id = ?))", [id]);
        await this.run("DELETE FROM training_job_events WHERE job_id IN (SELECT id FROM training_jobs WHERE plan_id IN (SELECT id FROM training_plans WHERE taskset_id = ?))", [id]);
        await this.run("DELETE FROM training_jobs WHERE plan_id IN (SELECT id FROM training_plans WHERE taskset_id = ?)", [id]);
        await this.run("DELETE FROM training_approvals WHERE plan_id IN (SELECT id FROM training_plans WHERE taskset_id = ?)", [id]);
        await this.run("DELETE FROM training_bundles WHERE plan_id IN (SELECT id FROM training_plans WHERE taskset_id = ?)", [id]);
        await this.run("DELETE FROM model_artifact_lineage WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM training_plans WHERE taskset_id = ?", [id]);
        await this.run("DELETE FROM task_design_proposals WHERE creation_id IN (SELECT id FROM task_creation_snapshots WHERE json_extract(payload, '$.materializedTasksetId') = ?)", [id]);
        await this.run("DELETE FROM task_creation_transcripts WHERE creation_id IN (SELECT id FROM task_creation_snapshots WHERE json_extract(payload, '$.materializedTasksetId') = ?)", [id]);
        await this.run("DELETE FROM task_creation_snapshots WHERE json_extract(payload, '$.materializedTasksetId') = ?", [id]);
        await this.run("DELETE FROM tasksets WHERE id = ?", [id]);
        await this.exec("COMMIT");
      } catch (error) {
        await this.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async listTaskCandidates(profileId: string, status?: TaskCandidateStatus | "all"): Promise<TaskCandidate[]> {
    const sql = status && status !== "all"
      ? "SELECT payload FROM task_candidates WHERE profile_id = ? AND status = ? ORDER BY updated_at DESC"
      : "SELECT payload FROM task_candidates WHERE profile_id = ? ORDER BY updated_at DESC";
    return this.listParsedPayloads(sql, status && status !== "all" ? [profileId, status] : [profileId], TaskCandidateSchema.parse);
  }

  async getTaskCandidate(id: string): Promise<TaskCandidate | null> {
    return this.getParsedPayload("SELECT payload FROM task_candidates WHERE id = ?", [id], TaskCandidateSchema.parse);
  }

  async findTaskCandidateByFingerprint(profileId: string, fingerprint: string): Promise<TaskCandidate | null> {
    return this.getParsedPayload("SELECT payload FROM task_candidates WHERE profile_id = ? AND fingerprint = ?", [profileId, fingerprint], TaskCandidateSchema.parse);
  }

  async upsertTaskCandidate(candidateInput: TaskCandidate): Promise<TaskCandidate> {
    const candidate = TaskCandidateSchema.parse(candidateInput);
    await this.upsertPayload(
      `INSERT INTO task_candidates (id, profile_id, status, fingerprint, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, status = excluded.status, fingerprint = excluded.fingerprint, payload = excluded.payload, updated_at = excluded.updated_at`,
      [candidate.id, candidate.profileId, candidate.status, candidate.fingerprint, JSON.stringify(candidate), candidate.createdAt, candidate.updatedAt],
    );
    return candidate;
  }

  async saveTaskAttempt(attemptInput: TaskAttemptResult): Promise<TaskAttemptResult> {
    const attempt = TaskAttemptResultSchema.parse(attemptInput);
    await this.upsertPayload(
      `INSERT INTO task_attempts (id, taskset_id, split, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET taskset_id = excluded.taskset_id, split = excluded.split, payload = excluded.payload`,
      [attempt.id, attempt.tasksetId, attempt.split, JSON.stringify(attempt), attempt.completedAt],
    );
    return attempt;
  }

  async listTaskAttempts(tasksetId: string): Promise<TaskAttemptResult[]> {
    return this.listParsedPayloads("SELECT payload FROM task_attempts WHERE taskset_id = ? ORDER BY created_at ASC", [tasksetId], TaskAttemptResultSchema.parse);
  }

  async saveTaskAttemptArtifact(artifactInput: TaskAttemptArtifact): Promise<TaskAttemptArtifact> {
    const artifact = TaskAttemptArtifactSchema.parse(artifactInput);
    await this.upsertPayload(`INSERT INTO task_attempt_artifacts (id, taskset_id, attempt_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET taskset_id = excluded.taskset_id, attempt_id = excluded.attempt_id, kind = excluded.kind, payload = excluded.payload`, [artifact.id, artifact.tasksetId, artifact.attemptId, artifact.kind, JSON.stringify(artifact), artifact.createdAt]);
    return artifact;
  }

  async listTaskAttemptArtifacts(input: { tasksetId?: string; attemptId?: string }): Promise<TaskAttemptArtifact[]> {
    if (input.attemptId) return this.listParsedPayloads("SELECT payload FROM task_attempt_artifacts WHERE attempt_id = ? ORDER BY created_at", [input.attemptId], TaskAttemptArtifactSchema.parse);
    if (input.tasksetId) return this.listParsedPayloads("SELECT payload FROM task_attempt_artifacts WHERE taskset_id = ? ORDER BY created_at", [input.tasksetId], TaskAttemptArtifactSchema.parse);
    return [];
  }

  async saveGradeResult(resultInput: GradeResult): Promise<GradeResult> {
    const result = GradeResultSchema.parse(resultInput);
    await this.upsertPayload(
      `INSERT INTO grade_results (id, attempt_id, payload, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET attempt_id = excluded.attempt_id, payload = excluded.payload`,
      [result.id, result.attemptId, JSON.stringify(result), result.createdAt],
    );
    return result;
  }

  async listGradeResultsForTaskset(tasksetId: string): Promise<GradeResult[]> {
    return this.listParsedPayloads(
      `SELECT grades.payload FROM grade_results grades JOIN task_attempts attempts ON attempts.id = grades.attempt_id WHERE attempts.taskset_id = ? ORDER BY grades.created_at ASC`,
      [tasksetId],
      GradeResultSchema.parse,
    );
  }

  async saveBaselineReport(reportInput: BaselineReport): Promise<BaselineReport> {
    const report = BaselineReportSchema.parse(reportInput);
    await this.upsertPayload(
      `INSERT INTO baseline_reports (id, taskset_id, payload, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET taskset_id = excluded.taskset_id, payload = excluded.payload`,
      [report.id, report.tasksetId, JSON.stringify(report), report.createdAt],
    );
    return report;
  }

  async listBaselineReports(tasksetId: string): Promise<BaselineReport[]> {
    return this.listParsedPayloads("SELECT payload FROM baseline_reports WHERE taskset_id = ? ORDER BY created_at DESC", [tasksetId], BaselineReportSchema.parse);
  }

  async saveGraderAuditReport(reportInput: GraderAuditReport): Promise<GraderAuditReport> {
    const report = GraderAuditReportSchema.parse(reportInput);
    await this.upsertPayload(`INSERT INTO grader_audit_reports (id, taskset_id, payload, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET taskset_id = excluded.taskset_id, payload = excluded.payload`, [report.id, report.tasksetId, JSON.stringify(report), report.createdAt]);
    return report;
  }

  async listGraderAuditReports(tasksetId: string): Promise<GraderAuditReport[]> {
    return this.listParsedPayloads("SELECT payload FROM grader_audit_reports WHERE taskset_id = ? ORDER BY created_at DESC", [tasksetId], GraderAuditReportSchema.parse);
  }

  async saveReadinessReport(reportInput: TasksetReadinessReport): Promise<TasksetReadinessReport> {
    const report = TasksetReadinessReportSchema.parse(reportInput);
    await this.upsertPayload(
      `INSERT INTO readiness_reports (taskset_id, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(taskset_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [report.tasksetId, JSON.stringify(report), report.generatedAt],
    );
    return report;
  }

  async getReadinessReport(tasksetId: string): Promise<TasksetReadinessReport | null> {
    return this.getParsedPayload("SELECT payload FROM readiness_reports WHERE taskset_id = ?", [tasksetId], TasksetReadinessReportSchema.parse);
  }

  async saveTaskMinerConfig(profileId: string, configInput: TaskMinerConfig): Promise<TaskMinerConfig> {
    const config = TaskMinerConfigSchema.parse(configInput);
    await this.upsertPayload(
      `INSERT INTO task_miner_configs (profile_id, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [profileId, JSON.stringify(config), now()],
    );
    return config;
  }

  async getTaskMinerConfig(profileId: string): Promise<TaskMinerConfig | null> {
    return this.getParsedPayload("SELECT payload FROM task_miner_configs WHERE profile_id = ?", [profileId], TaskMinerConfigSchema.parse);
  }

  async saveTaskMinerRun(runInput: TaskMinerRun): Promise<TaskMinerRun> {
    const run = TaskMinerRunSchema.parse(runInput);
    await this.upsertPayload(
      `INSERT INTO task_miner_runs (id, profile_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
      [run.id, run.profileId, run.status, JSON.stringify(run), run.createdAt, run.updatedAt],
    );
    return run;
  }

  async getTaskMinerRun(id: string): Promise<TaskMinerRun | null> {
    return this.getParsedPayload("SELECT payload FROM task_miner_runs WHERE id = ?", [id], TaskMinerRunSchema.parse);
  }

  async listTaskMinerRuns(profileId: string): Promise<TaskMinerRun[]> {
    return this.listParsedPayloads("SELECT payload FROM task_miner_runs WHERE profile_id = ? ORDER BY updated_at DESC", [profileId], TaskMinerRunSchema.parse);
  }

  async saveTrainingPlan(planInput: TrainingPlan): Promise<TrainingPlan> {
    const plan = TrainingPlanSchema.parse(planInput);
    await this.upsertPayload(
      `INSERT INTO training_plans (id, taskset_id, destination_id, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET taskset_id = excluded.taskset_id, destination_id = excluded.destination_id, payload = excluded.payload`,
      [plan.id, plan.tasksetId, plan.destinationId, JSON.stringify(plan), plan.createdAt],
    );
    return plan;
  }

  async listTrainingPlans(tasksetId?: string): Promise<TrainingPlan[]> {
    return this.listParsedPayloads(tasksetId ? "SELECT payload FROM training_plans WHERE taskset_id = ? ORDER BY created_at DESC" : "SELECT payload FROM training_plans ORDER BY created_at DESC", tasksetId ? [tasksetId] : [], TrainingPlanSchema.parse);
  }

  async getTrainingPlan(id: string): Promise<TrainingPlan | null> {
    return this.getParsedPayload("SELECT payload FROM training_plans WHERE id = ?", [id], TrainingPlanSchema.parse);
  }

  async saveTrainingBundle(bundleInput: TrainingBundleManifest): Promise<TrainingBundleManifest> {
    const bundle = TrainingBundleManifestSchema.parse(bundleInput);
    await this.upsertPayload(
      `INSERT INTO training_bundles (id, plan_id, content_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, content_hash = excluded.content_hash, payload = excluded.payload`,
      [bundle.id, bundle.planId, bundle.contentHash, JSON.stringify(bundle), bundle.createdAt],
    );
    return bundle;
  }

  async getTrainingBundle(id: string): Promise<TrainingBundleManifest | null> {
    return this.getParsedPayload("SELECT payload FROM training_bundles WHERE id = ?", [id], TrainingBundleManifestSchema.parse);
  }

  async listTrainingBundles(planId?: string): Promise<TrainingBundleManifest[]> {
    return this.listParsedPayloads(planId ? "SELECT payload FROM training_bundles WHERE plan_id = ? ORDER BY created_at DESC" : "SELECT payload FROM training_bundles ORDER BY created_at DESC", planId ? [planId] : [], TrainingBundleManifestSchema.parse);
  }

  async findTrainingBundleByPlanAndHash(planId: string, contentHash: string): Promise<TrainingBundleManifest | null> {
    return this.getParsedPayload("SELECT payload FROM training_bundles WHERE plan_id = ? AND content_hash = ?", [planId, contentHash], TrainingBundleManifestSchema.parse);
  }

  async saveTrainingJob(jobInput: TrainingJob): Promise<TrainingJob> {
    const job = TrainingJobSchema.parse(jobInput);
    await this.upsertPayload(
      `INSERT INTO training_jobs (id, plan_id, destination_id, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, destination_id = excluded.destination_id, status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
      [job.id, job.planId, job.destinationId, job.status, JSON.stringify(job), job.createdAt, job.updatedAt],
    );
    return job;
  }

  async saveTrainingApproval(approvalInput: TrainingApproval): Promise<TrainingApproval> {
    const approval = TrainingApprovalSchema.parse(approvalInput);
    await this.upsertPayload(
      `INSERT INTO training_approvals (id, plan_id, bundle_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, bundle_hash = excluded.bundle_hash, payload = excluded.payload`,
      [approval.id, approval.planId, approval.bundleHash, JSON.stringify(approval), approval.approvedAt],
    );
    return approval;
  }

  async getTrainingApproval(id: string): Promise<TrainingApproval | null> {
    return this.getParsedPayload("SELECT payload FROM training_approvals WHERE id = ?", [id], TrainingApprovalSchema.parse);
  }

  async getTrainingJob(id: string): Promise<TrainingJob | null> {
    return this.getParsedPayload("SELECT payload FROM training_jobs WHERE id = ?", [id], TrainingJobSchema.parse);
  }

  async listTrainingJobs(): Promise<TrainingJob[]> {
    return this.listParsedPayloads("SELECT payload FROM training_jobs ORDER BY updated_at DESC", [], TrainingJobSchema.parse);
  }

  async saveTrainingJobEvent(eventInput: TrainingJobEvent): Promise<TrainingJobEvent> {
    const event = TrainingJobEventSchema.parse(eventInput);
    await this.upsertPayload(
      `INSERT INTO training_job_events (id, job_id, sequence, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET job_id = excluded.job_id, sequence = excluded.sequence, payload = excluded.payload`,
      [event.id, event.jobId, event.sequence, JSON.stringify(event), event.timestamp],
    );
    return event;
  }

  async listTrainingJobEvents(jobId: string): Promise<TrainingJobEvent[]> {
    return this.listParsedPayloads("SELECT payload FROM training_job_events WHERE job_id = ? ORDER BY sequence ASC", [jobId], TrainingJobEventSchema.parse);
  }

  async saveTrainingArtifact(artifactInput: TrainingArtifact): Promise<TrainingArtifact> {
    const artifact = TrainingArtifactSchema.parse(artifactInput);
    await this.upsertPayload(
      `INSERT INTO training_artifacts (id, job_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET job_id = excluded.job_id, kind = excluded.kind, payload = excluded.payload`,
      [artifact.id, artifact.jobId, artifact.kind, JSON.stringify(artifact), artifact.createdAt],
    );
    return artifact;
  }

  async listTrainingArtifacts(jobId?: string): Promise<TrainingArtifact[]> {
    return this.listParsedPayloads(jobId ? "SELECT payload FROM training_artifacts WHERE job_id = ? ORDER BY created_at DESC" : "SELECT payload FROM training_artifacts ORDER BY created_at DESC", jobId ? [jobId] : [], TrainingArtifactSchema.parse);
  }

  async getTrainingArtifact(id: string): Promise<TrainingArtifact | null> {
    return this.getParsedPayload("SELECT payload FROM training_artifacts WHERE id = ?", [id], TrainingArtifactSchema.parse);
  }

  async saveModelArtifactLineage(lineageInput: ModelArtifactLineage): Promise<ModelArtifactLineage> {
    const lineage = ModelArtifactLineageSchema.parse(lineageInput);
    await this.upsertPayload(
      `INSERT INTO model_artifact_lineage (id, artifact_id, taskset_id, payload, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET artifact_id = excluded.artifact_id, taskset_id = excluded.taskset_id, payload = excluded.payload`,
      [lineage.id, lineage.artifactId, lineage.tasksetId, JSON.stringify(lineage), lineage.importedAt],
    );
    return lineage;
  }

  async listModelArtifactLineage(tasksetId?: string): Promise<ModelArtifactLineage[]> {
    return this.listParsedPayloads(tasksetId ? "SELECT payload FROM model_artifact_lineage WHERE taskset_id = ? ORDER BY created_at DESC" : "SELECT payload FROM model_artifact_lineage ORDER BY created_at DESC", tasksetId ? [tasksetId] : [], ModelArtifactLineageSchema.parse);
  }

  async getModelArtifactLineage(id: string): Promise<ModelArtifactLineage | null> {
    return this.getParsedPayload("SELECT payload FROM model_artifact_lineage WHERE id = ?", [id], ModelArtifactLineageSchema.parse);
  }

  private async upsertPayload(sql: string, params: unknown[]): Promise<void> {
    await this.ready;
    const write = this.writeQueue.then(() => this.run(sql, params));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  private async listParsedPayloads<T>(sql: string, params: unknown[], parse: (value: unknown) => T): Promise<T[]> {
    await this.ready;
    await this.writeQueue;
    const rows = await this.all<PayloadRow>(sql, params);
    return rows.map((row) => parse(JSON.parse(row.payload)));
  }

  private async getParsedPayload<T>(sql: string, params: unknown[], parse: (value: unknown) => T): Promise<T | null> {
    await this.ready;
    await this.writeQueue;
    const row = await this.get<PayloadRow>(sql, params);
    return row ? parse(JSON.parse(row.payload)) : null;
  }

}

function trainingChatSearchResult(
  query: string,
  offset: number,
  limit: number,
  total: number,
  rows: TrainingChatSearchResultRow[],
  indexedChats: number,
  totalChats: number,
): TrainingChatSearchResult {
  return {
    schemaVersion: "openpond.trainingChatSearchResult.v1",
    query,
    offset,
    limit,
    total,
    hasMore: offset + rows.length < total,
    indexedChats,
    totalChats,
    indexing: indexedChats < totalChats,
    entries: rows.map((row) => ({
      sessionId: row.session_id,
      title: row.title,
      updatedAt: row.updated_at,
      snippet: row.snippet?.trim() || null,
    })),
  };
}

function trainingChatFtsQuery(query: string): string | null {
  const tokens = query.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu)?.slice(0, 24) ?? [];
  if (!tokens.length) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

function appendTrainingChatSearchText(target: Map<string, string[]>, sessionId: string, text: string): void {
  const values = target.get(sessionId) ?? [];
  values.push(text);
  target.set(sessionId, values);
}
