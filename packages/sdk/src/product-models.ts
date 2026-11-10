import { DEFAULT_MODEL_BASE_URL } from "./endpoints.js";
import { z } from "zod";
import { readBoundedJsonResponse } from "./protocol.js";
import { ProductModelTransport } from "./product-model-transport.js";
import { ProductModelError, productModelEndpoint, ProductModelChunkSchema as Chunk,
  ProductModelUsageSchema as Usage, ProductModelToolCallSchema, type ProductModelToolCall, type ProductModelConnection,
  type ProductModelWireStatus } from "./product-model-wire.js";
export { ProductModelError, productModelEndpoint, type ProductModelConnection, type ProductModelToolCall } from "./product-model-wire.js";

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
export type ProductModels<Models> = {
  readonly [Name in keyof Models]: ProductModel;
};

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
export type ProductModelRecoveredResult = ProductModelResult & {
  /** Available only for explicitly tool-capable bindings; arguments remain JSON text. */
  toolCalls?: ProductModelToolCall[];
};
export type ProductModelRequestStatus = Omit<ProductModelWireStatus, "result"> & {
  result: ProductModelRecoveredResult | null;
};

/** A named text model. This never resolves a catalogue default or activates serving. */
export class ProductModel {
  readonly id: string;
  readonly capabilities: Required<
    NonNullable<ProductModelBinding["capabilities"]>
  >;
  private readonly transport: ProductModelTransport;
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
    this.transport = new ProductModelTransport(this.id, this.connection);
  }
  /** Provider integrations use the same exact destination and transport. */
  providerConnection(): Readonly<ProductModelConnection> {
    return { ...this.connection };
  }
  private async request(
    input: ProductModelInput,
    stream: boolean,
  ): Promise<Response> {
    if (stream && !this.capabilities.streaming)
      throw new ProductModelError("streaming_unsupported", 0, false);
    const { signal, clientRequestId: suppliedClientId, ...raw } = input;
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
    return this.transport.request(body, { stream, signal, clientRequestId: suppliedClientId });
  }
  async generate(input: ProductModelInput): Promise<ProductModelResult> {
    const response = await this.request(input, false);
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
        this.transport.identity(response).clientRequestId,
      );
    }
  }
  /** Read only: a timeout never submits another paid operation. */
  async inspectRequest(requestId: string): Promise<ProductModelRequestStatus> {
    return this.projectStatus(await this.transport.inspectRequest(requestId));
  }
  async recover(clientRequestId: string): Promise<ProductModelRequestStatus> {
    return this.projectStatus(await this.transport.recover(clientRequestId));
  }
  private projectStatus(status: ProductModelWireStatus): ProductModelRequestStatus {
    if (!status.result) return { ...status, result: null };
    const message = status.result.choices[0]!.message!;
    let toolCalls: ProductModelToolCall[] | undefined;
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
      const parsed = z.array(ProductModelToolCallSchema).safeParse(message.tool_calls);
      if (!this.capabilities.tools || !parsed.success)
        throw new ProductModelError("model_response_invalid", 200, true, status.requestId,
          status.clientRequestId ?? undefined);
      toolCalls = parsed.data;
    }
    return { ...status, result: {
      ...this.result(status.result, message.content ?? "",
        status.result.choices[0]!.finish_reason ?? null, new Response(null)),
      ...(toolCalls === undefined ? {} : { toolCalls }),
    } };
  }
  /** Explicit cancellation retains the original request's cleanup owner. */
  async cancelRequest(requestId: string): Promise<void> {
    await this.transport.cancelRequest(requestId);
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
        this.transport.identity(response).clientRequestId,
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
        this.transport.identity(response).clientRequestId,
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
