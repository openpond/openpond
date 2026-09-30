import { z } from "zod";
import { RewardReleaseSchema } from "@openpond/evals/rewards";
const Id = z.string().trim().min(1).max(240);
export const GraderCatalogQuerySchema = z.object({ projectId: Id.optional(), search: z.string().max(300).optional(), kind: z.string().max(100).optional(), sort: z.enum(["name", "type", "version", "projects", "datasets", "runs"]).optional(), direction: z.enum(["asc", "desc"]).optional(), after: z.string().max(3000).optional(), limit: z.number().int().min(1).max(100).default(30) }).strict();
export const GraderCatalogPageSchema = z.object({ teamId: Id, items: z.array(z.object({ reward: RewardReleaseSchema, projects: z.number().int().nonnegative(), datasets: z.number().int().nonnegative(), runs: z.number().int().nonnegative() }).strict()).max(100), nextCursor: z.string().nullable() }).strict();
export const GraderVersionsPageSchema = z.object({ teamId: Id, id: Id, items: z.array(RewardReleaseSchema).max(100), nextRevision: z.number().int().positive().nullable() }).strict();
export const GraderUsageQuerySchema = z.object({ section: z.enum(["projects", "datasets", "runs"]), after: Id.optional(), limit: z.number().int().min(1).max(100).default(25) }).strict();
export const GraderUsagePageSchema = z.object({ teamId: Id, id: Id, section: GraderUsageQuerySchema.shape.section, items: z.array(z.union([
  z.object({ id: Id, name: z.string(), graderRevisions: z.array(z.number().int().positive()), archived: z.boolean() }).strict(),
  z.object({ id: Id, name: z.string(), revision: z.number().int().positive(), graderRevisions: z.array(z.number().int().positive()) }).strict(),
  z.object({ id: Id, name: z.string(), status: z.string() }).strict(),
])).max(100), nextCursor: Id.nullable() }).strict();
export class OpenPondGraderInspectionClient {
  private readonly baseUrl: string;
  constructor(private readonly options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey.trim() || !options.teamId.trim()) throw new Error("A clean API origin and workspace credentials are required.");
    this.baseUrl = url.toString().replace(/\/+$/, "");
  }
  async catalog(value: z.input<typeof GraderCatalogQuerySchema> = {}, signal?: AbortSignal) {
    const query = GraderCatalogQuerySchema.parse(value);
    const page = GraderCatalogPageSchema.parse(await this.read("", query, signal));
    if (page.teamId !== this.options.teamId || page.items.length > query.limit || new Set(page.items.map(item => item.reward.id)).size !== page.items.length) throw new Error("Grader catalog differs from its requested workspace or bounds.");
    return page;
  }
  async versions(id: string, query: { beforeRevision?: number; limit?: number } = {}, signal?: AbortSignal) {
    const options = z.object({ beforeRevision: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(25) }).strict().parse(query);
    const page = GraderVersionsPageSchema.parse(await this.read(`/${encodeURIComponent(Id.parse(id))}/versions`, options, signal));
    if (page.teamId !== this.options.teamId || page.id !== id || page.items.length > options.limit || page.items.some((item, index) => item.id !== id || options.beforeRevision && item.revision >= options.beforeRevision || index > 0 && item.revision >= page.items[index - 1]!.revision)) throw new Error("Grader versions differ from their requested identity or revision order.");
    return page;
  }
  async usage(id: string, value: z.input<typeof GraderUsageQuerySchema>, signal?: AbortSignal) {
    const query = GraderUsageQuerySchema.parse(value);
    const page = GraderUsagePageSchema.parse(await this.read(`/${encodeURIComponent(Id.parse(id))}/usage`, query, signal));
    if (page.teamId !== this.options.teamId || page.id !== id || page.section !== query.section || page.items.length > query.limit) throw new Error("Grader usage differs from its requested workspace, identity or bounds.");
    return page;
  }
  private async read(path: string, query: Record<string, unknown>, signal?: AbortSignal) {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}/v1/learning/read/graders${path}?${params}`, { signal, redirect: "error", headers: { Authorization: `Bearer ${this.options.apiKey}`, "X-OpenPond-Team-Id": this.options.teamId, Accept: "application/json" } });
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(value).error);
    return value;
  }
}
