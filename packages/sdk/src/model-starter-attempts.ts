import { z } from "zod";
import { RewardCompositionSchema } from "@openpond/evals/rewards";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import { canonicalJson, canonicalSha256 } from "./protocol.js";

const IdSchema = z.string().trim().min(1).max(200);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ModelStarterAttemptPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hosted_chat"), modelId: IdSchema, maxOutputTokens: z.number().int().min(1).max(4_096).default(1_024), temperature: z.number().min(0).max(2).default(0), topP: z.number().gt(0).max(1).default(1) }).strict(),
  z.object({ kind: z.literal("fixture"), fixtureId: IdSchema }).strict(),
]);
/** The server resolves task input, private state, verifier and fixture script.
 * A caller can select releases, but cannot submit replacement execution bytes. */
export const ModelStarterAttemptRequestSchema = z.object({
  schemaVersion: z.literal("openpond.modelStarterAttemptRequest.v1"),
  operationId: IdSchema, teamId: IdSchema, modelProjectId: IdSchema,
  taskset: ModelProjectVersionedRefSchema, taskId: IdSchema,
  environmentSeed: z.number().int().min(0).max(2_147_483_647).default(0),
  policy: ModelStarterAttemptPolicySchema,
}).strict();
export type ModelStarterAttemptRequest = z.infer<typeof ModelStarterAttemptRequestSchema>;
export const ModelStarterAttemptSummarySchema = z.object({
  schemaVersion: z.literal("openpond.modelStarterAttemptSummary.v1"),
  id: IdSchema, revision: z.number().int().positive(), request: ModelStarterAttemptRequestSchema,
  status: z.enum(["queued", "running", "cancelling", "completed", "failed", "cancelled"]),
  policySnapshot: z.object({ modelId: IdSchema, provider: IdSchema, upstreamModelId: z.string().min(1).max(500), configurationHash: HashSchema }).strict().nullable(),
  createdAt: z.iso.datetime(), startedAt: z.iso.datetime().nullable(), completedAt: z.iso.datetime().nullable(),
  cleanupComplete: z.boolean(), resultAvailable: z.boolean(), score: z.number().min(0).max(1).nullable(),
  gradingStatus: z.enum(["not_started", "scored", "unscorable", "not_configured"]).default("not_started"),
  passed: z.boolean().nullable(), outputPreview: z.string().max(500).nullable(),
  error: z.object({ code: IdSchema, message: z.string().max(2_000) }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if ((value.request.policy.kind === "fixture") !== (value.policySnapshot === null)) context.addIssue({ code: "custom", path: ["policySnapshot"], message: "Fixture execution must not claim a model identity." });
  if (value.status === "completed" && (!value.cleanupComplete || !value.resultAvailable || !value.completedAt)) context.addIssue({ code: "custom", message: "Completed attempts require retained results and confirmed cleanup." });
});
export type ModelStarterAttemptSummary = z.infer<typeof ModelStarterAttemptSummarySchema>;
export const ModelStarterAttemptListQuerySchema = z.object({ modelProjectId: IdSchema, afterId: IdSchema.optional(), limit: z.number().int().min(1).max(100).default(25) }).strict();
export const ModelStarterAttemptPageSchema = z.object({ items: z.array(ModelStarterAttemptSummarySchema).max(100), nextCursor: IdSchema.nullable() }).strict();
export const ModelStarterAttemptResultSchema = z.object({
  schemaVersion: z.literal("openpond.modelStarterAttemptResult.v1"),
  attempt: ModelStarterAttemptSummarySchema,
  output: z.string().max(1_048_576).nullable(),
  // Only model-facing messages, never the private environment snapshot.
  messages: z.array(z.record(z.string(), z.unknown())).max(4_002),
  composition: RewardCompositionSchema.nullable(),
  environment: z.object({ status: z.enum(["completed", "budget_exhausted", "cancelled", "timed_out", "policy_failure", "environment_failure"]), collected: z.boolean(), definition: ModelProjectVersionedRefSchema, initialStateHash: HashSchema.nullable(), finalStateHash: HashSchema.nullable(), attemptHash: HashSchema }).strict(),
  providerRequestIds: z.array(IdSchema).max(1_001),
  contentHash: HashSchema,
}).strict();
export type ModelStarterAttemptResult = z.infer<typeof ModelStarterAttemptResultSchema>;

export class OpenPondModelStarterAttemptError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "OpenPondModelStarterAttemptError"; }
}

