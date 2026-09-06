import { z } from "zod";
import {
  LearningCommandRequestSchema, LearningOperationResultSchema, LearningReadRequestSchema,
  TaskEvidenceInspectionResultSchema, sameLearningRef, type LearningRevisionRef,
  assertLearningRequestJson,
  learningResourceSchemas, type LearningCommand, type LearningOperationResult,
  type LearningResourceFor, type LearningResourceKind, type LearningResourcePage,
  type LearningResourceQuery, type TaskExampleSubmission, type TaskFeedbackSubmission,
} from "@openpond/evals/learning";
import { assertBoundedTaskJson } from "@openpond/evals/task-schema";

export * from "@openpond/evals/learning";
export * from "@openpond/evals/rewards";

export interface OpenPondLearningClientOptions {
  apiKey: string;
  baseUrl: string;
  /** Local profile or hosted team scope. The server checks the credential's ownership. */
  scope: string;
  fetch?: typeof globalThis.fetch;
}
export interface LearningRequestOptions { signal?: AbortSignal }
export const LearningBatchPublicationSchema = z.object({
  batchId: z.string().trim().min(1).max(500), modelProjectId: z.string().trim().min(1).max(500),
}).strict();
export const LearningBatchPublicationResultSchema = z.object({
  batchId: z.string().min(1), projectId: z.string().min(1), tasksetId: z.string().min(1),
  releaseId: z.string().min(1), revision: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export class OpenPondLearningError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: unknown) {
    super(message);
    this.name = "OpenPondLearningError";
  }
}

/** The same portable commands are sent to the local and hosted execution owner. */
export class OpenPondLearningClient {
  readonly #options: OpenPondLearningClientOptions;
  constructor(options: OpenPondLearningClientOptions) {
    if (!options.apiKey.trim() || !options.scope.trim()) throw new Error("Learning API key and scope are required.");
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Learning base URL must be an HTTP(S) endpoint without credentials, query, or fragment.");
    this.#options = { ...options, baseUrl: url.toString().replace(/\/+$/, "") };
  }

  async command(command: LearningCommand, options: LearningRequestOptions = {}): Promise<LearningOperationResult> {
    assertLearningRequestJson(command);
    const request = LearningCommandRequestSchema.parse({ scope: this.#options.scope, command });
    const result = LearningOperationResultSchema.parse(await this.#request("commands", request, options));
    if (result.operationId !== command.operationId) throw new OpenPondLearningError(502, "operation_identity_mismatch", "Learning response did not match the submitted operation.", null);
    return result;
  }

  submitExample(example: TaskExampleSubmission, options: LearningRequestOptions = {}) {
    return this.command({ action: "submit_example", operationId: example.idempotencyKey, example }, options);
  }

  submitFeedback(feedback: TaskFeedbackSubmission, options: LearningRequestOptions = {}) {
    return this.command({ action: "submit_feedback", operationId: feedback.idempotencyKey, feedback }, options);
  }

  async get<K extends LearningResourceKind>(kind: K, id: string, revision?: number, options: LearningRequestOptions = {}): Promise<LearningResourceFor<K>> {
    const request = LearningReadRequestSchema.parse({ action: "get", scope: this.#options.scope, kind, id, ...(revision === undefined ? {} : { revision }) });
    return learningResourceSchemas[kind].parse(await this.#request("read", request, options)) as LearningResourceFor<K>;
  }

  async inspectEvidence(evidence: LearningRevisionRef, options: LearningRequestOptions = {}) {
    const request = LearningReadRequestSchema.parse({ action: "inspect_evidence", scope: this.#options.scope, evidence });
    const result = TaskEvidenceInspectionResultSchema.parse(await this.#request("read", request, options));
    if (!sameLearningRef(result.evidence, evidence)) throw new OpenPondLearningError(502, "evidence_identity_mismatch", "Inspection did not match the requested evidence release.", null);
    return result;
  }

  async list<K extends LearningResourceKind>(kind: K, query: Partial<LearningResourceQuery> = {}, options: LearningRequestOptions = {}): Promise<LearningResourcePage<K>> {
    const request = LearningReadRequestSchema.parse({ action: "list", scope: this.#options.scope, kind, ...query });
    return z.object({ items: z.array(learningResourceSchemas[kind]).max(100), nextCursor: z.string().nullable() }).strict().parse(await this.#request("read", request, options)) as LearningResourcePage<K>;
  }

  /** Hosted publication only: stores an immutable package and attaches it, without starting training. */
  async publishBatch(input: z.infer<typeof LearningBatchPublicationSchema>, options: LearningRequestOptions = {}) {
    const request = LearningBatchPublicationSchema.parse(input);
    const result = LearningBatchPublicationResultSchema.parse(await this.#request("publish-batch", { ...request, scope: this.#options.scope }, options));
    if (result.batchId !== request.batchId) throw new OpenPondLearningError(502, "batch_identity_mismatch", "Published batch response did not match the requested batch.", null);
    return result;
  }

  async #request(endpoint: "commands" | "read" | "publish-batch", body: unknown, options: LearningRequestOptions): Promise<unknown> {
    assertBoundedTaskJson(body, 16_777_216);
    const response = await (this.#options.fetch ?? globalThis.fetch)(`${this.#options.baseUrl}/v1/learning/${endpoint}`, {
      method: "POST", headers: { Authorization: `Bearer ${this.#options.apiKey}`, "Content-Type": "application/json", Accept: "application/json", "X-OpenPond-Team-Id": this.#options.scope }, body: JSON.stringify(body), signal: options.signal,
      redirect: "error",
    });
    const payload = await readBoundedLearningResponse(response);
    if (!response.ok) {
      const error = z.object({ code: z.string().optional(), error: z.string().optional() }).passthrough().safeParse(payload);
      throw new OpenPondLearningError(response.status, error.success ? error.data.code ?? "learning_request_failed" : "learning_request_failed", error.success ? error.data.error ?? `Learning request failed (${response.status}).` : `Learning request failed (${response.status}).`, payload);
    }
    return payload;
  }
}

async function readBoundedLearningResponse(response: Response): Promise<unknown> {
  const maximumBytes = 16_777_216;
  const reader = response.body?.getReader();
  if (!reader) throw new OpenPondLearningError(response.status, "empty_response", "Learning response was empty.", null);
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) throw new OpenPondLearningError(response.status, "response_too_large", "Learning response exceeded 16 MiB; request a smaller page.", null);
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    assertBoundedTaskJson(value, maximumBytes);
    return value;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
