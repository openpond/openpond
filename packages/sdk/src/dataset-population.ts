import { contentHash } from "@openpond/harness";
import { TaskSplitSchema, TaskRecordSchema } from "@openpond/evals/tasksets";
import { z } from "zod";
import { ExperimentGraderPinSchema } from "./experiment-contracts.js";
import { TasksetCatalogReleaseRefSchema } from "./taskset-catalog.js";

const Id = z.string().trim().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const DatasetPopulationQuerySchema = z.object({
  release: TasksetCatalogReleaseRefSchema,
  afterId: Id.optional(),
  limit: z.number().int().min(1).max(10_000).default(100),
  view: z.enum(["ids", "policy"]).default("ids"),
}).strict().superRefine((query, context) => { if (query.view === "policy" && query.limit > 100) context.addIssue({ code: "custom", path: ["limit"], message: "Policy previews are bounded to 100 tasks." }); });
const TaskIdentity = z.object({ id: TaskRecordSchema.shape.id, split: TaskSplitSchema }).strict();
const PolicyTask = TaskIdentity.extend({
  input: z.record(z.string(), z.unknown()),
  policyVisibleContext: z.record(z.string(), z.unknown()),
  artifacts: z.array(z.object({ id: Id, path: z.string(), mediaType: z.string(), sizeBytes: z.number().int().nonnegative() }).strict()).max(1000),
}).strict();
export const DatasetPopulationPageSchema = z.object({
  schemaVersion: z.literal("openpond.datasetPopulationPage.v1"),
  teamId: Id, release: TasksetCatalogReleaseRefSchema,
  view: DatasetPopulationQuerySchema.shape.view,
  taskCount: z.number().int().nonnegative(),
  items: z.array(z.union([TaskIdentity, PolicyTask])).max(10_000),
  graders: z.array(ExperimentGraderPinSchema).max(1000),
  nextCursor: Id.nullable(), contentHash: Hash,
}).strict().superRefine((page, context) => {
  if (page.view === "policy" && page.items.length > 100) context.addIssue({ code: "custom", message: "Policy preview exceeded its task bound." });
  if (page.items.some(item => ("input" in item) !== (page.view === "policy"))) context.addIssue({ code: "custom", message: "Dataset task view differs from the requested projection." });
});
export type DatasetPopulationPage = z.infer<typeof DatasetPopulationPageSchema>;

/** Exact released membership and policy-visible previews. Gold answers,
 * verifier source, privileged context and object locations are never returned. */
export class OpenPondDatasetPopulationClient {
  private readonly baseUrl: string;
  constructor(private readonly options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey.trim() || !options.teamId.trim()) throw new Error("A clean API origin and workspace credentials are required.");
    this.baseUrl = url.toString().replace(/\/+$/, "");
  }
  async read(value: z.input<typeof DatasetPopulationQuerySchema>, signal?: AbortSignal): Promise<DatasetPopulationPage> {
    const query = DatasetPopulationQuerySchema.parse(value);
    const params = new URLSearchParams({ releaseId: query.release.id, revision: String(query.release.revision), contentHash: query.release.contentHash, limit: String(query.limit), view: query.view });
    if (query.afterId) params.set("afterId", query.afterId);
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}/v1/dataset-workspaces/population?${params}`, { signal, redirect: "error", headers: { Authorization: `Bearer ${this.options.apiKey}`, "X-OpenPond-Team-Id": this.options.teamId, Accept: "application/json" } });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Dataset population response was empty.");
    let bytes = 0, source = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4_194_304) throw new Error("Dataset population response exceeded 4 MiB. Request fewer tasks.");
        source += decoder.decode(chunk.value, { stream: true });
      }
      source += decoder.decode();
    } finally { await reader.cancel(); reader.releaseLock(); }
    const raw: unknown = JSON.parse(source);
    if (!response.ok) throw new Error(z.object({ message: z.string() }).passthrough().parse(raw).message);
    const page = DatasetPopulationPageSchema.parse(raw);
    const { contentHash: hash, ...content } = page;
    if (page.teamId !== this.options.teamId || contentHash(page.release) !== contentHash(query.release) || page.view !== query.view || page.items.length > query.limit || contentHash(content) !== hash || page.items.some((item, index) => (query.afterId !== undefined && item.id <= query.afterId) || (index > 0 && item.id <= page.items[index - 1]!.id)) || (page.nextCursor !== null && page.nextCursor !== page.items.at(-1)?.id)) throw new Error("Dataset population identity, hash, order or bounds mismatch.");
    return page;
  }
}
