import http from "node:http";
import { z } from "zod";
import { ChatModelRefSchema } from "@openpond/contracts";
import type { TasksetWorkModelStream } from "./taskset-work-attempt-types.js";
import type { createTrainingModelRuntime } from "./training-model-runtime.js";

export const HostedAdvancedBridgeSchema = z
  .object({
    socketPath: z.string().min(1).max(1000),
    capability: z.string().regex(/^[a-f0-9]{64}$/),
    jobId: z.string().min(1),
    pinHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const HostedAdvancedModelRequestSchema = z
  .object({
    jobId: z.string().min(1),
    pinHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: z.string().min(1).max(500),
    model: ChatModelRefSchema,
    reasoningEffort: z
      .enum(["off", "low", "medium", "high", "xhigh", "max", "none"])
      .nullable(),
    messages: z.array(z.unknown()).min(1).max(1000),
    tools: z.array(z.unknown()).max(100),
    toolChoice: z.unknown(),
    maxOutputTokens: z.number().int().positive().max(131072),
    temperature: z.number().finite().optional(),
    topP: z.number().finite().optional(),
    seed: z.number().int().optional(),
  })
  .strict();
const Continuation = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("chat_completions_reasoning"),
      reasoningContent: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("responses_reasoning_items"),
      items: z.array(z.record(z.string(), z.unknown())),
    })
    .strict(),
]);
const ToolCall = z
  .object({
    id: z.string().optional(),
    type: z.string(),
    function: z
      .object({ name: z.string().optional(), arguments: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const Delta = z
  .object({
    text: z.string().optional(),
    usage: z.unknown().optional(),
    costUsd: z.number().finite().nonnegative().optional(),
    continuation: Continuation.optional(),
    toolCalls: z.array(ToolCall).optional(),
  })
  .strict();
/** The socket is a private host capability outside every Work mount. The child
 * receives no provider token and cannot turn a source-only pin into a grant. */
export function createHostedAdvancedModelBridge(
  raw: unknown,
  signal: AbortSignal,
) {
  const bridge = HostedAdvancedBridgeSchema.parse(raw);
  async function call(
    action: "authorize" | "ceiling" | "model" | "compute" | "checkpoint",
    value: unknown,
    callSignal = signal,
  ): Promise<unknown> {
    callSignal.throwIfAborted();
    const bytes = Buffer.from(
      JSON.stringify({
        action,
        jobId: bridge.jobId,
        pinHash: bridge.pinHash,
        value,
      }),
    );
    if (bytes.length > 8 * 1024 * 1024)
      throw new Error(
        "Hosted advanced request exceeds its private byte limit.",
      );
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: bridge.socketPath,
          path: "/",
          method: "POST",
          headers: {
            authorization: `Bearer ${bridge.capability}`,
            "content-type": "application/json",
            "content-length": bytes.length,
          },
          signal: callSignal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > 8 * 1024 * 1024) {
              response.destroy(
                new Error(
                  "Hosted advanced response exceeds its private byte limit.",
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (response.statusCode !== 200)
                throw new Error(
                  typeof value?.error === "string"
                    ? value.error
                    : "The actual hosted advanced owner refused this operation.",
                );
              resolve(value);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("error", reject);
      request.end(bytes);
    });
  }
  const stream: TasksetWorkModelStream = async function* (input) {
    const value = HostedAdvancedModelRequestSchema.parse({
      jobId: bridge.jobId,
      pinHash: bridge.pinHash,
      requestId: input.requestId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      messages: input.messages,
      tools: input.tools,
      toolChoice: input.toolChoice,
      maxOutputTokens: input.maxOutputTokens ?? 4096,
      ...(input.temperature === undefined
        ? {}
        : { temperature: input.temperature }),
      ...(input.topP === undefined ? {} : { topP: input.topP }),
      ...(input.seed === undefined ? {} : { seed: input.seed }),
    });
    const response = z
      .object({ deltas: z.array(Delta).max(100000) })
      .strict()
      .parse(
        await call("model", value, AbortSignal.any([signal, input.signal])),
      );
    // Parse through the existing taskset stream contract at its private owner;
    // arbitrary tool/continuation values still go through the canonical runner.
    for (const delta of response.deltas) yield delta;
  };
  const text: ReturnType<
    typeof createTrainingModelRuntime
  >["trainingModelText"] = async (input) => {
    let text = "";
    for await (const delta of stream({
      ...input,
      reasoningEffort: input.reasoningEffort ?? null,
      tools: [],
      toolChoice: "none",
    })) {
      if (delta.text) text += delta.text;
      if (delta.usage !== undefined)
        input.onUsage?.(delta.usage, delta.costUsd);
    }
    return text;
  };
  return {
    stream,
    text,
    authorize: async () => {
      await call("authorize", {});
    },
    ceiling: async (
      modelId: string,
      pricing: unknown,
      maximumOutputTokens: number,
    ) =>
      z
        .object({
          configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
          maximumChargeUsd: z.number().finite().positive(),
        })
        .strict()
        .parse(
          await call("ceiling", { modelId, pricing, maximumOutputTokens }),
        ),
    compute: (value: unknown, cleanup = false) =>
      call("compute", value, cleanup ? AbortSignal.timeout(60000) : signal),
    checkpoint: (value: unknown) => call("checkpoint", value),
  };
}
