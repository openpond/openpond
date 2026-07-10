import type {
  InsightItem,
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

export type OpenPondThreadGoalRow = {
  session_id: string;
  goal_id: string;
  status: string;
  provisional: number;
  updated_at: string;
};

export type OpenPondThreadGoalMutation =
  | { kind: "clear"; sessionId: string }
  | { kind: "upsert"; sessionId: string; goalId: string; status: string; updatedAt: string };

export type InsightItemRow = {
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
  parent_goal_id: string | null;
  child_session_id: string | null;
  role_id: string;
  status: SubagentRun["status"];
  created_at: string;
  updated_at: string;
};

export type SubagentMessageRow = PayloadRow & {
  id: string;
  parent_goal_id: string | null;
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

export function openPondThreadGoalMutationFromEvent(event: RuntimeEvent): OpenPondThreadGoalMutation | null {
  if (event.name !== "diagnostic" || !event.sessionId) return null;
  const data = recordValue(event.data);
  const provider = stringValue(data?.provider);
  if (data?.kind === "thread_goal_cleared") {
    return provider && provider !== "openpond" ? null : { kind: "clear", sessionId: event.sessionId };
  }
  if (data?.kind !== "thread_goal") return null;
  const goal = recordValue(data.goal);
  const goalProvider = provider ?? stringValue(goal?.provider) ?? "openpond";
  const goalId = stringValue(goal?.id);
  const status = stringValue(goal?.status);
  if (goalProvider !== "openpond" || !goalId || !status) return null;
  return {
    kind: "upsert",
    sessionId: event.sessionId,
    goalId,
    status,
    updatedAt: stringValue(goal?.updatedAt) ?? event.timestamp,
  };
}

export function isTerminalOpenPondGoalStatus(status: string): boolean {
  return status === "completed" ||
    status === "complete" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "stopped";
}

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
    payload.parentGoalId,
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
    message.parentGoalId,
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

export function insightItemFromRow(row: InsightItemRow): InsightItem {
  return {
    id: row.id,
    scopeType: row.scope_type as InsightItem["scopeType"],
    scopeId: row.scope_id,
    severity: row.severity as InsightItem["severity"],
    type: row.type,
    status: row.status as InsightItem["status"],
    fingerprint: row.fingerprint,
    title: row.title,
    summary: row.summary,
    payload: JSON.parse(row.payload) as InsightItem["payload"],
    lastRunId: row.last_run_id,
    lastRunSessionId: row.last_run_session_id,
    lastRunTurnId: row.last_run_turn_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    dismissedAt: row.dismissed_at,
  };
}

export function insightItemParams(item: InsightItem): unknown[] {
  return [
    item.id,
    item.scopeType,
    item.scopeId,
    item.severity,
    item.type,
    item.status,
    item.fingerprint,
    item.title,
    item.summary,
    JSON.stringify(item.payload),
    item.lastRunId ?? null,
    item.lastRunSessionId ?? null,
    item.lastRunTurnId ?? null,
    item.createdAt,
    item.updatedAt,
    item.resolvedAt,
    item.dismissedAt,
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
