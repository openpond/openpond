import { DatasetWorkspaceListQuerySchema, DatasetWorkspaceBeginVersionSchema, DatasetWorkspaceVersionsSchema, DatasetWorkspaceListSchema, DatasetWorkspacePublishSchema, DatasetWorkspaceReceiptSchema, DatasetWorkspaceValidationSchema, DatasetWorkspaceWriteSchema } from "./dataset-workspace-contracts.js";
import { validateTasksetDraftWorkspace } from "./taskset-draft-workspace.js";
import type { z } from "zod";
import { DatasetWorkspaceOperationKindSchema, DatasetWorkspaceOperationResultSchema } from "./dataset-workspace-operations.js";
import { OpenPondDatasetPreparationClient } from "./dataset-preparation-client.js";

/** Hosted independent authoring. Writes use explicit revision/operation identity;
 * callers retain the operation ID when retrying an uncertain response. */
export class OpenPondDatasetWorkspaceClient {
  private readonly baseUrl: string;
  readonly preparations: OpenPondDatasetPreparationClient;
  constructor(private readonly options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey.trim() || !options.teamId.trim()) throw new Error("A clean API origin and workspace credentials are required.");
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.preparations = new OpenPondDatasetPreparationClient(options);
  }
  async list(options: z.input<typeof DatasetWorkspaceListQuerySchema> & { signal?: AbortSignal } = {}) {
    const { signal, ...input } = options;
    const query = DatasetWorkspaceListQuerySchema.parse(input);
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    const result = DatasetWorkspaceListSchema.parse(await this.request(`?${params}`, "GET", undefined, signal));
    if (result.teamId !== this.options.teamId || result.datasets.length > query.limit || new Set(result.datasets.map(item => item.id)).size !== result.datasets.length) throw new Error("Dataset list workspace/page mismatch.");
    return result;
  }
  async get(id: string, signal?: AbortSignal) { return this.readback(await this.request(`/${encodeURIComponent(id)}`, "GET", undefined, signal), id); }
  /** Recover only this actor's retained operation; base bytes allow adapters to
   * reconstruct and verify the identical original CAS request before replay. */
  async operationResult(operationId: string, options: { datasetId?: string; kind: z.infer<typeof DatasetWorkspaceOperationKindSchema>; requestHash?: string; signal?: AbortSignal }) {
    const kind = DatasetWorkspaceOperationKindSchema.parse(options.kind);
    const params = new URLSearchParams({ kind, ...(options.datasetId ? { datasetId: options.datasetId } : {}) });
    const raw = await this.request(`/operations/${encodeURIComponent(operationId)}?${params}`, "GET", undefined, options.signal, 132 * 1024 * 1024);
    if (raw === null) return null;
    const value = DatasetWorkspaceOperationResultSchema.parse(raw);
    this.readback(value.receipt, value.receipt.datasetId); if (value.base) this.readback(value.base, value.receipt.datasetId);
    if (value.operationId !== operationId || value.kind !== kind || options.datasetId && value.receipt.datasetId !== options.datasetId || options.requestHash && value.requestHash !== options.requestHash) throw new Error("Dataset operation recovery identity/request mismatch.");
    return value;
  }
  async beginVersion(id: string, input: z.input<typeof DatasetWorkspaceBeginVersionSchema>, signal?: AbortSignal) {
    const request = DatasetWorkspaceBeginVersionSchema.parse(input);
    const result = this.readback(await this.request(`/${encodeURIComponent(id)}/begin-version`, "POST", request, signal), id);
    if (result.revision !== request.expectedRevision + 1 || result.workspace.draft.status !== "draft" || !result.publication || !result.workspace.draft.publishedTasksetRef) throw new Error("Editable version receipt mismatch.");
    return result;
  }
  async versions(id: string, options: { beforeRevision?: number; signal?: AbortSignal } = {}) {
    const query = new URLSearchParams(options.beforeRevision === undefined ? {} : { beforeRevision: String(options.beforeRevision) });
    const result = DatasetWorkspaceVersionsSchema.parse(await this.request(`/${encodeURIComponent(id)}/versions?${query}`, "GET", undefined, options.signal));
    if (result.teamId !== this.options.teamId || result.datasetId !== id || result.items.some((item, index) => (index > 0 && item.workspaceRevision >= result.items[index - 1]!.workspaceRevision) || (options.beforeRevision !== undefined && item.workspaceRevision >= options.beforeRevision))) throw new Error("Dataset version history scope/order mismatch.");
    return result;
  }
  async version(id: string, workspaceRevision: number, signal?: AbortSignal) {
    const result = this.readback(await this.request(`/${encodeURIComponent(id)}/versions/${workspaceRevision}`, "GET", undefined, signal), id);
    if (result.revision !== workspaceRevision || result.workspace.draft.status !== "published") throw new Error("Dataset immutable version mismatch.");
    return result;
  }
  async save(input: z.input<typeof DatasetWorkspaceWriteSchema>, signal?: AbortSignal) {
    const request = DatasetWorkspaceWriteSchema.parse(input);
    const workspace = validateTasksetDraftWorkspace(request.workspace);
    if (workspace.draft.profileId !== this.options.teamId || workspace.draft.revision !== request.expectedRevision + 1) throw new Error("Dataset write scope or revision mismatch.");
    const result = this.readback(await this.request(`/${encodeURIComponent(workspace.draft.id)}`, "PUT", request, signal), workspace.draft.id);
    if (request.originProjectId && result.originProjectId !== request.originProjectId) throw new Error("Dataset origin Project mismatch.");
    if (request.ownerScope && result.ownerScope !== request.ownerScope) throw new Error("Dataset owner scope mismatch.");
    if (result.workspace.contentHash !== workspace.contentHash) throw new Error("Dataset write receipt differs from the saved bytes.");
    return result;
  }
  async validate(id: string, expectedRevision: number, signal?: AbortSignal) {
    const result = DatasetWorkspaceValidationSchema.parse(await this.request(`/${encodeURIComponent(id)}/validate`, "POST", { expectedRevision }, signal));
    if (result.teamId !== this.options.teamId || result.datasetId !== id || result.revision !== expectedRevision) throw new Error("Dataset validation receipt mismatch.");
    return result;
  }
  async publish(id: string, input: z.input<typeof DatasetWorkspacePublishSchema>, signal?: AbortSignal) {
    const request = DatasetWorkspacePublishSchema.parse(input);
    const result = this.readback(await this.request(`/${encodeURIComponent(id)}/publish`, "POST", request, signal), id);
    if (result.revision !== request.expectedRevision + 1 || result.workspace.draft.status !== "published" || result.publication?.packageHash !== request.packageHash) throw new Error("Dataset publication receipt mismatch.");
    return result;
  }
  private readback(value: unknown, id: string) {
    const result = DatasetWorkspaceReceiptSchema.parse(value);
    validateTasksetDraftWorkspace(result.workspace);
    if (result.datasetId !== id || result.teamId !== this.options.teamId) throw new Error("Dataset identity mismatch.");
    return result;
  }
  private async request(path: string, method: string, body?: unknown, signal?: AbortSignal, maxResponseBytes?: number): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}/v1/dataset-workspaces${path}`, {
      method, signal, redirect: "error", headers: { Authorization: `Bearer ${this.options.apiKey}`, "X-OpenPond-Team-Id": this.options.teamId, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Dataset request failed (${response.status}).`);
    if (maxResponseBytes !== undefined) {
      if (!response.body) throw new Error("Dataset response is empty.");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > maxResponseBytes) throw new Error("Dataset recovery exceeds its bounded response."); chunks.push(part.value); } } finally { await reader.cancel(); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    return response.json();
  }
}
