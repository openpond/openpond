import { contentHash } from "@openpond/harness";
import { TrainingProjectSchema, TrainingProjectWriteSchema, TrainingProjectArchiveSchema, TrainingProjectListSchema, type TrainingProjectWrite } from "./training-project-contracts.js";

export class OpenPondTrainingProjectClient {
  private readonly baseUrl: string;
  constructor(private readonly options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey.trim() || !options.teamId.trim()) throw new Error("A clean API origin and workspace credentials are required.");
    this.baseUrl = url.toString().replace(/\/+$/, "");
  }
  async list(options: { cursor?: string; signal?: AbortSignal } = {}) {
    const result = TrainingProjectListSchema.parse(await this.request(`?${new URLSearchParams(options.cursor ? { cursor: options.cursor } : {})}`, "GET", undefined, options.signal));
    if (result.teamId !== this.options.teamId || result.projects.some(p => p.teamId !== this.options.teamId)) throw new Error("Project list workspace mismatch.");
    return result;
  }
  async get(id: string, signal?: AbortSignal) { return this.readback(await this.request(`/${encodeURIComponent(id)}`, "GET", undefined, signal), id); }
  async save(input: TrainingProjectWrite, signal?: AbortSignal) {
    const request = TrainingProjectWriteSchema.parse(input);
    const result = this.readback(await this.request(`/${encodeURIComponent(request.id)}`, "PUT", request, signal), request.id);
    if (result.revision !== request.expectedRevision + 1 || contentHash(result.content) !== contentHash(request.content)) throw new Error("Project write revision mismatch.");
    return result;
  }
  async archive(id: string, input: { operationId: string; expectedRevision: number; archived: boolean }, signal?: AbortSignal) {
    const request = TrainingProjectArchiveSchema.parse(input);
    const result = this.readback(await this.request(`/${encodeURIComponent(id)}/archive`, "POST", request, signal), id);
    if (result.revision !== request.expectedRevision + 1 || result.archived !== request.archived) throw new Error("Project archive receipt mismatch.");
    return result;
  }
  private readback(value: unknown, id: string) {
    const result = TrainingProjectSchema.parse(value);
    if (result.id !== id || result.teamId !== this.options.teamId) throw new Error("Project identity mismatch.");
    return result;
  }
  private async request(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}/v1/training-projects${path}`, {
      method, signal, redirect: "error", headers: { Authorization: `Bearer ${this.options.apiKey}`, "X-OpenPond-Team-Id": this.options.teamId, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Project request failed (${response.status}).`);
    return response.json();
  }
}
