/** Optional integration: AI SDK 7 / @ai-sdk/openai-compatible 3 (LanguageModelV4). */
import {
  createOpenAICompatible,
  type OpenAICompatibleChatLanguageModel,
} from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { ProductModelTransport } from "./product-model-transport.js";
import { ProductModel, ProductModelError, productModelEndpoint } from "./product-models.js";

const Evidence = z.object({ openpond: z.record(z.string(), z.json()) }).passthrough();
function metadata(raw: unknown) {
  const value = Evidence.safeParse(raw);
  return value.success ? { openpond: value.data.openpond } : undefined;
}

/** Use generateText/streamText with maxRetries: 0; paid inference is never safely replayable implicitly. */
export function toAIModel(
  model: ProductModel,
): Pick<
  OpenAICompatibleChatLanguageModel,
  "specificationVersion" | "provider" | "modelId" | "supportedUrls" | "doGenerate" | "doStream"
> {
  const connection = model.providerConnection();
  const transport = new ProductModelTransport(model.id, connection);
  const provider = createOpenAICompatible({
    name: "openpond",
    baseURL: productModelEndpoint(connection.baseUrl!),
    apiKey: connection.apiKey,
    // The personalized gateway always supplies terminal usage and rejects
    // OpenAI's optional stream_options field.
    includeUsage: false,
    headers: connection.teamId ? { "X-OpenPond-Team-Id": connection.teamId } : undefined,
    transformRequestBody: (raw) => {
      const body = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
      if (body.model !== model.id)
        throw new ProductModelError("model_override_forbidden", 0, false);
      const allowed = new Set([
        "model",
        "messages",
        "stream",
        "max_tokens",
        "temperature",
        "top_p",
        "seed",
        "stop",
        "tools",
        "tool_choice",
      ]);
      if (Object.keys(body).some((key) => !allowed.has(key)))
        throw new ProductModelError("parameter_unsupported", 0, false);
      return body;
    },
    metadataExtractor: {
      async extractMetadata({ parsedBody }) {
        return metadata(parsedBody);
      },
      createStreamExtractor() {
        let evidence: ReturnType<typeof metadata>;
        return {
          processChunk(chunk) {
            evidence = metadata(chunk) ?? evidence;
          },
          buildMetadata() {
            return evidence;
          },
        };
      },
    },
    supportsStructuredOutputs: model.capabilities.structuredOutput,
    fetch: async (url, init) => {
      // The provider only serializes/parses OpenAI-compatible payloads. All
      // submission, identity and pending observation belong to the shared wire
      // transport, including when this call asks for a stream.
      if (String(url) !== `${productModelEndpoint(connection.baseUrl!)}/chat/completions`
        || init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string")
        throw new ProductModelError("transport_override_forbidden", 0, false);
      const body = JSON.parse(init.body) as { stream?: boolean };
      return transport.request(init.body, { stream: body.stream === true,
        headers: init.headers, signal: init.signal });
    },
  }).chatModel(model.id);
  const check = (options: Parameters<typeof provider.doGenerate>[0]) => {
    const rawOptions = options.providerOptions?.openpond;
    if (rawOptions && ["stream", "stream_options"].some((key) => key in rawOptions))
      throw new ProductModelError("transport_override_forbidden", 0, false);
    if (options.tools?.length && !model.capabilities.tools)
      throw new ProductModelError("tools_unsupported", 0, false);
    if (options.responseFormat?.type === "json")
      throw new ProductModelError("structured_output_unsupported", 0, false);
    if (
      options.prompt.some(
        (message) =>
          (message.role === "tool" && !model.capabilities.tools) ||
          (message.role !== "system" &&
            message.content.some(
              (part) =>
                part.type !== "text" &&
                !(model.capabilities.tools && ["tool-call", "tool-result"].includes(part.type)),
            )),
      )
    )
      throw new ProductModelError("input_capability_unsupported", 0, false);
  };
  // Convert retryable transport errors to a terminal SDK error: AI SDK's default
  // automatic retries must not accidentally duplicate a billed generation.
  const normalizeError = (error: unknown, streamHeaders?: Record<string, string | undefined>): ProductModelError => {
    if (error instanceof ProductModelError) return error;
    if (
      error &&
      typeof error === "object" &&
      "cause" in error &&
      error.cause instanceof ProductModelError
    )
      return error.cause;
    const status =
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 0;
    const unknown =
      status === 0 || status === 408 || status >= 500 || (status >= 200 && status < 300);
    const responseHeaders = error && typeof error === "object" && "responseHeaders" in error
      && error.responseHeaders && typeof error.responseHeaders === "object"
      ? error.responseHeaders as Record<string, unknown> : streamHeaders ?? {};
    const requestId = responseHeaders["x-openpond-request-id"] ?? responseHeaders["x-request-id"];
    const clientRequestId = responseHeaders["x-openpond-client-request-id"];
    return new ProductModelError(
      status >= 400 ? "model_request_rejected" : "model_outcome_unknown",
      status,
      unknown,
      typeof requestId === "string" ? requestId : undefined,
      typeof clientRequestId === "string" ? clientRequestId : undefined,
    );
  };
  return {
    specificationVersion: provider.specificationVersion,
    provider: provider.provider,
    modelId: provider.modelId,
    supportedUrls: provider.supportedUrls,
    async doGenerate(options: Parameters<typeof provider.doGenerate>[0]) {
      check(options);
      try {
        return await provider.doGenerate(options);
      } catch (error) {
        throw normalizeError(error);
      }
    },
    async doStream(options: Parameters<typeof provider.doStream>[0]) {
      check(options);
      if (!model.capabilities.streaming)
        throw new ProductModelError("streaming_unsupported", 0, false);
      try {
        const result = await provider.doStream(options);
        const reader = result.stream.getReader();
        return {
          ...result,
          stream: new ReadableStream({
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  controller.close();
                  reader.releaseLock();
                } else
                  controller.enqueue(
                    value.type === "error"
                      ? { ...value, error: normalizeError(value.error, result.response?.headers) }
                      : value,
                  );
              } catch (error) {
                controller.error(normalizeError(error, result.response?.headers));
              }
            },
            async cancel(reason) {
              await reader.cancel(reason);
            },
          }),
        };
      } catch (error) {
        throw normalizeError(error);
      }
    },
  };
}
