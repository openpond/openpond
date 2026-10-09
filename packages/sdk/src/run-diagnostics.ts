import { z } from "zod";
import { contentHash } from "@openpond/harness";

const Id = z.string().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Time = z.iso.datetime();
const Amount = z.number().finite().nonnegative().nullable();
const Count = z.number().int().nonnegative().nullable();
export const DiagnosticEventSchema = z
  .object({
    id: Id,
    sequence: z.number().int().nonnegative(),
    at: Time.nullable(),
    type: z.string().max(160),
    action: z.string().max(160).nullable(),
    correlationId: Id.nullable(),
    attempt: Count,
    taskId: Id.nullable(),
    status: z.string().max(100).nullable(),
    errorCode: z.string().max(200).nullable(),
    cleanupComplete: z.boolean().nullable(),
  })
  .strict();
export const DiagnosticCallSchema = z
  .object({
    id: Id,
    kind: z.string().max(100),
    status: z.string().max(100),
    receiptId: Id.nullable(),
    maximumUsd: Amount,
    settledUsd: Amount,
    model: z.string().max(200).nullable(),
    durationMs: Count,
    inputTokens: Count,
    outputTokens: Count,
    totalTokens: Count,
  })
  .strict();
const Content = z
  .object({
    schemaVersion: z.literal("openpond.runDiagnostics.v1"),
    teamId: Id,
    runId: Id,
    location: z.enum(["local", "hosted"]),
    manifestHash: Hash,
    observedAt: Time,
    status: z.string().max(100),
    startedAt: Time.nullable(),
    completedAt: Time.nullable(),
    error: z.string().max(8192).nullable(),
    resultAvailable: z.boolean(),
    parent: z
      .object({
        id: Id,
        status: z.string().max(100),
        attempt: Count,
        heartbeatAt: Time.nullable(),
        leaseExpiresAt: Time.nullable(),
        releasedAt: Time.nullable(),
        errorCode: z.string().max(200).nullable(),
      })
      .strict()
      .nullable(),
    accounting: z
      .object({
        maximumUsd: Amount,
        settledUsd: Amount,
        outstandingUsd: Amount,
        outstandingCount: Count,
        final: z.boolean(),
        receiptCount: Count,
      })
      .strict(),
    events: z.array(DiagnosticEventSchema).max(100),
    nextEventCursor: z.number().int().nonnegative().nullable(),
    eventCount: z.number().int().nonnegative(),
    calls: z.array(DiagnosticCallSchema).max(100),
    nextCallCursor: Id.nullable(),
    callCount: z.number().int().nonnegative(),
    limitations: z.array(z.string().max(1000)).max(30),
  })
  .strict();
export const RunDiagnosticsSchema = Content.extend({ contentHash: Hash }).strict();
export type RunDiagnostics = z.infer<typeof RunDiagnosticsSchema>;
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;
export type DiagnosticCall = z.infer<typeof DiagnosticCallSchema>;
export const RunDiagnosticsQuerySchema = z
  .object({
    afterSequence: z.number().int().nonnegative().optional(),
    afterCallId: Id.optional(),
  })
  .strict();
