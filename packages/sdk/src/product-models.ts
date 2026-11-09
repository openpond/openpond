import { DEFAULT_MODEL_BASE_URL } from "./endpoints.js";
import { z } from "zod";
import { readBoundedJsonResponse } from "./protocol.js";

export type ProductModelBinding = {
  id: string;
  capabilities?: {
    streaming?: boolean;
    tools?: boolean;
    structuredOutput?: false;
  };
};
export type ProductModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
export type ProductModelInput = {
  prompt?: string;
  messages?: ProductModelMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Stable original operation identity for inspect/recover; never authorizes a replay. */
  clientRequestId?: string;
};
export type ProductModelUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};
export type ProductModelResult = {
  text: string;
  requestId: string;
  modelId: string;
  resolvedModelId: string;
  finishReason: string | null;
  usage: ProductModelUsage | null;
  systemFingerprint: string | null;
  /** Retained server evidence; presence alone is not client-side verification. */
  evidence: Record<string, unknown> | null;
};
export type ProductModelEvent =
  | { type: "text"; text: string }
  | { type: "finish"; result: ProductModelResult };
export type ProductModelConnection = {
  baseUrl?: string;
  teamId?: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};
export type ProductModels<Models> = {
  readonly [Name in keyof Models]: ProductModel;
};

export class ProductModelError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly outcomeUnknown: boolean,
    readonly requestId?: string,
    readonly clientRequestId?: string,
  ) {
    super(`OpenPond model request failed (${code}).`);
    this.name = "ProductModelError";
  }
}
const Message = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().max(200_000),
  })
  .strict();
const Input = z
  .object({
    prompt: z.string().max(200_000).optional(),
    messages: z.array(Message).min(1).max(128).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(4096).optional(),
  })
  .strict()
  .refine(
    (v) => (v.prompt !== undefined) !== (v.messages !== undefined),
    "Supply prompt or messages, exclusively.",
  );
const Usage = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
const Chunk = z.object({
  id: z.string(),
  model: z.string(),
  system_fingerprint: z.string().nullable().optional(),
  openpond: z.record(z.string(), z.json()).optional(),
  usage: Usage.nullable().optional(),
  choices: z
    .array(
      z.object({
        index: z.number().int(),
        finish_reason: z.string().nullable().optional(),
        delta: z
          .object({
            content: z.string().nullable().optional(),
            tool_calls: z.unknown().optional(),
          })
          .passthrough()
          .optional(),
        message: z
          .object({
            content: z.string().nullable(),
            tool_calls: z.unknown().optional(),
          })
          .passthrough()
          .optional(),
      }),
    )
    .max(1),
});

const ProductModelRequestStatusSchema = z
  .object({
    schemaVersion: z.literal("openpond.modelRequestStatus.v1"),
    requestId: z.string().regex(/^pinf_[A-Za-z0-9-]{8,191}$/),
    clientRequestId: z.uuid().nullable(),
    modelId: z.string(),
    state: z.enum([
      "pending",
      "running",
      "stopping",
      "completed",
      "failed",
      "cancelled",
    ]),
    deadlineAt: z.iso.datetime(),
    retryAt: z.iso.datetime().nullable(),
    result: Chunk.nullable(),
    failureCode: z.string().nullable(),
  })
  .strict();
export type ProductModelRequestStatus = Omit<
  z.infer<typeof ProductModelRequestStatusSchema>,
  "result"
> & { result: ProductModelResult | null };
type RequestIdentity = { requestId?: string; clientRequestId?: string };
const RequestId = ProductModelRequestStatusSchema.shape.requestId;

/** The serving API resolves exactly one valid hosted-model prefix. Keep the
 * caller's named binding in results while checking the canonical wire name. */
function canonicalResponseModelId(modelId: string) {
  const name = modelId.startsWith("personalized:")
    ? modelId.slice("personalized:".length)
    : null;
  return name && /^[a-z0-9][a-z0-9._:-]{2,127}$/.test(name) ? name : modelId;
}

export function productModelEndpoint(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("A clean serving base URL is required.");
  return url.href.replace(/\/$/, "");
}

