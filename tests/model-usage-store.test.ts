import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { ModelUsageRecord } from "@openpond/contracts";
import { SqliteStore } from "../apps/server/src/store/store";
import { allTestSql, closeTestDatabase, openTestDatabase } from "./helpers/sqlite-database";

describe("model usage store", () => {
  test("persists and updates normalized model usage rows by request id", async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "openpond-model-usage-store-"));
    const store = new SqliteStore(storeDir);

    try {
      const started = usageRecord({
        status: "started",
        completedAt: null,
        durationMs: null,
        totalTokens: null,
      });
      await store.upsertModelUsageRecord(started);

      const completed = usageRecord({
        status: "completed",
        completedAt: "2026-07-04T10:00:02.000Z",
        durationMs: 2000,
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
      });
      await store.upsertModelUsageRecord(completed);

      const stored = await store.getModelUsageRecordByRequestId("request_usage_1");
      expect(stored).toEqual(completed);

      const rows = await store.listModelUsageRecords({ sessionId: "session_usage_1" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.totalTokens).toBe(1500);
      expect("rawUsage" in (rows[0] as Record<string, unknown>)).toBe(false);

      expect(Object.keys(stored ?? {}).sort()).toEqual(expectedUsageRecordKeys);
      expect(Object.keys(stored?.attribution ?? {}).sort()).toEqual(expectedUsageAttributionKeys);
      for (const blockedKey of blockedUsageKeys) {
        expect(blockedKey in (stored as Record<string, unknown>)).toBe(false);
        expect(blockedKey in (stored?.attribution as Record<string, unknown>)).toBe(false);
      }

      await store.close();
      const rawColumns = await sqliteAll<{ name: string }>(store.storePath, "PRAGMA table_info(model_usage_records)");
      expect(rawColumns.map((column) => column.name).sort()).toEqual(expectedSqliteUsageColumns);
      const rawRows = await sqliteAll<Record<string, unknown>>(store.storePath, "SELECT * FROM model_usage_records");
      expect(rawRows).toHaveLength(1);
      expect(Object.keys(rawRows[0] ?? {}).sort()).toEqual(expectedSqliteUsageColumns);
      const rawAttribution = JSON.parse(String(rawRows[0]?.attribution_json ?? "{}")) as Record<string, unknown>;
      expect(Object.keys(rawAttribution).sort()).toEqual(expectedUsageAttributionKeys);
      for (const blockedKey of blockedUsageKeys) {
        expect(blockedKey in (rawRows[0] ?? {})).toBe(false);
        expect(blockedKey in rawAttribution).toBe(false);
      }
    } finally {
      await store.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});

const expectedUsageRecordKeys = [
  "attribution",
  "completedAt",
  "completionTokens",
  "durationMs",
  "errorMessage",
  "errorType",
  "firstTokenMs",
  "id",
  "model",
  "promptTokens",
  "provider",
  "requestId",
  "requestKind",
  "requestOrdinal",
  "route",
  "sessionId",
  "source",
  "startedAt",
  "status",
  "totalTokens",
  "turnId",
  "visibility",
].sort();

const expectedUsageAttributionKeys = [
  "appId",
  "cloudProjectId",
  "commandName",
  "commandSource",
  "createPipelineId",
  "createPipelineRequestId",
  "goalId",
  "insightRunId",
  "localProjectId",
  "sessionId",
  "sourceEventSequence",
  "subagentRoleId",
  "subagentRunId",
  "surface",
  "turnId",
  "workflowKind",
  "workspaceId",
  "workspaceKind",
].sort();

const expectedSqliteUsageColumns = [
  "attribution_json",
  "completed_at",
  "completion_tokens",
  "duration_ms",
  "error_message",
  "error_type",
  "first_token_ms",
  "id",
  "model",
  "prompt_tokens",
  "provider",
  "request_id",
  "request_kind",
  "request_ordinal",
  "route",
  "session_id",
  "source",
  "started_at",
  "status",
  "total_tokens",
  "turn_id",
  "visibility",
].sort();

const blockedUsageKeys = [
  "apiKey",
  "authorization",
  "body",
  "completion",
  "completionText",
  "headers",
  "messages",
  "prompt",
  "rawBody",
  "rawHeaders",
  "rawUsage",
  "requestBody",
  "responseBody",
  "secret",
  "tokenizedContent",
].sort();

function sqliteAll<T>(filename: string, sql: string): Promise<T[]> {
  const db = openTestDatabase(filename);
  return allTestSql<T>(db, sql).finally(() => closeTestDatabase(db));
}

function usageRecord(patch: Partial<ModelUsageRecord> = {}): ModelUsageRecord {
  return {
    id: "usage_1",
    requestId: "request_usage_1",
    requestOrdinal: 0,
    sessionId: "session_usage_1",
    turnId: "turn_usage_1",
    provider: "openai",
    model: "gpt-4.1",
    route: "local_byok",
    source: "provider_usage",
    requestKind: "chat_turn",
    visibility: "user_facing",
    status: "completed",
    startedAt: "2026-07-04T10:00:00.000Z",
    completedAt: "2026-07-04T10:00:01.000Z",
    durationMs: 1000,
    firstTokenMs: 120,
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    errorType: null,
    errorMessage: null,
    attribution: {
      surface: "chat",
      workflowKind: "direct_chat",
      sessionId: "session_usage_1",
      turnId: "turn_usage_1",
      insightRunId: null,
      goalId: null,
      createPipelineRequestId: null,
      createPipelineId: null,
      commandName: null,
      commandSource: null,
      appId: null,
      workspaceKind: "local_project",
      workspaceId: "project_usage_1",
      localProjectId: "project_usage_1",
      cloudProjectId: null,
      sourceEventSequence: null,
      subagentRoleId: null,
      subagentRunId: null,
    },
    ...patch,
  };
}
