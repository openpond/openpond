import { z } from "zod";

export type ProductModelConnection = {
  baseUrl?: string;
  teamId?: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
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

/** Retained function arguments stay JSON text; recovery never executes tools. */
export const ProductModelToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function").default("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
}).passthrough();
export type ProductModelToolCall = z.infer<typeof ProductModelToolCallSchema>;

export const ProductModelUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
export const ProductModelChunkSchema = z.object({
  id: z.string(),
  model: z.string(),
  system_fingerprint: z.string().nullable().optional(),
  openpond: z.record(z.string(), z.json()).optional(),
  usage: ProductModelUsageSchema.nullable().optional(),
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
}).passthrough();

export const ProductModelRequestStatusSchema = z
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
    result: ProductModelChunkSchema.nullable(),
    failureCode: z.string().nullable(),
  })
  .strict();

export type ProductModelWireStatus = z.infer<typeof ProductModelRequestStatusSchema>;
export type ProductModelRequestIdentity = { requestId?: string; clientRequestId?: string };

/** The serving API resolves exactly one valid hosted-model prefix. Keep the
 * caller's named binding in results while checking the canonical wire name. */
export function canonicalResponseModelId(modelId: string) {
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