export class OpenPondModelStarterAttemptsClient {
  readonly #options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof globalThis.fetch };
  constructor(options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof globalThis.fetch }) {
    const url = new URL(options.baseUrl);
    if (!options.apiKey.trim() || !options.teamId.trim() || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Starter attempts require an HTTP(S) endpoint and workspace credentials.");
    this.#options = { ...options, baseUrl: url.toString().replace(/\/+$/, "") };
  }
  async create(value: z.input<typeof ModelStarterAttemptRequestSchema>, options: { signal?: AbortSignal } = {}) {
    const request = ModelStarterAttemptRequestSchema.parse(value);
    if (request.teamId !== this.#options.teamId) throw new Error("Attempt belongs to another workspace.");
    const result = this.#summary(await this.#request("", "POST", request, options.signal));
    if (canonicalJson(result.request) !== canonicalJson(request)) throw new OpenPondModelStarterAttemptError(502, "attempt_request_mismatch", "Attempt receipt differs from the submitted request.");
    return result;
  }
  async get(id: string, options: { signal?: AbortSignal } = {}) { return this.#summary(await this.#request(`/${encodeURIComponent(IdSchema.parse(id))}`, "GET", undefined, options.signal), id); }
  async cancel(id: string, options: { signal?: AbortSignal } = {}) { return this.#summary(await this.#request(`/${encodeURIComponent(IdSchema.parse(id))}/cancel`, "POST", undefined, options.signal), id); }
  async result(id: string, options: { signal?: AbortSignal } = {}) {
    const value = ModelStarterAttemptResultSchema.parse(await this.#request(`/${encodeURIComponent(IdSchema.parse(id))}/result`, "GET", undefined, options.signal));
    this.#summary(value.attempt, id);
    const { contentHash, ...content } = value;
    if (!value.attempt.resultAvailable || await canonicalSha256(content) !== contentHash) throw new OpenPondModelStarterAttemptError(502, "attempt_result_integrity", "Attempt result integrity failed.");
    return value;
  }
  async list(value: z.input<typeof ModelStarterAttemptListQuerySchema>, options: { signal?: AbortSignal } = {}) {
    const query = ModelStarterAttemptListQuerySchema.parse(value);
    const params = new URLSearchParams({ modelProjectId: query.modelProjectId, limit: String(query.limit) });
    if (query.afterId) params.set("afterId", query.afterId);
    const page = ModelStarterAttemptPageSchema.parse(await this.#request(`?${params}`, "GET", undefined, options.signal));
    if (page.items.length > query.limit || new Set(page.items.map(item => item.id)).size !== page.items.length || page.items.some(item => this.#summary(item).request.modelProjectId !== query.modelProjectId)) throw new OpenPondModelStarterAttemptError(502, "attempt_page_mismatch", "Attempt page differs from the selected model.");
    return page;
  }
  #summary(value: unknown, id?: string): ModelStarterAttemptSummary {
    const result = ModelStarterAttemptSummarySchema.parse(value);
    if (result.request.teamId !== this.#options.teamId || (id && result.id !== id)) throw new OpenPondModelStarterAttemptError(502, "attempt_identity_mismatch", "Attempt receipt belongs to another identity or workspace.");
    return result;
  }
  async #request(path: string, method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await (this.#options.fetch ?? globalThis.fetch)(`${this.#options.baseUrl}/v1/model-starter-attempts${path}`, { method, headers: { Authorization: `Bearer ${this.#options.apiKey}`, "X-OpenPond-Team-Id": this.#options.teamId, "Content-Type": "application/json", Accept: "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, redirect: "error" });
    const reader = response.body?.getReader();
    if (!reader) throw new OpenPondModelStarterAttemptError(response.status, "attempt_empty_response", "Attempt response was empty.");
    let bytes = 0; let text = ""; const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 16_777_216) throw new OpenPondModelStarterAttemptError(502, "attempt_response_too_large", "Attempt response exceeded its byte limit.");
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel(); reader.releaseLock(); }
    const value: unknown = JSON.parse(text);
    if (!response.ok) {
      const error = z.object({ code: IdSchema, message: z.string().max(2_000) }).safeParse(value);
      throw new OpenPondModelStarterAttemptError(response.status, error.success ? error.data.code : "attempt_request_failed", error.success ? error.data.message : "Attempt request failed.");
    }
    return value;
  }
}
