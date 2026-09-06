import { z } from "zod";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import { ModelStarterSchema, validateResolvedModelStarter } from "./model-starters.js";

export const ModelStarterCatalogQuerySchema = z.object({
  afterId: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100).default(30),
}).strict();
export const ModelStarterCatalogPageSchema = z.object({
  items: z.array(ModelStarterSchema).max(100),
  nextCursor: z.string().min(1).max(500).nullable(),
}).strict();
export const ModelStarterCatalogErrorSchema = z.object({ code: z.string().min(1).max(200), message: z.string().min(1).max(5_000) }).strict();

export class OpenPondModelStarterCatalogError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "OpenPondModelStarterCatalogError"; }
}

/** One hosted catalog for both clients. Discovery never downloads task rows;
 * exact resolution obtains a bounded, integrity-checked package separately. */
export class OpenPondModelStarterCatalogClient {
  readonly #options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof globalThis.fetch };
  constructor(options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof globalThis.fetch }) {
    if (!options.apiKey.trim() || !options.teamId.trim()) throw new Error("Starter catalog credentials and workspace are required.");
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Starter catalog base URL must be an HTTP(S) endpoint without credentials, query or fragment.");
    this.#options = { ...options, baseUrl: url.toString().replace(/\/+$/, "") };
  }

  async list(query: z.input<typeof ModelStarterCatalogQuerySchema> = {}, options: { signal?: AbortSignal } = {}) {
    const parsed = ModelStarterCatalogQuerySchema.parse(query);
    const search = new URLSearchParams({ limit: String(parsed.limit) });
    if (parsed.afterId) search.set("afterId", parsed.afterId);
    const page = ModelStarterCatalogPageSchema.parse(await this.#request(`?${search}`, 4 * 1024 * 1024, options.signal));
    if (page.items.length > parsed.limit || new Set(page.items.map(item => item.id)).size !== page.items.length) throw new OpenPondModelStarterCatalogError(502, "starter_catalog_page_invalid", "Starter catalog returned an invalid page.");
    return page;
  }

  async resolve(reference: z.infer<typeof ModelProjectVersionedRefSchema>, options: { signal?: AbortSignal } = {}) {
    const ref = ModelProjectVersionedRefSchema.parse(reference);
    const resolved = validateResolvedModelStarter(await this.#request(`/releases/${encodeURIComponent(ref.id)}/${ref.revision}/${ref.contentHash}`, 16 * 1024 * 1024, options.signal));
    if (resolved.starter.id !== ref.id || resolved.starter.revision !== ref.revision || resolved.starter.contentHash !== ref.contentHash) throw new OpenPondModelStarterCatalogError(502, "starter_catalog_revision_mismatch", "Starter catalog returned a different package revision.");
    return resolved;
  }

  async #request(path: string, maximumBytes: number, signal?: AbortSignal): Promise<unknown> {
    const response = await (this.#options.fetch ?? globalThis.fetch)(`${this.#options.baseUrl}/v1/model-starter-catalog${path}`, {
      headers: { Authorization: `Bearer ${this.#options.apiKey}`, "X-OpenPond-Team-Id": this.#options.teamId, Accept: "application/json" }, signal, redirect: "error",
    });
    const reader = response.body?.getReader();
    if (!reader) throw new OpenPondModelStarterCatalogError(response.status, "starter_catalog_empty_response", "Starter catalog returned no data.");
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximumBytes) throw new OpenPondModelStarterCatalogError(response.status, "starter_catalog_response_too_large", "Starter catalog response exceeded its limit.");
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel(); reader.releaseLock(); }
    const payload: unknown = JSON.parse(text);
    if (!response.ok) {
      const error = ModelStarterCatalogErrorSchema.safeParse(payload);
      throw new OpenPondModelStarterCatalogError(response.status, error.success ? error.data.code : "starter_catalog_invalid_error", error.success ? error.data.message : "Starter catalog request failed.");
    }
    return payload;
  }
}
