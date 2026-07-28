import type {
  LocalAgentSchedule,
  LocalAgentScheduleRun,
  LocalAgentScheduleRunStatus,
  ModelUsageRecord,
  RuntimeEvent,
  SubagentMessage,
  SubagentRun,
  Turn,
} from "@openpond/contracts";
import {
  ModelUsageRecordSchema,
  SubagentMessageSchema,
  SubagentRunSchema,
} from "@openpond/contracts";
import type { PayloadRow } from "../types.js";
import { sanitizeRuntimeEvent } from "../runtime/runtime-event-sanitizer.js";

export type EventPagePayloadRow = PayloadRow & {
  sequence: number;
};

export type ModelUsageRecordRow = {
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

export type LocalAgentScheduleRow = PayloadRow & {
  id: string;
  local_project_id: string;
  schedule_name: string;
  enabled: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

export type LocalAgentScheduleRunRow = PayloadRow & {
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

export type SubagentRunRow = PayloadRow & {
  id: string;
  parent_session_id: string;
  parent_turn_id: string | null;
  child_session_id: string | null;
  role_id: string;
  status: SubagentRun["status"];
  created_at: string;
  updated_at: string;
};

export type SubagentMessageRow = PayloadRow & {
  id: string;
  from_run_id: string;
  to_run_id: string | null;
  to_role: string | null;
  kind: SubagentMessage["kind"];
  created_at: string;
};

export type ThreadDetailProjectionRow = PayloadRow & {
  session_id: string;
  event_count: number;
  latest_event_sequence: number;
  latest_event_at: string | null;
  latest_turn_id: string | null;
  latest_turn_status: Turn["status"] | null;
  pending_approval_count: number;
  updated_at: string;
};

export type ThreadDetailProjection = {
  sessionId: string;
  eventCount: number;
  latestEventSequence: number;
  latestEventAt: string | null;
  latestTurnId: string | null;
  latestTurnStatus: Turn["status"] | null;
  pendingApprovalCount: number;
  updatedAt: string;
};

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function localAgentScheduleFromRow(row: LocalAgentScheduleRow): LocalAgentSchedule {
  return JSON.parse(row.payload) as LocalAgentSchedule;
}

export function subagentRunFromRow(row: SubagentRunRow): SubagentRun {
  return SubagentRunSchema.parse({
    ...JSON.parse(row.payload),
    updatedAt: row.updated_at,
  });
}

export function subagentRunParams(run: SubagentRun, updatedAt: string): unknown[] {
  const payload = SubagentRunSchema.parse({
    ...run,
    updatedAt,
  });
  return [
    payload.id,
    payload.parentSessionId,
    payload.parentTurnId,
    payload.childSessionId,
    payload.roleId,
    payload.status,
    JSON.stringify(payload),
    payload.createdAt,
    updatedAt,
  ];
}

export function subagentMessageFromRow(row: SubagentMessageRow): SubagentMessage {
  return SubagentMessageSchema.parse(JSON.parse(row.payload));
}

export function subagentMessageParams(message: SubagentMessage): unknown[] {
  return [
    message.id,
    message.fromRunId,
    message.toRunId,
    message.toRole,
    message.kind,
    JSON.stringify(message),
    message.createdAt,
  ];
}

export function localAgentScheduleParams(schedule: LocalAgentSchedule): unknown[] {
  return [
    schedule.id,
    schedule.localProjectId,
    schedule.scheduleName,
    schedule.enabled ? 1 : 0,
    schedule.nextRunAt,
    JSON.stringify(schedule),
    schedule.createdAt,
    schedule.updatedAt,
  ];
}

export function localAgentScheduleRunFromRow(row: LocalAgentScheduleRunRow): LocalAgentScheduleRun {
  return JSON.parse(row.payload) as LocalAgentScheduleRun;
}

export function localAgentScheduleRunParams(run: LocalAgentScheduleRun): unknown[] {
  return [
    run.id,
    run.scheduleId,
    run.localProjectId,
    run.scheduleName,
    run.scheduledFor,
    run.trigger,
    run.status,
    JSON.stringify(run),
    run.createdAt,
    run.updatedAt,
  ];
}

export function modelUsageRecordFromRow(row: ModelUsageRecordRow): ModelUsageRecord {
  return ModelUsageRecordSchema.parse({
    id: row.id,
    requestId: row.request_id,
    requestOrdinal: row.request_ordinal,
    sessionId: row.session_id,
    turnId: row.turn_id,
    provider: row.provider,
    model: row.model,
    route: row.route,
    source: row.source,
    requestKind: row.request_kind,
    visibility: row.visibility,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    firstTokenMs: row.first_token_ms,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    errorType: row.error_type,
    errorMessage: row.error_message,
    attribution: JSON.parse(row.attribution_json) as unknown,
  });
}

export function modelUsageRecordParams(record: ModelUsageRecord): unknown[] {
  return [
    record.id,
    record.requestId,
    record.requestOrdinal,
    record.sessionId,
    record.turnId,
    record.provider,
    record.model,
    record.route,
    record.source,
    record.requestKind,
    record.visibility,
    record.status,
    record.startedAt,
    record.completedAt,
    record.durationMs,
    record.firstTokenMs,
    record.promptTokens,
    record.completionTokens,
    record.totalTokens,
    record.errorType,
    record.errorMessage,
    JSON.stringify(record.attribution),
  ];
}

export function timestampForPath(): string {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

export function runtimeEventWithSequence(payload: string, sequence: number): RuntimeEvent {
  return {
    ...sanitizeRuntimeEvent(JSON.parse(payload) as RuntimeEvent),
    sequence,
  };
}

export function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function threadDetailProjectionFromRow(row: ThreadDetailProjectionRow): ThreadDetailProjection {
  return threadDetailProjectionPayload({
    sessionId: row.session_id,
    eventCount: row.event_count,
    latestEventSequence: row.latest_event_sequence,
    latestEventAt: row.latest_event_at,
    latestTurnId: row.latest_turn_id,
    latestTurnStatus: row.latest_turn_status,
    pendingApprovalCount: row.pending_approval_count,
    updatedAt: row.updated_at,
  });
}

export function threadDetailProjectionPayload(input: ThreadDetailProjection): ThreadDetailProjection {
  return {
    sessionId: input.sessionId,
    eventCount: input.eventCount,
    latestEventSequence: input.latestEventSequence,
    latestEventAt: input.latestEventAt,
    latestTurnId: input.latestTurnId,
    latestTurnStatus: input.latestTurnStatus,
    pendingApprovalCount: input.pendingApprovalCount,
    updatedAt: input.updatedAt,
  };
}
