import { z } from "zod";
import { canonicalJson } from "./protocol.js";
import { ModelTasksetRunRequestSchema, ModelTasksetRunListQuerySchema, ModelTasksetRunPageSchema, verifyModelTasksetRunDetails, verifyModelTasksetRunResult, type ModelTasksetRunSummary } from "./model-taskset-runs-contracts.js";
export * from "./model-taskset-runs-contracts.js";

const IdSchema = z.string().trim().min(1).max(200);
export class OpenPondModelTasksetRunError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "OpenPondModelTasksetRunError"; }
}

export class OpenPondModelTasksetRunsClient {
  readonly #options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof globalThis.fetch };
  constructor(options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof globalThis.fetch }) {
    const url = new URL(options.baseUrl);
    if (!options.apiKey.trim() || !options.teamId.trim() || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Evaluation runs require an HTTP(S) endpoint and workspace credentials.");
    this.#options = { ...options, baseUrl: url.toString().replace(/\/+$/, "") };
  }
  async create(value: z.input<typeof ModelTasksetRunRequestSchema>, options: { signal?: AbortSignal } = {}) {
    const request = ModelTasksetRunRequestSchema.parse(value);
    if (request.teamId !== this.#options.teamId) throw new Error("Evaluation belongs to another workspace.");
    const result = await verifyModelTasksetRunDetails(await this.#request("", "POST", request, options.signal));
    this.#scope(result.summary);
    if (canonicalJson(result.request) !== canonicalJson(request)) throw new OpenPondModelTasksetRunError(502, "evaluation_request_mismatch", "Evaluation differs from the submitted request.");
    return result;
  }
  async get(id: string, options: { signal?: AbortSignal } = {}) {
    const result = await verifyModelTasksetRunDetails(await this.#request(`/${encodeURIComponent(IdSchema.parse(id))}`, "GET", undefined, options.signal));
    this.#scope(result.summary, id);
    return result;
  }
  async cancel(id: string, options: { signal?: AbortSignal } = {}) {
    const result = await verifyModelTasksetRunDetails(await this.#request(`/${encodeURIComponent(IdSchema.parse(id))}/cancel`, "POST", undefined, options.signal));
    this.#scope(result.summary, id);
    return result;
  }
  async result(id: string, options: { signal?: AbortSignal } = {}) {
    const result = await verifyModelTasksetRunResult(await this.#request(`/${encodeURIComponent(IdSchema.parse(id))}/result`, "GET", undefined, options.signal));
    this.#scope(result.run.summary, id);
    return result;
  }
  async list(value: z.input<typeof ModelTasksetRunListQuerySchema>, options: { signal?: AbortSignal } = {}) {
    const query = ModelTasksetRunListQuerySchema.parse(value);
    const params = new URLSearchParams({ modelProjectId: query.modelProjectId, limit: String(query.limit) });
    if (query.afterId) params.set("afterId", query.afterId);
    const result = ModelTasksetRunPageSchema.parse(await this.#request(`?${params}`, "GET", undefined, options.signal));
    if (result.items.length > query.limit || new Set(result.items.map(item => item.id)).size !== result.items.length || result.items.some(item => { this.#scope(item); return item.modelProjectId !== query.modelProjectId; })) throw new OpenPondModelTasksetRunError(502, "evaluation_page_mismatch", "Evaluation page differs from the selected model.");
    return result;
  }
  #scope(summary: ModelTasksetRunSummary, id?: string) {
    if (summary.teamId !== this.#options.teamId || (id && summary.id !== id)) throw new OpenPondModelTasksetRunError(502, "evaluation_identity_mismatch", "Evaluation belongs to another identity or workspace.");
  }
  async #request(path: string, method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await (this.#options.fetch ?? globalThis.fetch)(`${this.#options.baseUrl}/v1/model-taskset-runs${path}`, {
      method, headers: { Authorization: `Bearer ${this.#options.apiKey}`, "X-OpenPond-Team-Id": this.#options.teamId, "Content-Type": "application/json", Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, redirect: "error",
    });
    const value = await response.json();
    if (!response.ok) {
      const error = z.object({ code: z.string(), message: z.string() }).safeParse(value);
      throw new OpenPondModelTasksetRunError(response.status, error.success ? error.data.code : "evaluation_request_failed", error.success ? error.data.message : "Evaluation request failed.");
    }
    return value;
  }
}
