import { z } from "zod";

export const EnclaveHealthSchema = z.object({
  status: z.literal("healthy"), runtime: z.literal("openpond-app-server"), inference: z.literal("embedded"),
  model: z.string(), contextTokens: z.number().int().positive(), persistentHistory: z.literal(false),
});
export type EnclaveHealth = z.infer<typeof EnclaveHealthSchema>;
export const EnclaveReplySchema = z.object({
  requestId: z.string(), answer: z.string().max(65536), threadId: z.string(), turnId: z.string(), tools: z.array(z.unknown()).max(0),
});
export type EnclaveReply = z.infer<typeof EnclaveReplySchema>;
export const EnclavePromptSchema = z.object({ prompt: z.string().trim().min(1).refine((text) => new TextEncoder().encode(text).length <= 1024, "Use at most 1,024 bytes per message.") }).strict();
export const UrlModelSchema = z.object({
  id: z.string(), name: z.string(), providerName: z.string(), endpoint: z.string(), model: z.string(),
  protocol: z.enum(["openai", "tvc"]), hasToken: z.boolean(),
});
export type UrlModel = z.infer<typeof UrlModelSchema>;
export type UrlModelInspection = { protocol: "openai" | "tvc"; models: string[]; contextTokens?: number };