/** A named text model. This never resolves a catalogue default or activates serving. */
export class ProductModel {
  readonly id: string;
  readonly capabilities: Required<
    NonNullable<ProductModelBinding["capabilities"]>
  >;
  constructor(
    binding: string | ProductModelBinding,
    private readonly connection: ProductModelConnection,
  ) {
    this.id = z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._:-]{2,127}$/)
      .parse(typeof binding === "string" ? binding : binding.id);
    this.capabilities = {
      streaming: true,
      tools: false,
      structuredOutput: false,
      ...(typeof binding === "string" ? {} : binding.capabilities),
    };
    if (!connection.apiKey.trim())
      throw new Error("Named models require an API key.");
    this.connection = {
      ...connection,
      baseUrl: productModelEndpoint(
        connection.baseUrl ?? DEFAULT_MODEL_BASE_URL,
      ),
    };
    if (
      connection.timeoutMs !== undefined &&
      (!Number.isFinite(connection.timeoutMs) ||
        connection.timeoutMs <= 0 ||
        connection.timeoutMs > 630_000)
    )
      throw new Error(
        "Serving timeoutMs must be greater than zero and at most 630000.",
      );
  }
  /** Provider integrations use the same exact destination and transport. */
  providerConnection(): Readonly<ProductModelConnection> {
    return { ...this.connection };
  }
  private readonly clientRequestIds = new WeakMap<Response, string>();
  private readonly observers = new WeakMap<
    Response,
    { until: number; signal?: AbortSignal }
  >();
  private async request(
    input: ProductModelInput,
    stream: boolean,
  ): Promise<Response> {
    if (stream && !this.capabilities.streaming)
      throw new ProductModelError("streaming_unsupported", 0, false);
    const { signal, clientRequestId: suppliedClientId, ...raw } = input;
    const clientRequestId = z
      .uuid()
      .parse(suppliedClientId ?? crypto.randomUUID());
    const parsed = Input.parse(raw);
    const body = JSON.stringify({
      model: this.id,
      messages: parsed.messages ?? [{ role: "user", content: parsed.prompt }],
      ...(parsed.temperature === undefined
        ? {}
        : { temperature: parsed.temperature }),
      ...(parsed.maxTokens === undefined
        ? {}
        : { max_tokens: parsed.maxTokens }),
      stream,
    });
    if (new TextEncoder().encode(body).length > 1024 * 1024)
      throw new ProductModelError("payload_too_large", 0, false);
    const timeoutMs = this.connection.timeoutMs ?? 630_000;
    const until = Date.now() + timeoutMs;
    const deadline = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await (this.connection.fetch ?? fetch)(
        `${productModelEndpoint(this.connection.baseUrl!)}/chat/completions`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.connection.apiKey}`,
            ...(this.connection.teamId
              ? { "X-OpenPond-Team-Id": this.connection.teamId }
              : {}),
            "Content-Type": "application/json",
            "X-OpenPond-Client-Request-Id": clientRequestId,
            Accept: stream ? "text/event-stream" : "application/json",
          },
          body,
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        },
      );
    } catch {
      throw new ProductModelError(
        "model_outcome_unknown",
        0,
        true,
        undefined,
        clientRequestId,
      );
    }
    this.clientRequestIds.set(response, clientRequestId);
    this.observers.set(response, { until, signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProductModelError(
        "model_request_rejected",
        response.status,
        response.status >= 500,
        response.headers.get("x-openpond-request-id") ??
          response.headers.get("x-request-id") ??
          undefined,
        this.clientRequestIds.get(response),
      );
    }
    return response;
  }
  async generate(input: ProductModelInput): Promise<ProductModelResult> {
    const response = await this.request(input, false);
    if (response.status === 202) return this.observePending(response);
    try {
      const chunk = Chunk.parse(
        await readBoundedJsonResponse(
          response,
          8 * 1024 * 1024,
          "Model result",
        ),
      );
      if (
        chunk.choices.length !== 1 ||
        !chunk.choices[0].message ||
        chunk.choices[0].message.tool_calls
      )
        throw new Error("Unsupported response");
      return this.result(
        chunk,
        chunk.choices[0].message.content ?? "",
        chunk.choices[0].finish_reason ?? null,
        response,
      );
    } catch {
      throw new ProductModelError(
        "model_response_invalid",
        response.status,
        true,
        response.headers.get("x-openpond-request-id") ??
          response.headers.get("x-request-id") ??
          undefined,
        this.clientRequestIds.get(response),
      );
    }
  }
  /** Read only: a timeout never submits another paid operation. */
  async inspectRequest(requestId: string): Promise<ProductModelRequestStatus> {
    const id = RequestId.parse(requestId);
    return this.readRequestStatus(`/${encodeURIComponent(id)}`, {
      requestId: id,
    });
  }
  async recover(clientRequestId: string): Promise<ProductModelRequestStatus> {
    const id = z.uuid().parse(clientRequestId);
    return this.readRequestStatus(
      `?clientRequestId=${encodeURIComponent(id)}`,
      { clientRequestId: id },
    );
  }
  private async readRequestStatus(
    suffix: string,
    expected: RequestIdentity,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<ProductModelRequestStatus> {
    const response = await (this.connection.fetch ?? fetch)(
      `${productModelEndpoint(this.connection.baseUrl!)}/chat/completions${suffix}`,
      {
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.connection.apiKey}`,
          ...(this.connection.teamId
            ? { "X-OpenPond-Team-Id": this.connection.teamId }
            : {}),
          Accept: "application/json",
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProductModelError(
        "model_status_unavailable",
        response.status,
        false,
      );
    }
    return this.requestStatus(
      await readBoundedJsonResponse(response, 8 * 1024 * 1024, "Model status"),
      response,
      expected,
    );
  }
  private requestStatus(
    raw: unknown,
    response: Response,
    expected: RequestIdentity,
  ): ProductModelRequestStatus {
    const status = ProductModelRequestStatusSchema.parse(raw);
    if (
      status.modelId !== canonicalResponseModelId(this.id) ||
      (expected.requestId !== undefined &&
        status.requestId !== expected.requestId) ||
      (expected.clientRequestId !== undefined &&
        status.clientRequestId !== expected.clientRequestId)
    )
      throw new ProductModelError(
        "model_recovery_identity_changed",
        409,
        true,
        expected.requestId,
        expected.clientRequestId,
      );
    if (
      status.result &&
      (status.state !== "completed" ||
        status.failureCode !== null ||
        status.result.id !== status.requestId ||
        status.result.model !== status.modelId ||
        status.result.choices.length !== 1 ||
        status.result.choices[0]?.index !== 0 ||
        !status.result.choices[0]?.message ||
        status.result.choices[0]?.message.tool_calls)
    )
      throw new ProductModelError(
        "model_response_invalid",
        response.status,
        true,
        status.requestId,
        expected.clientRequestId ?? status.clientRequestId ?? undefined,
      );
    return {
      ...status,
      result: status.result
        ? {
            ...this.result(
              status.result,
              status.result.choices[0]?.message?.content ?? "",
              status.result.choices[0]?.finish_reason ?? null,
              response,
            ),
            requestId: status.requestId,
          }
        : null,
    };
  }
  private async observePending(
    response: Response,
  ): Promise<ProductModelResult> {
    const clientRequestId = this.clientRequestIds.get(response);
    let status: ProductModelRequestStatus;
    try {
      status = this.requestStatus(
        await readBoundedJsonResponse(
          response,
          8 * 1024 * 1024,
          "Pending model request",
        ),
        response,
        { clientRequestId },
      );
    } catch (error) {
      if (error instanceof ProductModelError) throw error;
      throw new ProductModelError(
        "model_outcome_unknown",
        202,
        true,
        undefined,
        clientRequestId,
      );
    }
    const expected = { requestId: status.requestId, clientRequestId };
    const observer = this.observers.get(response)!;
    const until = Math.min(
      observer.until,
      Date.parse(status.deadlineAt) + 30_000,
    );
    for (;;) {
      if (status.result && status.state === "completed") return status.result;
      if (status.state === "completed")
        throw new ProductModelError(
          "model_result_not_retained",
          200,
          false,
          status.requestId,
          status.clientRequestId ?? undefined,
        );
      if (["failed", "cancelled"].includes(status.state))
        throw new ProductModelError(
          status.failureCode ?? "model_request_failed",
          200,
          false,
          status.requestId,
          status.clientRequestId ?? undefined,
        );
      if (Date.now() >= until || observer.signal?.aborted)
        throw new ProductModelError(
          "model_outcome_unknown",
          202,
          true,
          status.requestId,
          status.clientRequestId ?? undefined,
        );
      const delay = Math.min(
        until - Date.now(),
        Math.max(
          500,
          Math.min(
            15_000,
            status.retryAt ? Date.parse(status.retryAt) - Date.now() : 2_000,
          ),
        ),
      );
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(
            new ProductModelError(
              "model_outcome_unknown",
              202,
              true,
              status.requestId,
              status.clientRequestId ?? undefined,
            ),
          );
        };
        const timer = setTimeout(() => {
          observer.signal?.removeEventListener("abort", abort);
          resolve();
        }, delay);
        observer.signal?.addEventListener("abort", abort, { once: true });
        if (observer.signal?.aborted) abort();
      });
      try {
        status = await this.readRequestStatus(
          `/${encodeURIComponent(expected.requestId)}`,
          expected,
          Math.max(1, Math.min(30_000, until - Date.now())),
          observer.signal,
        );
      } catch (error) {
        throw new ProductModelError(
          "model_outcome_unknown",
          202,
          true,
          status.requestId,
          status.clientRequestId ?? undefined,
        );
      }
    }
  }
  /** Explicit cancellation retains the original request's cleanup owner. */
  async cancelRequest(requestId: string): Promise<void> {
    const id = RequestId.parse(requestId);
    const response = await (this.connection.fetch ?? fetch)(
      `${productModelEndpoint(this.connection.baseUrl!)}/chat/completions/${encodeURIComponent(id)}/cancel`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.connection.apiKey}`,
          ...(this.connection.teamId
            ? { "X-OpenPond-Team-Id": this.connection.teamId }
            : {}),
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    await response.body?.cancel();
    if (!response.ok)
      throw new ProductModelError(
        "model_cancel_pending",
        response.status,
        true,
        id,
      );
  }
  private result(
    chunk: z.infer<typeof Chunk>,
    text: string,
    finishReason: string | null,
    response: Response,
  ): ProductModelResult {
    return {
      text,
      requestId:
        response.headers.get("x-openpond-request-id") ??
        response.headers.get("x-request-id") ??
        chunk.id,
      modelId: this.id,
      resolvedModelId: chunk.model,
      finishReason,
      usage: chunk.usage
        ? {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          }
        : null,
      systemFingerprint: chunk.system_fingerprint ?? null,
      evidence: chunk.openpond ?? null,
    };
  }
  /** Breaking iteration cancels the HTTP body. A truncated stream never produces finish. */
  async *stream(input: ProductModelInput): AsyncGenerator<ProductModelEvent> {
    const response = await this.request(input, true);
    if (response.status === 202) {
      const result = await this.observePending(response);
      if (result.text) yield { type: "text", text: result.text };
      yield { type: "finish", result };
      return;
    }
    if (
      !response.headers.get("content-type")?.includes("text/event-stream") ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new ProductModelError(
        "model_stream_invalid",
        response.status,
        true,
        response.headers.get("x-openpond-request-id") ?? undefined,
        this.clientRequestIds.get(response),
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "",
      text = "",
      finish: string | null = null,
      last: z.infer<typeof Chunk> | undefined;
    let usage: z.infer<typeof Usage> | null = null;
    let outputBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer = (buffer + decoder.decode(value, { stream: !done })).replace(
          /\r\n/g,
          "\n",
        );
        if (new TextEncoder().encode(buffer).length > 1024 * 1024)
          throw new Error("Stream frame too large");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          if (data === "[DONE]") {
            if (!last || !finish) throw new Error("Incomplete stream");
            yield {
              type: "finish",
              result: this.result({ ...last, usage }, text, finish, response),
            };
            return;
          }
          const chunk = Chunk.parse(JSON.parse(data));
          if (last && (last.id !== chunk.id || last.model !== chunk.model))
            throw new Error("Stream identity changed");
          last = chunk;
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices[0];
          if (choice?.delta?.tool_calls)
            throw new Error("Tool output unsupported by text API");
          if (choice?.finish_reason) finish = choice.finish_reason;
          const delta = choice?.delta?.content;
          if (delta) {
            text += delta;
            outputBytes += new TextEncoder().encode(delta).length;
            if (outputBytes > 8 * 1024 * 1024)
              throw new Error("Model output too large");
            yield { type: "text", text: delta };
          }
        }
        if (done) throw new Error("Stream ended before DONE");
      }
    } catch (error) {
      if (error instanceof ProductModelError) throw error;
      throw new ProductModelError(
        "model_stream_interrupted",
        response.status,
        true,
        response.headers.get("x-openpond-request-id") ??
          response.headers.get("x-request-id") ??
          undefined,
        this.clientRequestIds.get(response),
      );
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
export function createProductModels<
  const Models extends Record<string, string | ProductModelBinding>,
>(bindings: Models, connection: ProductModelConnection): ProductModels<Models> {
  return Object.fromEntries(
    Object.entries(bindings).map(([name, binding]) => [
      name,
      new ProductModel(binding, connection),
    ]),
  ) as ProductModels<Models>;
}
