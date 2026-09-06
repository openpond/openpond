import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(500);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Inventory metadata only. Task rows, evaluator source, and object locations
 * are resolved separately by an authorized package operation. */
export const HostedTasksetSummarySchema = z.object({
  schemaVersion: z.literal("openpond.hostedTasksetSummary.v1"),
  id: IdSchema,
  teamId: IdSchema,
  release: z.object({ id: IdSchema, revision: z.number().int().positive(), contentHash: HashSchema }).strict(),
  name: z.string().min(1).max(500),
  description: z.string().max(20_000),
  taskCount: z.number().int().nonnegative(),
  buildIntent: z.string().min(1).max(100),
  methodHint: z.string().min(1).max(100).nullable(),
  packageBytes: z.number().int().nonnegative().nullable(),
  storedBytes: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export const TasksetCatalogQuerySchema = z.object({
  afterId: IdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(30),
  modelProjectId: IdSchema.optional(),
}).strict();
export const TasksetCatalogPageSchema = z.object({
  items: z.array(HostedTasksetSummarySchema).max(100),
  nextCursor: IdSchema.nullable(),
}).strict();
export const TasksetCatalogErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
}).strict();
export type HostedTasksetSummary = z.infer<typeof HostedTasksetSummarySchema>;
export type TasksetCatalogPage = z.infer<typeof TasksetCatalogPageSchema>;

export class OpenPondTasksetCatalogError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "OpenPondTasksetCatalogError";
  }
}

export interface TasksetCatalogClientOptions {
  baseUrl: string;
  apiKey: string;
  teamId: string;
  fetch?: typeof globalThis.fetch;
}

export class OpenPondTasksetCatalogClient {
  readonly #options: TasksetCatalogClientOptions;
  constructor(options: TasksetCatalogClientOptions) {
    if (!options.apiKey.trim() || !options.teamId.trim()) throw new Error("Taskset API key and workspace are required.");
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Taskset base URL must be an HTTP(S) endpoint without credentials, query, or fragment.");
    this.#options = { ...options, baseUrl: url.toString().replace(/\/+$/, "") };
  }

  async list(query: z.input<typeof TasksetCatalogQuerySchema> = {}, options: { signal?: AbortSignal } = {}): Promise<TasksetCatalogPage> {
    const parsed = TasksetCatalogQuerySchema.parse(query);
    const search = new URLSearchParams({ limit: String(parsed.limit) });
    if (parsed.afterId) search.set("afterId", parsed.afterId);
    if (parsed.modelProjectId) search.set("modelProjectId", parsed.modelProjectId);
    const page = TasksetCatalogPageSchema.parse(await this.#request(`?${search}`, options.signal));
    if (page.items.length > parsed.limit || page.items.some((item) => item.teamId !== this.#options.teamId)) throw new OpenPondTasksetCatalogError(502, "catalog_scope_mismatch", "Taskset inventory did not match the requested workspace or page size.");
    return page;
  }

  async get(id: string, options: { signal?: AbortSignal } = {}): Promise<HostedTasksetSummary> {
    const parsed = IdSchema.parse(id);
    const item = HostedTasksetSummarySchema.parse(await this.#request(`/${encodeURIComponent(parsed)}`, options.signal));
    if (item.id !== parsed || item.teamId !== this.#options.teamId) throw new OpenPondTasksetCatalogError(502, "catalog_identity_mismatch", "Taskset metadata did not match the requested identity.");
    return item;
  }

  async #request(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await (this.#options.fetch ?? globalThis.fetch)(`${this.#options.baseUrl}/v1/taskset-catalog${path}`, {
      headers: { Authorization: `Bearer ${this.#options.apiKey}`, "X-OpenPond-Team-Id": this.#options.teamId, Accept: "application/json" },
      signal, redirect: "error",
    });
    const reader = response.body?.getReader();
    if (!reader) throw new OpenPondTasksetCatalogError(response.status, "empty_response", "Taskset catalog response was empty.");
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4_194_304) throw new OpenPondTasksetCatalogError(response.status, "response_too_large", "Taskset catalog response exceeded 4 MiB.");
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel(); reader.releaseLock(); }
    const payload: unknown = JSON.parse(text);
    if (!response.ok) {
      const error = TasksetCatalogErrorSchema.safeParse(payload);
      throw new OpenPondTasksetCatalogError(response.status, error.success ? error.data.code : "invalid_error_response", error.success ? error.data.message : `Taskset catalog request failed (${response.status}).`);
    }
    return payload;
  }
}
