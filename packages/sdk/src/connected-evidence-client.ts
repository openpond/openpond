import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { ConnectedBoundarySchema, ConnectedEventSchema, ConnectedUsageSummarySchema } from "@openpond/evals/connected-evidence";
import { ConnectedCaptureRequestSchema, ConnectedCaseRefSchema, ConnectedSourceSummarySchema,
  AgentImportUploadPartSchema, AgentImportPreviewRequestSchema, AgentImportCommitRequestSchema } from "./connected-evidence-contracts.js";
import { ConnectedRecordedExecutionRequestSchema, ConnectedRecordedListSchema, ConnectedRecordedListRequestSchema, verifyConnectedRecordedExecution } from "./connected-recorded-execution.js";
import { ConnectedDatasetPublicationSchema, type ConnectedDatasetPublication } from "./connected-dataset-publication.js";
import { DatasetWorkspaceReceiptSchema } from "./dataset-workspace-contracts.js";
import { fetchConnectedJson } from "./connected-evidence-http.js";

const Id = z.string().min(1).max(500), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ConnectedCollectionSchema = z.object({ teamId: Id, projectId: Id.nullable(), status: z.enum(["active", "paused", "archived"]), revision: z.number().int().nonnegative() }).strict();
export const ConnectedCaptureReceiptSchema = z.object({ teamId: Id, operationId: Id, projectId: Id.nullable(),
  outcomes: z.array(z.object({ conversationId: Id, state: z.enum(["captured", "unchanged", "pending", "paused", "excluded", "failed"]),
    sourceId: Id.optional(), snapshotHash: Hash.optional(), reason: z.string().optional() }).strict()).max(50), nextCursor: Id.nullable() }).strict();
export const ConnectedCaseReadbackSchema = z.object({ teamId: Id, ref: ConnectedCaseRefSchema, origin: ConnectedSourceSummarySchema.shape.source,
  sessionId: Id, projectId: Id, capturedAt: z.string().datetime(), unmappedEvidence: z.object({ count: z.number().int().nonnegative().max(100_000), contentHash: Hash }).strict(),
  evidence: z.object({ input: z.array(ConnectedEventSchema), observed: z.array(ConnectedEventSchema), answer: z.json(), boundary: ConnectedBoundarySchema }).strict() }).strict();
export const ConnectedUnmappedEventsSchema = z.object({ teamId: Id, sourceId: Id, snapshotHash: Hash, contentHash: Hash,
  count: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), events: z.array(ConnectedEventSchema).max(50), nextOffset: z.number().int().nonnegative().nullable() }).strict();
export const AgentImportPreviewSchema = z.object({ teamId: Id, source: AgentImportPreviewRequestSchema.shape.source, sourceHash: Hash, previewHash: Hash,
  destination: AgentImportPreviewRequestSchema.shape.destination, issues: z.array(z.object({ file: z.string(), message: z.string() }).strict()).max(100),
  sessions: z.array(z.object({ sessionHash: Hash, sessionId: Id, origin: ConnectedSourceSummarySchema.shape.source, exporterVersion: z.string().nullable(),
    eventCount: z.number().int().nonnegative(), boundaries: z.array(z.object({ id: Id, projection: z.enum(["turn", "conversation"]), answer: z.boolean(),
      process: z.enum(["retained", "partial", "absent"]), terminal: z.enum(["completed", "failed", "cancelled", "unknown"]) }).strict()).max(5_001),
    warnings: z.array(z.string()).max(100), sample: z.array(z.object({ role: z.enum(["user", "assistant", "system", "tool"]).nullable(), text: z.string().max(4_000) }).strict()).max(3),
  }).strict()).max(1_000) }).strict();
export const AgentImportReceiptSchema = z.object({ teamId: Id, operationId: Id, requestHash: Hash, previewHash: Hash, projectId: Id.optional(),
  state: z.enum(["admitting", "publishing", "completed", "failed"]), outcomes: z.array(z.object({ sessionHash: Hash, sourceId: Id,
    status: z.enum(["imported", "already_present"]), datasets: z.array(z.object({ datasetId: Id, revision: z.number().int().positive(), changed: z.boolean() }).strict()).max(2) }).strict()).max(1_000),
  error: z.string().optional() }).strict();

