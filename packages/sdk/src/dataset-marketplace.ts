import { z } from "zod";

export const CatalogId = z.string().trim().min(1).max(240);
export const CatalogSlug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
export const CatalogReleaseRef = z.object({ id: CatalogId, revision: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const CatalogMetadata = z.object({
  slug: CatalogSlug,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5_000),
  license: z.string().trim().min(1).max(500),
  sourceUrl: z.string().url().max(2000).refine(value => /^https?:\/\//i.test(value), "Use an HTTP or HTTPS source URL.").nullable(),
  attribution: z.string().max(5000),
  category: z.string().trim().min(1).max(100),
}).strict();
export const PublishCatalogDataset = z.object({
  operationId: CatalogId, tasksetId: CatalogId, release: CatalogReleaseRef,
  packageHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedVisibilityRevision: z.number().int().nonnegative(),
  metadata: CatalogMetadata, distributionConsent: z.literal(true),
}).strict();
export const CatalogVisibilityChange = z.object({
  operationId: CatalogId, releaseId: CatalogId, expectedVisibilityRevision: z.number().int().positive(),
  visibility: z.enum(["private", "public"]),
}).strict();
export const AdoptCatalogDataset = z.object({
  operationId: CatalogId, releaseId: CatalogId, release: CatalogReleaseRef,
  packageHash: z.string().regex(/^[a-f0-9]{64}$/), projectId: CatalogId.optional(),
}).strict();
export const CatalogBrowse = z.object({
  search: z.string().max(300).default(""), category: z.string().max(100).default(""),
  publisher: CatalogSlug.optional(), after: z.string().max(3000).optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

const CatalogHash = z.string().regex(/^[a-f0-9]{64}$/);
export const CatalogGraderSchema = z.object({ id: CatalogId, version: z.string().min(1), kind: z.string().min(1), reward: CatalogReleaseRef, readiness: z.string().min(1), runtime: z.string().min(1), assetCount: z.number().int().nonnegative() }).strict();
export const CatalogSummarySchema = z.object({
  id: CatalogId, namespace: CatalogSlug, publisherName: z.string().min(1), metadata: CatalogMetadata,
  release: CatalogReleaseRef, packageHash: CatalogHash, snapshotHash: CatalogHash,
  taskCount: z.number().int().nonnegative(), sizeBytes: z.number().int().nonnegative(), publishedAt: z.string().datetime({ offset: true }),
  buildIntent: z.string().min(1), methodHint: z.string().nullable(), graders: z.array(CatalogGraderSchema),
}).strict();
export const CatalogBrowsePageSchema = z.object({ items: z.array(CatalogSummarySchema).max(100), nextCursor: z.string().max(3000).nullable() }).strict();
export const CatalogDetailSchema = z.object({ summary: CatalogSummarySchema, versions: z.array(CatalogSummarySchema).max(100) }).strict();
export const CatalogVisibilityReceiptSchema = z.object({ operationId: CatalogId, releaseId: CatalogId, visibility: z.enum(["private", "public"]), visibilityRevision: z.number().int().positive(), summary: CatalogSummarySchema }).strict();
export const CatalogAdoptionReceiptSchema = z.object({ operationId: CatalogId, releaseId: CatalogId, teamId: CatalogId, tasksetId: CatalogId, release: CatalogReleaseRef, packageHash: CatalogHash, snapshotHash: CatalogHash, graders: z.array(CatalogGraderSchema), projectId: CatalogId.nullable() }).strict();
export const CatalogPreviewQuerySchema = z.object({ after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(30).default(20) }).strict();
export const CatalogPreviewSchema = z.object({ items: z.array(z.object({ id: CatalogId, split: z.string(), input: z.record(z.string(), z.unknown()), policyVisibleContext: z.record(z.string(), z.unknown()), artifacts: z.array(z.object({ id: CatalogId, path: z.string(), mediaType: z.string(), sizeBytes: z.number().int().nonnegative() }).strict()) }).strict()).max(30), nextCursor: z.number().int().nonnegative().nullable(), total: z.number().int().nonnegative() }).strict();
export const CatalogCheckRequestSchema = z.object({ operationId: CatalogId, tasksetId: CatalogId }).strict();
export const CatalogCheckResultSchema = z.object({ operationId: CatalogId, tasksetId: CatalogId, snapshotHash: CatalogHash, status: z.enum(["passed", "failed", "unavailable"]), fixtures: z.array(z.object({ id: CatalogId, taskId: CatalogId, score: z.number().finite().nullable(), passed: z.boolean(), expectationMatched: z.boolean(), evidenceHash: CatalogHash }).strict()).max(50), providerCalls: z.literal(0), runtime: z.string() }).strict();
export const CatalogRetainedAdoptionSchema = z.object({ receipt: CatalogAdoptionReceiptSchema, check: CatalogCheckResultSchema.nullable() }).strict().nullable();
export const CatalogVisibilityStateSchema = z.object({ publisher: z.object({ namespace: CatalogSlug, teamId: CatalogId, displayName: z.string().min(1) }).strict(), summary: CatalogSummarySchema.nullable(), visibility: z.enum(["private", "public"]), visibilityRevision: z.number().int().nonnegative(), release: CatalogReleaseRef, packageHash: CatalogHash, taskCount: z.number().int().nonnegative(), fileCount: z.number().int().nonnegative(), sizeBytes: z.number().int().nonnegative() }).strict();
export type CatalogSummary = z.infer<typeof CatalogSummarySchema>;
export type CatalogVisibilityReceipt = z.infer<typeof CatalogVisibilityReceiptSchema>;
export type CatalogAdoptionReceipt = z.infer<typeof CatalogAdoptionReceiptSchema>;
export type CatalogCheckResult = z.infer<typeof CatalogCheckResultSchema>;
export interface DatasetMarketplaceClientOptions { baseUrl: string; apiKey?: string; teamId?: string; fetch?: typeof globalThis.fetch }
export class OpenPondDatasetMarketplaceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "OpenPondDatasetMarketplaceError"; }
}
type RequestOptions = { signal?: AbortSignal };
const sameRelease = (a: z.infer<typeof CatalogReleaseRef>, b: z.infer<typeof CatalogReleaseRef>) => a.id === b.id && a.revision === b.revision && a.contentHash === b.contentHash;
/** Public browse operations require no credentials. Workspace mutations always require an explicit authenticated workspace. No method starts model compute. */
export class OpenPondDatasetMarketplaceClient {
  readonly #options: DatasetMarketplaceClientOptions;
  constructor(options: DatasetMarketplaceClientOptions) {
    const url = new URL(options.baseUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Dataset marketplace base URL must be an HTTP(S) endpoint without credentials, query, or fragment.");
    this.#options = { ...options, baseUrl: url.toString().replace(/\/+$/, "") };
  }
  async browse(query: z.input<typeof CatalogBrowse> = {}, options: RequestOptions = {}) {
    const parsed = CatalogBrowse.parse(query), search = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed)) if (value !== undefined) search.set(key, String(value));
    const result = CatalogBrowsePageSchema.parse(await this.#request(`?${search}`, options));
    if (result.items.length > parsed.limit || (parsed.publisher && result.items.some(item => item.namespace !== parsed.publisher))) this.#mismatch();
    return result;
  }
  async get(releaseId: string, options: RequestOptions = {}) {
    const id = CatalogId.parse(releaseId), result = CatalogDetailSchema.parse(await this.#request(`/releases/${encodeURIComponent(id)}`, options));
    if (result.summary.id !== id) this.#mismatch();
    this.#validateVersions(result); return result;
  }
  async lookup(namespace: string, slug: string, revision?: number, options: RequestOptions = {}) {
    const owner = CatalogSlug.parse(namespace), name = CatalogSlug.parse(slug);
    if (revision !== undefined) z.number().int().positive().parse(revision);
    const result = CatalogDetailSchema.parse(await this.#request(`/lookup/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${revision === undefined ? "" : `?revision=${revision}`}`, options));
    if (result.summary.namespace !== owner || result.summary.metadata.slug !== name || (revision !== undefined && result.summary.release.revision !== revision)) this.#mismatch();
    this.#validateVersions(result); return result;
  }
  async preview(releaseId: string, query: z.input<typeof CatalogPreviewQuerySchema> = {}, options: RequestOptions = {}) {
    const id = CatalogId.parse(releaseId), parsed = CatalogPreviewQuerySchema.parse(query);
    const result = CatalogPreviewSchema.parse(await this.#request(`/releases/${encodeURIComponent(id)}/tasks?after=${parsed.after}&limit=${parsed.limit}`, options));
    if (result.items.length > parsed.limit) this.#mismatch(); return result;
  }
  async adopt(input: z.infer<typeof AdoptCatalogDataset>, options: RequestOptions = {}) {
    const request = AdoptCatalogDataset.parse(input), result = CatalogAdoptionReceiptSchema.parse(await this.#request("/adopt", options, request));
    if (result.operationId !== request.operationId || result.releaseId !== request.releaseId || result.teamId !== this.#options.teamId || !sameRelease(result.release, request.release) || result.packageHash !== request.packageHash || result.projectId !== (request.projectId ?? null)) this.#mismatch();
    return result;
  }
  async publish(input: z.infer<typeof PublishCatalogDataset>, options: RequestOptions = {}) {
    const request = PublishCatalogDataset.parse(input), result = CatalogVisibilityReceiptSchema.parse(await this.#request("/publish", options, request));
    if (result.operationId !== request.operationId || result.releaseId !== result.summary.id || !sameRelease(result.summary.release, request.release) || result.summary.packageHash !== request.packageHash || result.visibility !== "public") this.#mismatch(); return result;
  }
  async changeVisibility(input: z.infer<typeof CatalogVisibilityChange>, options: RequestOptions = {}) {
    const request = CatalogVisibilityChange.parse(input), result = CatalogVisibilityReceiptSchema.parse(await this.#request("/visibility", options, request));
    if (result.operationId !== request.operationId || result.releaseId !== request.releaseId || result.summary.id !== request.releaseId || result.visibility !== request.visibility) this.#mismatch(); return result;
  }
  async visibility(tasksetId: string, options: RequestOptions = {}) {
    const result = CatalogVisibilityStateSchema.parse(await this.#request(`/visibility/${encodeURIComponent(CatalogId.parse(tasksetId))}`, options, undefined, true));
    if (result.publisher.teamId !== this.#options.teamId) this.#mismatch(); return result;
  }
  async checks(operationId: string, tasksetId: string, options: RequestOptions = {}) {
    const request = CatalogCheckRequestSchema.parse({ operationId, tasksetId }), result = CatalogCheckResultSchema.parse(await this.#request("/checks", options, request));
    if (result.operationId !== request.operationId || result.tasksetId !== request.tasksetId) this.#mismatch(); return result;
  }
  async retained(tasksetId: string, options: RequestOptions = {}) {
    const id = CatalogId.parse(tasksetId), result = CatalogRetainedAdoptionSchema.parse(await this.#request(`/adoptions/${encodeURIComponent(id)}`, options, undefined, true));
    if (result && (result.receipt.tasksetId !== id || result.receipt.teamId !== this.#options.teamId || (result.check && (result.check.tasksetId !== id || result.check.snapshotHash !== result.receipt.snapshotHash)))) this.#mismatch(); return result;
  }
  #validateVersions(result: z.infer<typeof CatalogDetailSchema>) {
    if (result.versions.some(item => item.namespace !== result.summary.namespace || item.metadata.slug !== result.summary.metadata.slug)) this.#mismatch();
  }
  #mismatch(): never { throw new OpenPondDatasetMarketplaceError(502, "dataset_catalog_identity_mismatch", "Dataset marketplace response did not match the requested identity or scope."); }
  async #request(path: string, options: RequestOptions, body?: unknown, authenticated = false): Promise<unknown> {
    const auth = authenticated || body !== undefined;
    if (auth && (!this.#options.apiKey?.trim() || !this.#options.teamId?.trim())) throw new Error("An API key and explicit workspace are required for this dataset marketplace operation.");
    const response = await (this.#options.fetch ?? globalThis.fetch)(`${this.#options.baseUrl}/v1/dataset-marketplace${path}`, {
      method: body === undefined ? "GET" : "POST", signal: options.signal, redirect: "error",
      headers: { Accept: "application/json", ...(auth ? { Authorization: `Bearer ${this.#options.apiKey}`, "X-OpenPond-Team-Id": this.#options.teamId! } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new OpenPondDatasetMarketplaceError(response.status, "empty_response", "Dataset marketplace response was empty.");
    const decoder = new TextDecoder(); let bytes = 0, text = "";
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 4_194_304) throw new OpenPondDatasetMarketplaceError(response.status, "response_too_large", "Dataset marketplace response exceeded 4 MiB."); text += decoder.decode(chunk.value, { stream: true }); } text += decoder.decode(); }
    finally { await reader.cancel(); reader.releaseLock(); }
    let payload: unknown; try { payload = JSON.parse(text); } catch { throw new OpenPondDatasetMarketplaceError(response.status, "invalid_response", "Dataset marketplace response was not valid JSON."); }
    if (!response.ok) { const error = z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().safeParse(payload); throw new OpenPondDatasetMarketplaceError(response.status, error.success ? error.data.code : "invalid_error_response", error.success ? error.data.message : `Dataset marketplace request failed (${response.status}).`); }
    return payload;
  }
}
