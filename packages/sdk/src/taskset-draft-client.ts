import { z } from "zod";
import { contentHash, sha256 } from "@openpond/harness";
import { sameLearningRef } from "@openpond/evals/learning";
import { ModelTasksetDraftRequestSchema, TasksetDraftFileMutationSchema, TasksetDraftFilePathSchema, type ModelTasksetDraftRequest, type TasksetDraftFileMutation } from "./model-taskset-authoring-contracts.js";
import { TasksetDraftSchema } from "./taskset-draft-document.js";
import { decodeTasksetDraftFileContent } from "./taskset-draft-files.js";
import { MAX_TASKSET_DRAFT_WORKSPACE_BYTES } from "./taskset-draft-workspace.js";
import { TasksetPackageReceiptSchema } from "./taskset-package-client.js";
import { TasksetDraftCreateRequestSchema, type TasksetDraftCreateRequest, TasksetDraftSourceDescriptorSchema, TasksetDraftReadbackSchema, TasksetDraftListSchema, TasksetDraftSaveRequestSchema, TasksetDraftRefreshRequestSchema,
  TasksetDraftValidationRequestSchema, TasksetDraftValidationSchema, TasksetDraftPublicationRequestSchema, TasksetDraftFileListSchema, TasksetDraftFileReadbackSchema, TasksetDraftDeletionSchema,
  type TasksetDraftSaveRequest, type TasksetDraftRefreshRequest, type TasksetDraftValidationRequest, type TasksetDraftPublicationRequest } from "./taskset-draft-api-contracts.js";

type Options = { signal?: AbortSignal };
const IdSchema = TasksetDraftSchema.shape.id;
const RevisionSchema = z.number().int().positive();

export class OpenPondTasksetDraftError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "OpenPondTasksetDraftError"; }
}