export class ConnectedEvidenceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "ConnectedEvidenceError"; }
}
export class ConnectedEvidenceClient {
  private readonly baseUrl: string;
  constructor(private readonly options: { apiKey: string; baseUrl: string; teamId: string; fetch?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey.trim() || !options.teamId.trim())
      throw new Error("A clean API origin and workspace credentials are required.");
    this.baseUrl = url.toString().replace(/\/+$/, "");
  }
  async capture(raw: z.input<typeof ConnectedCaptureRequestSchema>, signal?: AbortSignal) {
    const request = ConnectedCaptureRequestSchema.parse(raw), result = ConnectedCaptureReceiptSchema.parse(await this.request("/capture", "POST", request, signal));
    this.scope(result.teamId);
    if (result.operationId !== request.operationId || result.outcomes.length > request.limit || request.conversationId && result.outcomes.some(item => item.conversationId !== request.conversationId))
      throw new Error("Capture receipt differs from its requested source or operation.");
    return result;
  }
  async list(input: { projectId?: string; cursor?: string; limit?: number } = {}, signal?: AbortSignal) {
    const query = z.object({ projectId: Id.optional(), cursor: Id.optional(), limit: z.number().int().min(1).max(50).default(20) }).strict().parse(input);
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    const page = z.object({ teamId: Id, items: z.array(ConnectedSourceSummarySchema).max(50), nextCursor: Id.nullable() }).strict().parse(await this.request(`?${params}`, "GET", undefined, signal));
    this.scope(page.teamId);
    if (page.items.length > query.limit || new Set(page.items.map(item => item.sourceId)).size !== page.items.length || page.nextCursor !== null && page.nextCursor === query.cursor
      || query.projectId && page.items.some(item => item.projectId !== query.projectId)) throw new Error("Connected source page differs from its requested scope.");
    return page;
  }
  async read(raw: z.input<typeof ConnectedCaseRefSchema>, signal?: AbortSignal) {
    const ref = ConnectedCaseRefSchema.parse(raw);
    const result = ConnectedCaseReadbackSchema.parse(await this.request(`/${encodeURIComponent(ref.id)}/cases/${encodeURIComponent(ref.boundaryId)}?snapshotHash=${ref.snapshotHash}&revisionHash=${ref.boundaryRevisionHash}`, "GET", undefined, signal));
    this.scope(result.teamId);
    if (contentHash(result.ref) !== contentHash(ref) || result.evidence.boundary.id !== ref.boundaryId || result.evidence.boundary.revisionHash !== ref.boundaryRevisionHash
      || contentHash(result.evidence.input) !== result.evidence.boundary.inputHash || contentHash(result.evidence.observed) !== ref.boundaryRevisionHash
      || result.evidence.boundary.outputHash !== null && contentHash(result.evidence.answer) !== result.evidence.boundary.outputHash)
      throw new Error("Connected case readback differs from its exact snapshot or cutoff.");
    return result;
  }
  async setCollection(paused: boolean, signal?: AbortSignal) {
    const result = ConnectedCollectionSchema.parse(await this.request("/collection", "PUT", z.object({ paused: z.boolean() }).strict().parse({ paused }), signal));
    this.scope(result.teamId); return result;
  }
  async collection(signal?: AbortSignal) { const result = ConnectedCollectionSchema.parse(await this.request("/collection", "GET", undefined, signal)); this.scope(result.teamId); return result; }
  async unmappedEvents(input: { id: string; snapshotHash: string; contentHash: string; offset?: number; limit?: number }, signal?: AbortSignal) {
    const request = z.object({ id: Id, snapshotHash: Hash, contentHash: Hash, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) }).strict().parse(input);
    const result = ConnectedUnmappedEventsSchema.parse(await this.request(`/${encodeURIComponent(request.id)}/unmapped-events?snapshotHash=${request.snapshotHash}&offset=${request.offset}&limit=${request.limit}`, "GET", undefined, signal));
    this.scope(result.teamId);
    if (result.sourceId !== request.id || result.snapshotHash !== request.snapshotHash || result.contentHash !== request.contentHash || result.offset !== request.offset
      || result.events.length > request.limit || result.events.some((event, index) => event.sequence !== request.offset + index)
      || result.nextOffset !== null && result.nextOffset !== request.offset + result.events.length) throw new Error("Unmapped source event page differs from its pinned snapshot.");
    return result;
  }
  async homeSummary(raw: { from: string; to: string; projectId?: string }, signal?: AbortSignal) {
    const querySchema = z.object({ from: z.string().datetime(), to: z.string().datetime(), projectId: Id.optional() }).strict(), query = querySchema.parse(raw);
    const params = new URLSearchParams(Object.entries(query));
    const result = z.object({ teamId: Id, range: querySchema, activity: z.object({ conversations: z.number().int().nonnegative(), turns: z.number().int().nonnegative(),
      chatTurns: z.number().int().nonnegative(), workTurns: z.number().int().nonnegative() }).strict(), accounting: z.object({ contextSnapshots: z.number().int().nonnegative() }).strict(), usage: ConnectedUsageSummarySchema }).strict()
      .parse(await this.request(`/summary?${params}`, "GET", undefined, signal));
    this.scope(result.teamId);
    if (contentHash(result.range) !== contentHash(query) || result.activity.chatTurns + result.activity.workTurns !== result.activity.turns) throw new Error("Activity summary differs from its requested range.");
    for (const groups of [result.usage.days, result.usage.modes, result.usage.models]) {
      if (new Set(groups.map(row => row.key)).size !== groups.length) throw new Error("Duplicate usage summary group.");
      for (const key of Object.keys(result.usage.total) as (keyof typeof result.usage.total)[])
        if (groups.reduce((sum, row) => sum + row[key], 0) !== result.usage.total[key]) throw new Error("Usage totals differ from their displayed groups.");
    }
    return result;
  }
  async uploadPart(raw: z.input<typeof AgentImportUploadPartSchema>, signal?: AbortSignal) {
    const body = AgentImportUploadPartSchema.parse(raw), result = z.object({ teamId: Id, hash: Hash, parts: z.number().int(), index: z.number().int() }).strict().parse(await this.request("/imports/upload", "POST", body, signal));
    this.scope(result.teamId);
    if (result.hash !== body.hash || result.parts !== body.parts || result.index !== body.index) throw new Error("Upload receipt differs from its part identity.");
    return result;
  }
  async preview(raw: z.input<typeof AgentImportPreviewRequestSchema>, signal?: AbortSignal) {
    const request = AgentImportPreviewRequestSchema.parse(raw), result = AgentImportPreviewSchema.parse(await this.request("/imports/preview", "POST", request, signal));
    this.scope(result.teamId);
    if (result.source !== request.source || contentHash(result.destination) !== contentHash(request.destination) || result.sessions.some(session => session.origin !== request.source)
      || new Set(result.sessions.map(session => session.sessionHash)).size !== result.sessions.length) throw new Error("Import preview differs from its source or destination.");
    return result;
  }
  async commit(raw: z.input<typeof AgentImportCommitRequestSchema>, signal?: AbortSignal) {
    const request = AgentImportCommitRequestSchema.parse(raw), result = AgentImportReceiptSchema.parse(await this.request("/imports/commit", "POST", request, signal));
    this.scope(result.teamId);
    if (result.operationId !== request.operationId || result.previewHash !== request.previewHash || result.requestHash !== contentHash(request)
      || result.outcomes.some(item => !request.selection.some(selection => selection.sessionHash === item.sessionHash))
      || result.state === "completed" && result.outcomes.length !== request.selection.length) throw new Error("Import receipt differs from its exact selection or operation.");
    return result;
  }
  async readImport(operationId: string, signal?: AbortSignal) {
    const id = Id.parse(operationId), result = AgentImportReceiptSchema.parse(await this.request(`/imports/${encodeURIComponent(id)}`, "GET", undefined, signal));
    this.scope(result.teamId); if (result.operationId !== id) throw new Error("Import identity mismatch."); return result;
  }
  async prepareRecorded(raw: z.input<typeof ConnectedRecordedExecutionRequestSchema>, signal?: AbortSignal) {
    const request = ConnectedRecordedExecutionRequestSchema.parse(raw), result = verifyConnectedRecordedExecution(await this.request("/recorded-executions", "POST", request, signal));
    this.scope(result.teamId); if (contentHash(result.request) !== contentHash(request)) throw new Error("Recorded admission differs from its selected Dataset/cases."); return result;
  }
  async listRecordedExecutions(input: z.input<typeof ConnectedRecordedListRequestSchema> = {}, signal?: AbortSignal) {
    const query = ConnectedRecordedListRequestSchema.parse(input);
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    const page = ConnectedRecordedListSchema.parse(await this.request(`/recorded-executions?${params}`, "GET", undefined, signal));
    this.scope(page.teamId);
    if (page.items.length > query.limit || page.items.some((row, index) => row.teamId !== page.teamId || query.projectId && row.projectId !== query.projectId
      || query.cursor && row.id <= query.cursor || index > 0 && row.id <= page.items[index - 1]!.id)
      || page.items.some(row => row.ownerUserId !== page.items[0]?.ownerUserId)
      || page.nextCursor !== null && (query.cursor !== undefined && page.nextCursor <= query.cursor || page.items.length > 0 && page.nextCursor < page.items.at(-1)!.id))
      throw new Error("Recorded execution page differs from its requested scope or cursor.");
    return page;
  }
  async recordedExecution(id: string, signal?: AbortSignal) {
    const result = verifyConnectedRecordedExecution(await this.request(`/recorded-executions/${encodeURIComponent(Id.parse(id))}`, "GET", undefined, signal));
    this.scope(result.teamId); if (result.id !== id) throw new Error("Recorded execution identity mismatch."); return result;
  }
  async publishDataset(input: ConnectedDatasetPublication, signal?: AbortSignal) {
    const request = ConnectedDatasetPublicationSchema.parse(input);
    const result = DatasetWorkspaceReceiptSchema.parse(await this.request("/datasets/publish", "POST", request, signal));
    this.scope(result.teamId);
    const frozen = result.workspace.draft.metadata.connectedPublication;
    if (result.datasetId !== request.datasetId || !result.publication || !frozen || typeof frozen !== "object" || !("requestHash" in frozen) || frozen.requestHash !== contentHash(request)) throw new Error("Published Dataset identity or original selection mismatch."); return result;
  }
  async createSelection(input: { operationId: string; projectId: string; name: string; cases: z.input<typeof ConnectedCaseRefSchema>[] }, signal?: AbortSignal) {
    const request = z.object({ operationId: Id.max(240), projectId: Id.max(240), name: z.string().trim().min(1).max(200), cases: z.array(ConnectedCaseRefSchema).min(1).max(500) }).strict().parse(input);
    const result = DatasetWorkspaceReceiptSchema.parse(await this.request("/datasets/selection", "POST", request, signal));
    this.scope(result.teamId);
    if (result.originProjectId !== request.projectId || result.workspace.draft.tasks.length !== request.cases.length
      || result.workspace.draft.tasks.some((task, index) => contentHash(task.input && typeof task.input === "object" && !Array.isArray(task.input) ? task.input.connectedEvidenceRef : null) !== contentHash(request.cases[index])))
      throw new Error("Selected Dataset differs from its exact source population.");
    return result;
  }
  private scope(teamId: string) { if (teamId !== this.options.teamId) throw new Error("Connected evidence workspace mismatch."); }
  private async request(path: string, method: string, body?: unknown, signal?: AbortSignal) {
    const { response, value } = await fetchConnectedJson(this.options.fetch ?? fetch, `${this.baseUrl}/v1/connected-evidence${path}`, { method, signal, redirect: "error",
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "X-OpenPond-Team-Id": this.options.teamId, "Content-Type": "application/json", Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, (status, code, message) => new ConnectedEvidenceError(status, code, message));
    if (!response.ok) { const error = z.object({ code: z.string(), message: z.string() }).safeParse(value);
      throw new ConnectedEvidenceError(response.status, error.success ? error.data.code : "connected_request_failed", error.success ? error.data.message : "Connected evidence request failed."); }
    return value;
  }
}
