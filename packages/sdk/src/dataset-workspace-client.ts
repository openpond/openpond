import { DatasetWorkspaceBeginVersionSchema, DatasetWorkspaceVersionsSchema, DatasetWorkspaceListSchema, DatasetWorkspacePublishSchema, DatasetWorkspaceReceiptSchema, DatasetWorkspaceValidationSchema, DatasetWorkspaceWriteSchema } from "./dataset-workspace-contracts.js";
import { validateTasksetDraftWorkspace } from "./taskset-draft-workspace.js";
import type { z } from "zod";

/** Hosted independent authoring. Writes use explicit revision/operation identity;
 * callers retain the operation ID when retrying an uncertain response. */
export class OpenPondDatasetWorkspaceClient {
  private readonly baseUrl: string;
  constructor(private readonly options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey.trim() || !options.teamId.trim()) throw new Error("A clean API origin and workspace credentials are required.");
    this.baseUrl = url.toString().replace(/\/+$/, "");
  }
  async list(options: { cursor?: string; projectId?: string; signal?: AbortSignal } = {}) {
    const params = new URLSearchParams({ ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.projectId ? { projectId: options.projectId } : {}) });
    const result = DatasetWorkspaceListSchema.parse(await this.request(`?${params}`, "GET", undefined, options.signal));
    if (result.teamId !== this.options.teamId) throw new Error("Dataset list workspace mismatch.");
    return result;
  }
  async get(id: string, signal?: AbortSignal) { return this.readback(await this.request(`/${encodeURIComponent(id)}`, "GET", undefined, signal), id); }
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
  private async request(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}/v1/dataset-workspaces${path}`, {
      method, signal, redirect: "error", headers: { Authorization: `Bearer ${this.options.apiKey}`, "X-OpenPond-Team-Id": this.options.teamId, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Dataset request failed (${response.status}).`);
    return response.json();
  }
}
