import { createHash } from "node:crypto";
import type {
  InsightEvidenceSource,
  InsightItem,
  InsightSeverity,
  RuntimeEvent,
  Turn,
} from "@openpond/contracts";

export type RuntimeEventEntry = { sequence: number; event: RuntimeEvent };
export type InsightEvidenceCandidate = {
  item: InsightItem | null;
  evidenceSource: InsightEvidenceSource;
  evidenceKey: string;
  keepFingerprint: string | null;
};

export function detectRepeatedToolFailures(entries: RuntimeEventEntry[], timestamp: string): InsightEvidenceCandidate[] {
  const groups = new Map<string, RuntimeEventEntry[]>();
  for (const entry of entries) {
    if (!isFailedToolEvent(entry.event)) continue;
    const sessionId = entry.event.sessionId ?? "global";
    const action = eventActionLabel(entry.event);
    const key = `${sessionId}:${action}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return Array.from(groups.entries()).filter(([, group]) => group.length >= 2).map(([key, group]) => {
    const latest = group[group.length - 1]!;
    const action = eventActionLabel(latest.event);
    return candidate(item({ evidenceSource: "tool_failure", evidenceKey: key, timestamp, severity: group.length >= 3 ? "blocker" : "concern", type: "tool.repeated_failure", title: `Repeated ${action} failures`, summary: `${group.length} failed ${action} events were observed in this chat.`, scopeType: latest.event.sessionId ? "session" : "global", scopeId: latest.event.sessionId ?? "local", payload: { action, failureCount: group.length, sessionId: latest.event.sessionId ?? null, turnId: latest.event.turnId ?? null, eventIds: group.map((entry) => entry.event.id), sourceEventSequence: latest.sequence } }));
  });
}

export function detectStuckOrFailedTurns(turns: Turn[], timestamp: string): InsightEvidenceCandidate[] {
  const timestampMs = Date.parse(timestamp);
  return turns.filter((turn) => !isInsightsTurn(turn) && (turn.status === "failed" || isTurnOlderThan(turn, timestampMs, 15 * 60_000))).map((turn) => {
    const stuck = turn.status === "in_progress";
    return candidate(item({ evidenceSource: "stuck_turn", evidenceKey: turn.id, timestamp, severity: stuck ? "concern" : "blocker", type: stuck ? "turn.stuck" : "turn.failed", title: stuck ? "Turn appears stuck" : "Turn failed", summary: stuck ? `A turn has been running since ${turn.startedAt}.` : turn.error ?? "A turn failed without completing successfully.", scopeType: "session", scopeId: turn.sessionId, payload: { sessionId: turn.sessionId, turnId: turn.id, prompt: compact(turn.prompt), turnStatus: turn.status, startedAt: turn.startedAt, completedAt: turn.completedAt, error: turn.error } }));
  });
}

export function detectAbandonedGoals(entries: RuntimeEventEntry[], timestamp: string): InsightEvidenceCandidate[] {
  const latestByGoalId = new Map<string, { entry: RuntimeEventEntry; goal: Record<string, unknown> }>();
  for (const entry of entries) {
    const record = object(entry.event.data);
    if (record.kind !== "thread_goal") continue;
    const goal = object(record.goal);
    const goalId = text(goal.id);
    if (goalId) latestByGoalId.set(goalId, { entry, goal });
  }
  const timestampMs = Date.parse(timestamp);
  return Array.from(latestByGoalId.entries()).filter(([, latest]) => text(latest.goal.status) === "active" && isOlderThan(text(latest.goal.startedAt) ?? latest.entry.event.timestamp, timestampMs, 30 * 60_000)).map(([goalId, latest]) => candidate(item({ evidenceSource: "abandoned_goal", evidenceKey: goalId, timestamp, severity: "concern", type: "goal.abandoned", title: "Goal appears abandoned", summary: `Goal "${text(latest.goal.objective) ?? goalId}" is still active without a completion event.`, scopeType: latest.entry.event.sessionId ? "session" : "global", scopeId: latest.entry.event.sessionId ?? "local", payload: { goalId, goalStatus: text(latest.goal.status), goalObjective: text(latest.goal.objective), sessionId: latest.entry.event.sessionId ?? null, turnId: latest.entry.event.turnId ?? null, sourceEventSequence: latest.entry.sequence } })));
}

export function detectRepeatedUserCorrections(entries: RuntimeEventEntry[], timestamp: string): InsightEvidenceCandidate[] {
  const groups = new Map<string, RuntimeEventEntry[]>();
  for (const entry of entries) {
    if (entry.event.name !== "turn.started") continue;
    const prompt = text(object(entry.event.args).prompt);
    if (!prompt || !looksLikeCorrection(prompt)) continue;
    const key = entry.event.sessionId ?? "global";
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return Array.from(groups.entries()).filter(([, group]) => group.length >= 2).map(([sessionId, group]) => {
    const latest = group[group.length - 1]!;
    return candidate(item({ evidenceSource: "user_correction", evidenceKey: sessionId, timestamp, severity: "concern", type: "conversation.repeated_corrections", title: "Repeated user corrections", summary: `${group.length} recent turns look like corrections or repeated instructions.`, scopeType: latest.event.sessionId ? "session" : "global", scopeId: latest.event.sessionId ?? "local", payload: { sessionId: latest.event.sessionId ?? null, turnId: latest.event.turnId ?? null, correctionCount: group.length, latestPrompt: text(object(latest.event.args).prompt), sourceEventSequence: latest.sequence } }));
  });
}

export function detectLongRunningUnresolvedConversations(turns: Turn[], timestamp: string): InsightEvidenceCandidate[] {
  const bySession = new Map<string, Turn[]>();
  for (const turn of turns) if (!isInsightsTurn(turn)) bySession.set(turn.sessionId, [...(bySession.get(turn.sessionId) ?? []), turn]);
  return Array.from(bySession.entries()).filter(([, values]) => values.length >= 8).map(([sessionId, values]) => ({ sessionId, turns: values.slice().sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)) })).filter(({ turns: values }) => values.at(-1)?.status !== "completed" || values.slice(-4).some((turn) => turn.status === "failed")).map(({ sessionId, turns: values }) => {
    const latest = values.at(-1)!;
    return candidate(item({ evidenceSource: "unresolved_conversation", evidenceKey: sessionId, timestamp, severity: "nit", type: "conversation.long_running_unresolved", title: "Long-running chat may be unresolved", summary: `${values.length} turns are present and the latest work does not look cleanly resolved.`, scopeType: "session", scopeId: sessionId, payload: { sessionId, turnId: latest.id, turnCount: values.length, latestTurnStatus: latest.status, startedAt: values[0]?.startedAt ?? null, latestTurnStartedAt: latest.startedAt } }));
  });
}

function item(input: { evidenceSource: InsightEvidenceSource; evidenceKey: string; timestamp: string; severity: InsightSeverity; type: string; title: string; summary: string; scopeType: InsightItem["scopeType"]; scopeId: string; payload: Record<string, unknown> }): InsightItem {
  const fingerprint = ["openpond.insights", input.evidenceSource, input.evidenceKey, input.type].join(":");
  return { id: `insight_${hash(fingerprint)}`, scopeType: input.scopeType, scopeId: input.scopeId, severity: input.severity, type: input.type, status: "active", fingerprint, title: input.title, summary: compact(input.summary), payload: { ...input.payload, evidenceSource: input.evidenceSource, evidenceKey: input.evidenceKey }, lastRunId: null, lastRunSessionId: null, lastRunTurnId: null, createdAt: input.timestamp, updatedAt: input.timestamp, resolvedAt: null, dismissedAt: null };
}
function candidate(value: InsightItem): InsightEvidenceCandidate { return { item: value, evidenceSource: value.payload.evidenceSource as InsightEvidenceSource, evidenceKey: String(value.payload.evidenceKey), keepFingerprint: value.fingerprint }; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function compact(value: string): string { const normalized = value.replace(/\s+/g, " ").trim(); return normalized.length <= 360 ? normalized : `${normalized.slice(0, 357)}...`; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 20); }
function isInsightsTurn(turn: Turn): boolean { return Boolean(turn.metadata?.insightsRun || turn.metadata?.insightsQuestion); }
function isOlderThan(value: string, timestampMs: number, thresholdMs: number): boolean { const time = Date.parse(value); return Number.isFinite(time) && Number.isFinite(timestampMs) && timestampMs - time >= thresholdMs; }
function isTurnOlderThan(turn: Turn, timestampMs: number, thresholdMs: number): boolean { return turn.status === "in_progress" && !isInsightsTurn(turn) && isOlderThan(turn.startedAt, timestampMs, thresholdMs); }
function isFailedToolEvent(event: RuntimeEvent): boolean { return (event.name === "tool.completed" || event.name === "workspace_action_result") && (event.status === "failed" || Boolean(event.error)); }
function eventActionLabel(event: RuntimeEvent): string { const args = object(event.args); const data = object(event.data); return text(event.action) ?? text(args.action) ?? text(args.tool) ?? text(args.name) ?? text(data.action) ?? text(data.tool) ?? text(data.name) ?? event.name; }
function looksLikeCorrection(prompt: string): boolean { const normalized = prompt.toLowerCase(); return ["i told you", "not what i asked", "that's wrong", "that is wrong", "you didn't", "you did not", "again", "still not", "fix this", "why did you"].some((phrase) => normalized.includes(phrase)); }
