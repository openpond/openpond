import { z } from "zod";

const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return (url.protocol === "https:" || (local && url.protocol === "http:")) &&
    !url.username && !url.password && !url.search && !url.hash;
}, "Use HTTPS (or loopback HTTP), without embedded credentials, query or fragment");

/** Public deployment configuration. Service credentials arrive per authorized request. */
const commonConfig = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().min(0).max(65535).default(3000),
  authTokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(180_000),
  maxConcurrentRequests: z.number().int().min(1).max(4).default(1),
}).strict();
const externalConfig = commonConfig.extend({
  mode: z.literal("external").default("external"),
  modelEndpoint: endpoint,
  model: z.string().min(1).max(200),
  sandboxEndpoint: endpoint.refine(value => new URL(value).pathname.replace(/\/$/, "").endsWith("/sandboxes")),
  sandboxId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  sandboxTeamId: z.string().min(1).max(128),
});
const embeddedConfig = commonConfig.extend({
  mode: z.literal("embedded"),
  model: z.literal("smollm2-135m-instruct").default("smollm2-135m-instruct"),
  contextTokens: z.literal(4096).default(4096),
  maxConcurrentRequests: z.literal(1).default(1),
  requestTimeoutMs: z.number().int().min(1_000).max(300_000).default(300_000),
});
export const configSchema = z.union([externalConfig, embeddedConfig]);
export type Config = z.infer<typeof configSchema>;
export type ExternalConfig = z.infer<typeof externalConfig>;
export type EmbeddedConfig = z.infer<typeof embeddedConfig>;

const credential = z.string().min(1).max(16_384).refine(value => !/[\r\n]/.test(value));
export const chatSchema = z.object({
  prompt: z.string().trim().min(1).max(16_384),
  credentials: z.object({ modelApiKey: credential, sandboxApiKey: credential }).strict(),
}).strict();
// Leave room for the real harness instructions and 256 generated tokens, including
// non-ASCII input whose tokenizer cost can approach one token per UTF-8 byte.
export const embeddedChatSchema = z.object({
  prompt: z.string().trim().min(1).refine(value => Buffer.byteLength(value, "utf8") <= 1024, "Prompt exceeds 1024 UTF-8 bytes"),
}).strict();
export type ExternalChatInput = z.infer<typeof chatSchema>;
export type ChatInput = ExternalChatInput | z.infer<typeof embeddedChatSchema>;

export class ExampleError extends Error {
  constructor(readonly code: string, readonly status = 502) { super(code); }
}