export function sealRunDiagnostics(value: z.input<typeof Content>): RunDiagnostics {
  const content = Content.parse(value);
  return { ...content, contentHash: contentHash(content) };
}
export function verifyRunDiagnostics(
  raw: unknown,
  scope: {
    teamId: string;
    runId: string;
    manifestHash?: string;
    afterSequence?: number;
    afterCallId?: string;
  },
) {
  const value = RunDiagnosticsSchema.parse(raw);
  const { contentHash: hash, ...content } = value;
  if (
    hash !== contentHash(content) ||
    value.teamId !== scope.teamId ||
    value.runId !== scope.runId ||
    (scope.manifestHash && value.manifestHash !== scope.manifestHash)
  )
    throw new Error("Diagnostics differ from the selected workspace, run or retained evidence.");
  if (
    value.events.length > value.eventCount ||
    value.calls.length > value.callCount ||
    new Set(value.events.map((event) => event.id)).size !== value.events.length ||
    value.events.some(
      (event, index) =>
        event.sequence <= (index ? value.events[index - 1]!.sequence : (scope.afterSequence ?? -1)),
    ) ||
    value.calls.some(
      (call, index) => call.id <= (index ? value.calls[index - 1]!.id : (scope.afterCallId ?? "")),
    ) ||
    (value.nextEventCursor !== null && value.nextEventCursor !== value.events.at(-1)?.sequence) ||
    (value.nextCallCursor !== null && value.nextCallCursor !== value.calls.at(-1)?.id) ||
    (value.accounting.final &&
      (value.accounting.outstandingCount !== 0 ||
        value.accounting.settledUsd === null ||
        !value.accounting.receiptCount))
  )
    throw new Error("Diagnostic evidence pagination or final accounting is inconsistent.");
  return value;
}
/** Deliberately excludes prompt, output, arguments, messages and arbitrary metadata. */
export function diagnosticEvent(input: {
  id: string;
  sequence: number;
  at: string | null;
  type: string;
  payload: unknown;
}): DiagnosticEvent {
  const record = (raw: unknown): Record<string, unknown> =>
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const payload = record(input.payload),
    data = record(payload.data);
  const token = (raw: unknown, maximum: number) =>
    typeof raw === "string" && /^[a-zA-Z0-9_.:/-]+$/.test(raw) ? raw.slice(0, maximum) : null;
  return DiagnosticEventSchema.parse({
    id: input.id,
    sequence: input.sequence,
    at: input.at,
    type: input.type.slice(0, 160),
    action: token(payload.action, 160),
    correlationId: token(data.callId ?? data.toolCallId, 500),
    attempt:
      typeof payload.attempt === "number" &&
      Number.isInteger(payload.attempt) &&
      payload.attempt >= 0
        ? payload.attempt
        : null,
    taskId: token(payload.taskId ?? data.taskId, 500),
    status: token(payload.status, 100),
    errorCode: token(payload.errorCode ?? payload.code, 200),
    cleanupComplete:
      typeof payload.complete === "boolean" && input.type === "experiment.harness.cleanup"
        ? payload.complete
        : null,
  });
}
export type DiagnosticSpan = {
  id: string;
  label: string;
  taskId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  status: string;
  evidenceIds: string[];
};
/** Partial pages remain partial; unmatched endings are never invented starts. */
export function diagnosticSpans(events: DiagnosticEvent[]): DiagnosticSpan[] {
  const spans: DiagnosticSpan[] = [],
    active = new Map<string, DiagnosticSpan>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type.startsWith("training.")) {
      spans.push({
        id: event.id,
        label: event.action ?? event.type,
        taskId: event.taskId,
        startedAt: event.at,
        completedAt: null,
        durationMs: null,
        status: "observed",
        evidenceIds: [event.id],
      });
      continue;
    }
    if (!["tool.started", "tool.completed", "tool.failed"].includes(event.type)) continue;
    const key = JSON.stringify([event.correlationId ?? event.action, event.taskId, event.attempt]);
    if (event.type === "tool.started") {
      const span: DiagnosticSpan = {
        id: event.id,
        label: event.action ?? "Operation",
        taskId: event.taskId,
        startedAt: event.at,
        completedAt: null,
        durationMs: null,
        status: "running",
        evidenceIds: [event.id],
      };
      active.set(key, span);
      spans.push(span);
    } else {
      const span = active.get(key);
      if (span) {
        span.completedAt = event.at;
        span.status = event.type === "tool.failed" ? "failed" : "completed";
        span.durationMs =
          span.startedAt && event.at
            ? Math.max(0, Date.parse(event.at) - Date.parse(span.startedAt))
            : null;
        span.evidenceIds.push(event.id);
        active.delete(key);
      } else
        spans.push({
          id: event.id,
          label: event.action ?? "Operation",
          taskId: event.taskId,
          startedAt: null,
          completedAt: event.at,
          durationMs: null,
          status: event.type === "tool.failed" ? "failed" : "completed",
          evidenceIds: [event.id],
        });
    }
  }
  return spans;
}

export function diagnosticAnalysisPrompt(
  value: RunDiagnostics,
  events = value.events,
  calls = value.calls,
) {
  const { contentHash: pageHash, ...metadata } = value;
  return `Investigate this OpenPond run using the retained metadata below. Start read-only. Separate observed facts, hypotheses, missing evidence and recommended investigations. Cite event/call IDs. Do not infer zero costs or successful grading from missing evidence; gateway duration is not pure inference. Do not replay, regrade, edit source, change configuration, restart or deploy without a separate user instruction. Never request credentials or private grader content. This snapshot may be partial.\n\n${JSON.stringify({ ...metadata, sourcePageHash: pageHash, error: diagnosticFailure(value.error), events: events.slice(0, 100), calls: calls.slice(0, 100), analysisCoverage: { eventCount: events.length, callCount: calls.length, maximumIncluded: 100 } }, null, 2)}`;
}

/** Export only a stable technical reason; arbitrary exception text is not model context. */
export function diagnosticFailure(value: string | null | undefined) {
  if (!value) return null;
  const codes = value.match(/\b[a-z][a-z0-9]+(?:_[a-z0-9]+){1,12}\b/g);
  return (
    codes?.slice(0, 6).join(" / ") ||
    "Failure recorded. Inspect the authorized run for its exact message."
  );
}
