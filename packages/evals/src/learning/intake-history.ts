import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { assertBoundedTaskJson } from "../task-schema.js";
import { LearningJsonObjectSchema } from "./contracts.js";
import { intakeDate, intakeId, TASK_INTAKE_LIMITS, TaskIntakeRecordSchema, type TaskIntakeFile, type TaskIntakeRecord } from "./intake-contracts.js";
import { structuredIntakeText } from "./intake-text.js";

const messageSchema = z.object({ role: z.string().min(1), content: z.json().nullable().optional() }).catchall(z.json());
const hermesSchema = z.object({ id: z.string().min(1), messages: z.array(messageSchema).min(1).max(TASK_INTAKE_LIMITS.messages),
  lineage_session_ids: z.array(z.string()).optional(), parent_session_id: z.string().nullable().optional() }).catchall(z.json());
type Message = z.infer<typeof messageSchema>;

export function parseHermesSession(value: unknown): TaskIntakeRecord[] {
  const session = hermesSchema.parse(value);
  const family = session.lineage_session_ids?.[0] ?? session.parent_session_id ?? session.id;
  const { messages: _messages, segments: _segments, ...metadata } = session;
  return historyRecords("hermes", session.id, family, session.messages, {
    sourceHash: contentHash(value), metadata: { session: metadata },
    warnings: ["Imported session context and tools need review before this can become an executable task."],
  });
}

const manifestSchema = z.object({ traceSchema: z.literal("openclaw-trajectory"), schemaVersion: z.literal(1),
  traceId: z.string().min(1), sessionId: z.string().min(1), leafId: z.string().nullable(),
  eventCount: z.number().int().nonnegative(), warnings: z.array(LearningJsonObjectSchema).optional() }).catchall(z.json());
const eventSchema = z.object({ traceSchema: z.literal("openclaw-trajectory"), schemaVersion: z.literal(1),
  traceId: z.string(), sessionId: z.string(), seq: z.number().int().nonnegative(), type: z.string(), ts: z.string() }).catchall(z.json());
const branchSchema = z.object({ header: LearningJsonObjectSchema.nullable(), leafId: z.string().nullable(),
  entries: z.array(z.object({ id: z.string().min(1), type: z.string().min(1), parentId: z.string().nullable().optional(),
    message: messageSchema.optional() }).catchall(z.json())).max(TASK_INTAKE_LIMITS.messages) }).strict();

/** Takes named bundle files; never extracts paths or runs uploaded code. */
export function parseOpenClawBundle(files: TaskIntakeFile[]): TaskIntakeRecord[] {
  const read = (path: string) => {
    const file = files.find(file => file.path === path);
    if (!file) throw new Error(`OpenClaw bundle is missing ${path}.`);
    return structuredIntakeText(file.text);
  };
  const manifest = manifestSchema.parse(JSON.parse(read("manifest.json")));
  const branch = branchSchema.parse(JSON.parse(read("session-branch.json")));
  if (branch.leafId !== manifest.leafId) throw new Error("OpenClaw manifest and session branch identify different leaves.");
  const events = read("events.jsonl").split(/\r?\n/u).filter(line => line.trim()).map(line => eventSchema.parse(JSON.parse(line)));
  if (events.length !== manifest.eventCount || events.some(event => event.traceId !== manifest.traceId || event.sessionId !== manifest.sessionId)) throw new Error("OpenClaw events do not match the manifest identity or count.");
  if (branch.header && branch.header.id !== manifest.sessionId) throw new Error("OpenClaw session header does not match the manifest.");
  const ids = new Set<string>();
  for (const [index, entry] of branch.entries.entries()) {
    if (ids.has(entry.id)) throw new Error("OpenClaw branch contains duplicate entry IDs.");
    if (index && entry.parentId !== branch.entries[index - 1]!.id) throw new Error("OpenClaw branch is incomplete or out of order.");
    ids.add(entry.id);
  }
  if (branch.entries.length && branch.entries.at(-1)!.id !== branch.leafId) throw new Error("OpenClaw branch does not reach its declared leaf.");
  const messages = branch.entries.filter(entry => entry.type === "message" && entry.message).map(entry => ({ ...entry.message!, entryId: entry.id,
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : typeof entry.message!.timestamp === "number" ? new Date(entry.message!.timestamp).toISOString() : null }));
  return historyRecords("openclaw", manifest.sessionId, manifest.sessionId, messages, {
    sourceHash: contentHash(files), metadata: { manifest, sourceFiles: files.map(file => file.path) },
    warnings: ["Imported trajectory context and tools need review before this can become an executable task.",
      ...(manifest.warnings ?? []).map(warning => typeof warning.message === "string" ? warning.message.slice(0, 2_000) : "The source exporter reported incomplete context.")],
  });
}

function historyRecords(format: "hermes" | "openclaw", sessionId: string, family: string, messages: Message[], source: {
  sourceHash: string; metadata: Record<string, unknown>; warnings: string[];
}): TaskIntakeRecord[] {
  const starts = messages.flatMap((message, index) => message.role === "user" ? [index] : []);
  if (!starts.length) throw new Error("This history contains no user request. Supply a session with its request context.");
  let normalizedBytes = 0;
  return starts.map((start, position) => {
    const end = starts[position + 1] ?? messages.length;
    const responses = messages.slice(start + 1, end);
    const assistant = responses.filter(message => message.role === "assistant").at(-1);
    const request = messages[start]!;
    const identity = request.entryId ?? request.message_id ?? request.id ?? contentHash({ start, request });
    const record = {
      id: intakeId(format, [sessionId, identity]), familyKey: intakeId(format, family), split: "train", kind: "attempt",
      input: { request: request.content ?? null, messages: messages.slice(0, start + 1) },
      observedOutput: assistant ? { response: assistant.content ?? null, messages: responses } : null, expected: null,
      sourceId: `${format}:${sessionId}:${String(identity)}`, sourceHash: source.sourceHash,
      occurredAt: intakeDate(assistant?.timestamp ?? request.timestamp), metadata: source.metadata,
      warnings: [...source.warnings, ...(!assistant ? ["No assistant response was recorded for this request."] : [])], needsContext: true,
    };
    assertBoundedTaskJson(record);
    normalizedBytes += new TextEncoder().encode(JSON.stringify(record)).length;
    if (normalizedBytes > TASK_INTAKE_LIMITS.bytes) throw new Error("Expanded history exceeds the 5 MiB preview limit. Export a smaller session selection.");
    return TaskIntakeRecordSchema.parse(record);
  });
}
