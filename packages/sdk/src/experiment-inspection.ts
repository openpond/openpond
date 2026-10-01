import { z } from "zod";
import { contentHash } from "@openpond/harness";
const Id = z.string().trim().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Content = z.object({ schemaVersion: z.literal("openpond.experimentCaseInspection.v1"), teamId: Id, executionId: Id, manifestHash: Hash, receiptId: Id, taskId: Id, seed: z.string().min(1), input: z.record(z.string(), z.unknown()).nullable(), output: z.unknown().nullable(), error: z.string().nullable(), events: z.array(z.record(z.string(), z.unknown())).max(25), nextEventCursor: Id.nullable(), eventCount: z.number().int().nonnegative() }).strict();
export const ExperimentCaseInspectionSchema = Content.extend({ contentHash: Hash }).strict();
export type ExperimentCaseInspection = z.infer<typeof ExperimentCaseInspectionSchema>;
export class OpenPondExperimentInspectionClient {
  private readonly baseUrl: string;
  constructor(private readonly options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey.trim() || !options.teamId.trim()) throw new Error("A clean API origin and workspace credentials are required.");
    this.baseUrl = url.toString().replace(/\/+$/, "");
  }
  /** Retained, policy-facing evidence only. Reading a page never dispatches. */
  async case(executionId: string, receiptId: string, options: { manifestHash?: string; afterId?: string; signal?: AbortSignal } = {}) {
    const params = new URLSearchParams(options.afterId ? { afterId: Id.parse(options.afterId) } : {});
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}/v1/experiments/${encodeURIComponent(Id.parse(executionId))}/cases/${encodeURIComponent(Id.parse(receiptId))}?${params}`, { signal: options.signal, redirect: "error", headers: { Authorization: `Bearer ${this.options.apiKey}`, "X-OpenPond-Team-Id": this.options.teamId, Accept: "application/json" } });
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(z.object({ message: z.string() }).parse(value).message);
    const result = ExperimentCaseInspectionSchema.parse(value);
    const { contentHash: actual, ...content } = result;
    if (contentHash(content) !== actual || result.teamId !== this.options.teamId || result.executionId !== executionId || result.receiptId !== receiptId || options.manifestHash && result.manifestHash !== options.manifestHash || result.events.length > result.eventCount) throw new Error("Case inspection differs from its requested workspace, execution or retained content.");
    return result;
  }
}
