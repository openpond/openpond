import { z } from "zod";
import { contentHash } from "@openpond/harness";

export const CONNECTED_EVIDENCE_VERSION = "openpond.connectedEvidence.v1" as const;
export const CONNECTED_NORMALIZER_VERSION = "connected-evidence-1" as const;
export const CONNECTED_EVIDENCE_LIMITS = { files: 100, sourceBytes: 32 * 1024 * 1024, decodedBytes: 64 * 1024 * 1024,
  lineBytes: 2 * 1024 * 1024, events: 100_000, sessions: 1_000, boundaries: 5_000, evaluatorBytes: 2 * 1024 * 1024 } as const;
const Id = z.string().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Time = z.string().datetime().nullable();
const Tokens = z.number().int().nonnegative().nullable();
export const ConnectedSourceKindSchema = z.enum(["native_chat", "native_work", "codex", "claude_code", "hermes", "openclaw", "opencode", "grok_build", "pi", "oh_my_pi"]);
export const ConnectedUsageSchema = z.object({
  invocationId: Id, inputTokens: Tokens, outputTokens: Tokens, cachedInputTokens: Tokens,
  totalTokens: Tokens, provenance: z.enum(["billed_invocation", "reported_invocation", "reported_cumulative"]),
}).strict();
export const ConnectedEventSchema = z.object({
  id: Id, sequence: z.number().int().nonnegative(), occurredAt: Time,
  kind: z.enum(["message", "tool_call", "tool_result", "compaction", "artifact", "terminal", "usage", "unknown"]),
  role: z.enum(["user", "assistant", "system", "tool"]).nullable(),
  callId: Id.nullable(), parentId: Id.nullable(), content: z.json(),
  usage: ConnectedUsageSchema.nullable(),
}).strict();
export const ConnectedBoundarySchema = z.object({
  id: Id, familyKey: Id, projection: z.enum(["turn", "conversation"]),
  requestEventId: Id, start: z.number().int().nonnegative(), end: z.number().int().positive(),
  inputHash: Hash, outputHash: Hash.nullable(), revisionHash: Hash,
  terminal: z.enum(["completed", "failed", "cancelled", "unknown"]),
  coverage: z.object({ answer: z.boolean(), context: z.enum(["retained", "compacted", "unknown"]),
    process: z.enum(["retained", "partial", "absent"]), artifacts: z.enum(["retained", "references_only", "absent"]),
    replay: z.literal("unavailable"), gaps: z.array(z.string().max(500)).max(100) }).strict(),
}).strict();
export const ConnectedSessionSchema = z.object({
  schemaVersion: z.literal(CONNECTED_EVIDENCE_VERSION), normalizerVersion: z.literal(CONNECTED_NORMALIZER_VERSION),
  origin: ConnectedSourceKindSchema, sessionId: Id, branchId: Id.nullable(), parentSessionId: Id.nullable(),
  exporterVersion: z.string().max(200).nullable(),
  acquisition: z.object({ machineId: Id, sourceInstanceId: Id }).strict().optional(),
  sourceFiles: z.array(z.object({ path: Id, contentHash: Hash, sizeBytes: z.number().int().nonnegative() }).strict()).max(CONNECTED_EVIDENCE_LIMITS.files),
  events: z.array(ConnectedEventSchema).max(CONNECTED_EVIDENCE_LIMITS.events),
  unmappedEvents: z.array(ConnectedEventSchema).max(CONNECTED_EVIDENCE_LIMITS.events),
  boundaries: z.array(ConnectedBoundarySchema).max(CONNECTED_EVIDENCE_LIMITS.boundaries),
  warnings: z.array(z.string().max(500)).max(100), contentHash: Hash,
}).strict();
export type ConnectedEvent = z.infer<typeof ConnectedEventSchema>;
export type ConnectedSession = z.infer<typeof ConnectedSessionSchema>;
export type ConnectedBoundary = z.infer<typeof ConnectedBoundarySchema>;
export type ConnectedSourceKind = z.infer<typeof ConnectedSourceKindSchema>;
export type ConnectedUsage = z.infer<typeof ConnectedUsageSchema>;
export type ConnectedFile = { path: string; text: string };
export function hasRecordedConnectedAnswer(event: ConnectedEvent) {
  if (event.kind !== "message" || event.role !== "assistant" || event.content === null) return false;
  if (typeof event.content === "string") return event.content.trim().length > 0;
  if (Array.isArray(event.content)) return event.content.length > 0;
  return typeof event.content !== "object" || !("text" in event.content) || typeof event.content.text === "string" && event.content.text.trim().length > 0;
}

/** Shared integrity verification for metadata and evaluator evidence. */
function verifiedConnectedBoundary(sessionValue: unknown, boundaryId: string) {
  const session = ConnectedSessionSchema.parse(sessionValue);
  const { contentHash: actual, ...body } = session;
  if (contentHash(body) !== actual) throw new Error("connected_evidence_hash_mismatch");
  const boundary = session.boundaries.find(item => item.id === boundaryId);
  if (!boundary) throw new Error("connected_boundary_missing");
  const input = session.events.slice(0, boundary.start + 1);
  const observed = session.events.slice(boundary.start + 1, boundary.end);
  if (contentHash(input) !== boundary.inputHash || contentHash(observed) !== boundary.revisionHash)
    throw new Error("connected_boundary_hash_mismatch");
  const answers = observed.filter(hasRecordedConnectedAnswer);
  const answer = boundary.projection === "conversation" ? answers.map(event => event.content) : answers.at(-1)?.content ?? null;
  if ((answers.length ? contentHash(answer) : null) !== boundary.outputHash) throw new Error("connected_output_hash_mismatch");
  return { input, observed, answer, boundary };
}
/** Status/discovery returns no evaluator payload. Large retained histories still
 * require the exact session, input, observed-output and answer hashes to match. */
export function resolveConnectedBoundaryMetadata(sessionValue: unknown, boundaryId: string): ConnectedBoundary {
  return verifiedConnectedBoundary(sessionValue, boundaryId).boundary;
}
/** Bytes stay in one immutable snapshot; cases retain cutoffs, not copied history. */
export function resolveConnectedBoundary(sessionValue: unknown, boundaryId: string) {
  const value = verifiedConnectedBoundary(sessionValue, boundaryId);
  if (new TextEncoder().encode(JSON.stringify(value)).length > CONNECTED_EVIDENCE_LIMITS.evaluatorBytes)
    throw new Error("connected_evaluator_context_too_large");
  return value;
}
