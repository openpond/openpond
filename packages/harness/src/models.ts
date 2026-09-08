import { z } from "zod";

import { ReleaseHashSchema, ReleaseIdSchema } from "./common.js";

export const ModelRefSchema = z.object({
  provider: ReleaseIdSchema,
  model: ReleaseIdSchema,
  revision: z.string().trim().min(1).max(500).nullable().default(null),
  artifactHash: ReleaseHashSchema.nullable().default(null),
  tokenizerRevision: z.string().trim().min(1).max(500).nullable().default(null),
  chatTemplateHash: ReleaseHashSchema.nullable().default(null),
}).strict();

export type ModelRef = z.infer<typeof ModelRefSchema>;

export const PROVIDER_IDS = [
  "openpond",
  "codex",
  "anthropic",
  "openai",
  "xai",
  "google",
  "openrouter",
  "deepseek",
  "zai",
  "moonshot",
  "together",
  "groq",
  "custom-openai-compatible",
] as const;

export const ProviderIdSchema = z.enum(PROVIDER_IDS);

export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ChatModelRefSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().trim().min(1).max(300),
});

export type ChatModelRef = z.infer<typeof ChatModelRefSchema>;
