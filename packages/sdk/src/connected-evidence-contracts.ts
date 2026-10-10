import { z } from "zod";
import { ConnectedSourceKindSchema, ConnectedBoundarySchema, ConnectedUsageSummarySchema, CONNECTED_EVIDENCE_LIMITS } from "@openpond/evals/connected-evidence";

const Id = z.string().trim().min(1).max(500), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ConnectedScopeSchema = z.object({ teamId: Id, ownerUserId: Id }).strict();
export const ConnectedCaseRefSchema = z.object({ id: Id, snapshotHash: Hash, boundaryId: Id, boundaryRevisionHash: Hash }).strict();
export type ConnectedCaseRef = z.infer<typeof ConnectedCaseRefSchema>;
export const ConnectedSourceSummarySchema = z.object({ sourceId: Id, source: ConnectedSourceKindSchema, sessionId: Id,
  snapshotHash: Hash, title: z.string().max(500), projectId: Id.nullable(), capturedAt: z.string().datetime(),
  boundaries: z.array(ConnectedBoundarySchema.omit({ start: true, end: true })).max(CONNECTED_EVIDENCE_LIMITS.boundaries) }).strict();
export const ConnectedCaptureRequestSchema = z.object({ operationId: Id, conversationId: Id.optional(),
  cursor: Id.optional(), limit: z.number().int().min(1).max(50).default(20) }).strict();
export const AgentImportUploadRefSchema = z.object({ hash: Hash, parts: z.number().int().min(1).max(1_500) }).strict();
export const AgentImportUploadPartSchema = AgentImportUploadRefSchema.extend({ index: z.number().int().nonnegative().max(1_499), base64: z.string().max(350_000) }).strict();
export const AgentImportFileSchema = z.object({ path: z.string().min(1).max(500), encoding: z.enum(["utf8", "zstd"]), base64: z.string() }).strict();
export const AgentImportPreviewRequestSchema = z.object({ upload: AgentImportUploadRefSchema,
  source: z.enum(["codex", "claude_code", "hermes", "openclaw", "opencode", "grok_build", "pi", "oh_my_pi"]), branchLeafId: Id.optional(), acquisition: z.object({ machineId: Id, sourceInstanceId: Id }).strict().optional(),
  destination: z.discriminatedUnion("kind", [z.object({ kind: z.literal("existing"), projectId: Id }).strict(),
    z.object({ kind: z.literal("new"), name: z.string().trim().min(1).max(200) }).strict()]) }).strict();
export const AgentImportCommitRequestSchema = AgentImportPreviewRequestSchema.extend({ operationId: Id, previewHash: Hash,
  selection: z.array(z.object({ sessionHash: Hash, boundaryIds: z.array(Id).min(1).max(CONNECTED_EVIDENCE_LIMITS.boundaries) }).strict()).min(1).max(CONNECTED_EVIDENCE_LIMITS.sessions) }).strict();
export const ConnectedHomeQuerySchema = z.object({ from: z.string().datetime(), to: z.string().datetime(), projectId: Id.optional() }).strict();
export const ConnectedHomeSummarySchema = z.object({ teamId: Id, range: ConnectedHomeQuerySchema,
  activity: z.object({ conversations: z.number().int().nonnegative(), turns: z.number().int().nonnegative(), chatTurns: z.number().int().nonnegative(), workTurns: z.number().int().nonnegative() }).strict(),
  accounting: z.object({ contextSnapshots: z.number().int().nonnegative() }).strict(), usage: ConnectedUsageSummarySchema }).strict();