/** Scoped mutable drafts use explicit CAS and never retry writes automatically. */
export class OpenPondTasksetDraftClient {
  readonly #options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof globalThis.fetch };
  constructor(options: { baseUrl: string; apiKey: string; teamId: string; fetch?: typeof globalThis.fetch }) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !options.apiKey.trim() || !options.teamId.trim()) throw new Error("Taskset draft client requires a clean HTTP(S) endpoint and workspace credentials.");
    this.#options = { ...options, baseUrl: url.toString().replace(/\/+$/, "") };
  }

  async inspectSource(modelId: string, expectedModelRevision: number, options: Options = {}) {
    const model = IdSchema.parse(modelId);
    const revision = RevisionSchema.parse(expectedModelRevision);
    const response = this.#scope(TasksetDraftSourceDescriptorSchema.parse(await this.#request(model, `/source?expectedModelRevision=${revision}`, "GET", undefined, options.signal)), model);
    if (response.expectedModelRevision !== revision) this.#mismatch();
    return response;
  }

  async initialize(input: ModelTasksetDraftRequest, options: Options = {}) {
    const request = ModelTasksetDraftRequestSchema.parse(input);
    const response = this.#draft(await this.#request(request.modelId, "", "POST", request, options.signal), request.modelId);
    const source = response.draft.modelScope?.source;
    if (!source || source.requestHash !== contentHash(request) || source.sourcePackageHash !== request.sourcePackageHash || source.draftId !== response.draft.id
      || source.lineage.owner.scopeId !== this.#options.teamId || source.lineage.owner.modelId !== request.modelId) this.#mismatch();
    return response;
  }

  async create(input: TasksetDraftCreateRequest, options: Options = {}) {
    const request = TasksetDraftCreateRequestSchema.parse(input);
    const response = this.#draft(await this.#request(request.modelId, "", "POST", request, options.signal), request.modelId);
    const expectedId = `model-taskset-draft-${contentHash({ owner: { scopeId: this.#options.teamId, modelId: request.modelId }, operationId: request.operationId })}`;
    if (response.draft.id !== expectedId || response.draft.modelScope?.source !== undefined) this.#mismatch();
    return response;
  }

  async list(modelId: string, options: Options & { limit?: number; cursor?: string } = {}) {
    const model = IdSchema.parse(modelId);
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(z.number().int().min(1).max(100).parse(options.limit)));
    if (options.cursor !== undefined) query.set("cursor", z.string().min(1).max(2_000).parse(options.cursor));
    return this.#scope(TasksetDraftListSchema.parse(await this.#request(model, query.size ? `?${query}` : "", "GET", undefined, options.signal)), model);
  }

  async get(modelId: string, draftId: string, options: Options = {}) {
    const model = IdSchema.parse(modelId);
    const id = IdSchema.parse(draftId);
    return this.#draft(await this.#request(model, `/${encodeURIComponent(id)}`, "GET", undefined, options.signal), model, id);
  }

  async save(modelId: string, input: TasksetDraftSaveRequest, options: Options = {}) {
    const model = IdSchema.parse(modelId);
    const request = TasksetDraftSaveRequestSchema.parse(input);
    return this.#draft(await this.#request(model, `/${encodeURIComponent(request.draft.id)}`, "PUT", request, options.signal), model, request.draft.id, request.expectedDraftRevision + 1);
  }

  async refreshModel(modelId: string, draftId: string, input: TasksetDraftRefreshRequest, options: Options = {}) {
    const model = IdSchema.parse(modelId);
    const id = IdSchema.parse(draftId);
    const request = TasksetDraftRefreshRequestSchema.parse(input);
    const response = this.#draft(await this.#request(model, `/${encodeURIComponent(id)}/refresh-model`, "POST", request, options.signal), model, id, request.expectedDraftRevision + 1);
    if (response.draft.modelScope?.expectedModelRevision !== request.expectedModelRevision) this.#mismatch();
    return response;
  }

  async files(modelId: string, draftId: string, options: Options = {}) {
    const model = IdSchema.parse(modelId);
    const id = IdSchema.parse(draftId);
    const response = this.#scope(TasksetDraftFileListSchema.parse(await this.#request(model, `/${encodeURIComponent(id)}/files`, "GET", undefined, options.signal)), model);
    if (response.draftId !== id) this.#mismatch();
    return response;
  }

  async readFile(modelId: string, draftId: string, path: string, options: Options = {}) {
    const model = IdSchema.parse(modelId);
    const id = IdSchema.parse(draftId);
    const relative = TasksetDraftFilePathSchema.parse(path);
    const response = this.#scope(TasksetDraftFileReadbackSchema.parse(await this.#request(model, `/${encodeURIComponent(id)}/file?path=${encodeURIComponent(relative)}`, "GET", undefined, options.signal)), model);
    if (response.draftId !== id || response.file.path !== relative) this.#mismatch();
    const bytes = decodeTasksetDraftFileContent(response.file.content);
    if (bytes.byteLength !== response.file.sizeBytes || sha256(bytes) !== response.file.contentHash) this.#mismatch();
    return response;
  }

  async saveFile(modelId: string, input: TasksetDraftFileMutation, options: Options = {}) {
    const model = IdSchema.parse(modelId);
    const request = TasksetDraftFileMutationSchema.parse(input);
    if (request.content) decodeTasksetDraftFileContent(request.content);
    return this.#draft(await this.#request(model, `/${encodeURIComponent(request.draftId)}/file`, "PUT", request, options.signal), model, request.draftId, request.expectedDraftRevision + 1);
  }

  async validate(modelId: string, draftId: string, input: TasksetDraftValidationRequest, options: Options = {}) {
    const model = IdSchema.parse(modelId);
    const id = IdSchema.parse(draftId);
    const request = TasksetDraftValidationRequestSchema.parse(input);
    const response = this.#scope(TasksetDraftValidationSchema.parse(await this.#request(model, `/${encodeURIComponent(id)}/validate`, "POST", request, options.signal)), model);
    if (response.draftId !== id || response.draftRevision !== request.expectedDraftRevision || response.workspaceHash !== request.expectedWorkspaceHash) this.#mismatch();
    return response;
  }

  async publish(modelId: string, draftId: string, input: TasksetDraftPublicationRequest, options: Options = {}) {
    const model = IdSchema.parse(modelId);
    const id = IdSchema.parse(draftId);
    const request = TasksetDraftPublicationRequestSchema.parse(input);
    const response = TasksetPackageReceiptSchema.parse(await this.#request(model, `/${encodeURIComponent(id)}/publish`, "POST", request, options.signal));
    if (response.teamId !== this.#options.teamId || response.modelProjectId !== model || response.operationId !== request.operationId
      || response.packageHash !== request.expectedPackageHash || !sameLearningRef(response.taskset, request.expectedTasksetRef) || response.selection !== "select") this.#mismatch();
    return response;
  }

  async delete(modelId: string, draftId: string, expectedDraftRevision: number, options: Options = {}) {
    const model = IdSchema.parse(modelId);
    const id = IdSchema.parse(draftId);
    const revision = RevisionSchema.parse(expectedDraftRevision);
    const response = this.#scope(TasksetDraftDeletionSchema.parse(await this.#request(model, `/${encodeURIComponent(id)}?expectedDraftRevision=${revision}`, "DELETE", undefined, options.signal)), model);
    if (response.draftId !== id || response.revision !== revision + 1) this.#mismatch();
    return response;
  }

  #scope<T extends { teamId: string; modelId: string }>(value: T, modelId: string): T {
    if (value.teamId !== this.#options.teamId || value.modelId !== modelId) this.#mismatch();
    return value;
  }
  #draft(input: unknown, modelId: string, draftId?: string, revision?: number) {
    const value = this.#scope(TasksetDraftReadbackSchema.parse(input), modelId);
    if ((draftId !== undefined && value.draft.id !== draftId) || (revision !== undefined && value.draft.revision !== revision)) this.#mismatch();
    return value;
  }
  #mismatch(): never { throw new OpenPondTasksetDraftError(502, "draft_response_mismatch", "Taskset draft response differs from the requested owner, revision or content."); }

  async #request(model: string, path: string, method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && new TextEncoder().encode(serialized).byteLength > MAX_TASKSET_DRAFT_WORKSPACE_BYTES) throw new OpenPondTasksetDraftError(413, "draft_too_large", "Taskset draft exceeds the 64 MiB envelope.");
    const response = await (this.#options.fetch ?? globalThis.fetch)(`${this.#options.baseUrl}/v1/models/${encodeURIComponent(model)}/taskset-drafts${path}`, {
      method, headers: { Authorization: `Bearer ${this.#options.apiKey}`, "X-OpenPond-Team-Id": this.#options.teamId, Accept: "application/json", ...(serialized ? { "Content-Type": "application/json" } : {}) },
      body: serialized, signal, redirect: "error",
    });
    const reader = response.body?.getReader();
    if (!reader) throw new OpenPondTasksetDraftError(response.status, "empty_response", "Taskset draft response was empty.");
    let bytes = 0;
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_TASKSET_DRAFT_WORKSPACE_BYTES) throw new OpenPondTasksetDraftError(413, "draft_too_large", "Taskset draft response exceeds the 64 MiB envelope.");
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel(); reader.releaseLock(); }
    const value: unknown = JSON.parse(text);
    if (!response.ok) {
      const error = z.object({ code: z.string(), message: z.string() }).safeParse(value);
      throw new OpenPondTasksetDraftError(response.status, error.success ? error.data.code : "draft_request_failed", error.success ? error.data.message : `Taskset draft request failed (${response.status}).`);
    }
    return value;
  }
}
