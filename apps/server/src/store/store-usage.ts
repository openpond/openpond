import { ContextUsageSnapshotSchema, type ContextUsageSnapshot } from "@openpond/contracts/settings";
import { ModelUsageRecordSchema, type ModelUsageRecord, type ModelUsageStatus, type ModelUsageVisibility } from "@openpond/contracts/usage";
import type { PayloadRow } from "../types.js";
import { modelUsageRecordFromRow, modelUsageRecordParams, runtimeEventWithSequence } from "./store-codecs.js";
import { SqliteStoreDomain } from "./store-domain.js";

type EventPagePayloadRow = PayloadRow & {
  sequence: number;
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
  cached_prompt_tokens: number | null;
  uncached_prompt_tokens: number | null;
  cache_write_prompt_tokens: number | null;
  cache_telemetry_source: string | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  error_type: string | null;
  error_message: string | null;
  attribution_json: string;
};

export class SqliteUsageStore extends SqliteStoreDomain {


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
           cached_prompt_tokens,
           uncached_prompt_tokens,
           cache_write_prompt_tokens,
           cache_telemetry_source,
           completion_tokens,
           total_tokens,
           error_type,
           error_message,
           attribution_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           cached_prompt_tokens = excluded.cached_prompt_tokens,
           uncached_prompt_tokens = excluded.uncached_prompt_tokens,
           cache_write_prompt_tokens = excluded.cache_write_prompt_tokens,
           cache_telemetry_source = excluded.cache_telemetry_source,
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
    provider?: ModelUsageRecord["provider"] | null;
    model?: string | null;
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
    if (query.provider) {
      where.push("provider = ?");
      params.push(query.provider);
    }
    if (query.model) {
      where.push("model = ?");
      params.push(query.model);
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
}
