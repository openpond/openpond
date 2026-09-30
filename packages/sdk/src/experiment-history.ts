import { z } from "zod";
import { ExperimentDefinitionRefSchema } from "./experiment-contracts.js";
import { ModelTasksetRunSummarySchema, ModelTasksetRunPolicySchema } from "./model-taskset-runs-contracts.js";

const Id = z.string().trim().min(1).max(240);
export const ExperimentHistoryQuerySchema = z.object({ projectId: Id.optional(), afterId: Id.optional(), limit: z.number().int().min(1).max(100).default(30), status: ModelTasksetRunSummarySchema.shape.status.optional(), search: z.string().trim().max(100).optional(), modelId: Id.optional(), tasksetHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const ExperimentHistoryItemSchema = z.object({ summary: ModelTasksetRunSummarySchema, definition: ExperimentDefinitionRefSchema, policy: ModelTasksetRunPolicySchema }).strict().superRefine((item, context) => {
  if (item.summary.policyKind !== item.policy.kind) context.addIssue({ code: "custom", path: ["policy"], message: "History target differs from the retained execution." });
});
export const ExperimentHistoryPageSchema = z.object({ items: z.array(ExperimentHistoryItemSchema).max(100), nextCursor: Id.nullable() }).strict();
export type ExperimentHistoryItem = z.infer<typeof ExperimentHistoryItemSchema>;
export type ExperimentHistoryPage = z.infer<typeof ExperimentHistoryPageSchema>;

/** Compact retained history; populations, private answers and case bytes stay
 * behind their existing authorized readers. This never refreshes dispatch. */
export class OpenPondExperimentHistoryClient {
  private readonly baseUrl: string;
  constructor(private readonly options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey.trim() || !options.teamId.trim()) throw new Error("A clean API origin and workspace credentials are required.");
    this.baseUrl = url.toString().replace(/\/+$/, "");
  }
  async list(input: z.input<typeof ExperimentHistoryQuerySchema> = {}, signal?: AbortSignal): Promise<ExperimentHistoryPage> {
    const query = ExperimentHistoryQuerySchema.parse(input);
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}/v1/experiments/executions?${params}`, { signal, redirect: "error", headers: { Authorization: `Bearer ${this.options.apiKey}`, "X-OpenPond-Team-Id": this.options.teamId, Accept: "application/json" } });
    if (!response.ok) throw new Error(`Experiment history request failed (${response.status}).`);
    if (!response.body) throw new Error("Experiment history response is empty.");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 4 * 1024 * 1024) throw new Error("Experiment history exceeds its bounded page."); chunks.push(value); } }
    finally { await reader.cancel(); }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const page = ExperimentHistoryPageSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (page.items.length > query.limit || new Set(page.items.map(item => item.summary.id)).size !== page.items.length || page.items.some(item => item.summary.teamId !== this.options.teamId || query.status && item.summary.status !== query.status || query.modelId && (!("modelId" in item.policy) || item.policy.modelId !== query.modelId) || query.tasksetHash && item.summary.taskset.contentHash !== query.tasksetHash) || page.nextCursor && page.nextCursor !== page.items.at(-1)?.summary.id) throw new Error("Experiment history differs from its requested scope or page.");
    return page;
  }
}
