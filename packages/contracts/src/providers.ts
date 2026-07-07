import { z } from "zod";

export const PROVIDER_IDS = [
  "openpond",
  "codex",
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "deepseek",
  "zai",
  "moonshot",
  "together",
  "groq",
  "fireworks",
  "custom-openai-compatible",
] as const;

export const ProviderIdSchema = z.enum(PROVIDER_IDS);

export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderLifecycleStatusSchema = z.enum([
  "active",
  "preview",
  "planned",
  "deprecated",
]);

export type ProviderLifecycleStatus = z.infer<
  typeof ProviderLifecycleStatusSchema
>;

export const ProviderCredentialModeSchema = z.enum([
  "openpond-account",
  "openpond-managed",
  "codex-login",
  "chatgpt-subscription",
  "local-byok",
  "hosted-byok",
  "custom",
]);

export type ProviderCredentialMode = z.infer<
  typeof ProviderCredentialModeSchema
>;

export const ProviderCredentialSourceSchema = z.enum([
  "none",
  "local_secret",
  "env",
  "openpond_account",
  "codex_login",
  "chatgpt_subscription",
  "hosted",
]);

export type ProviderCredentialSource = z.infer<
  typeof ProviderCredentialSourceSchema
>;

export const ProviderCredentialStatusSchema = z.object({
  connected: z.boolean().default(false),
  source: ProviderCredentialSourceSchema.default("none"),
  redacted: z.string().nullable().default(null),
  lastValidatedAt: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
});

export type ProviderCredentialStatus = z.infer<
  typeof ProviderCredentialStatusSchema
>;

export const ProviderRoutingSchema = z.object({
  hostedOpChat: z.boolean().default(false),
  localRuntime: z.boolean().default(true),
  localByok: z.boolean().default(false),
  hostedByok: z.boolean().default(false),
});

export type ProviderRouting = z.infer<typeof ProviderRoutingSchema>;

export const ProviderModelDiscoverySchema = z.enum([
  "hosted",
  "provider",
  "manual",
  "none",
]);

export type ProviderModelDiscovery = z.infer<
  typeof ProviderModelDiscoverySchema
>;

export const ProviderCapabilitiesSchema = z.object({
  chatCompletions: z.boolean().default(true),
  streaming: z.boolean().default(true),
  modelDiscovery: ProviderModelDiscoverySchema.default("none"),
  toolCalling: z.boolean().default(false),
  reasoning: z.boolean().default(false),
  imageInput: z.boolean().default(false),
  structuredOutput: z.boolean().default(false),
});

export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ProviderModelSourceSchema = z.enum([
  "hosted",
  "provider",
  "curated",
  "manual",
  "cache",
]);

export type ProviderModelSource = z.infer<typeof ProviderModelSourceSchema>;

export const ProviderModelCapabilitiesSchema = z.object({
  streaming: z.boolean().default(true),
  toolCalling: z.boolean().default(false),
  reasoning: z.boolean().default(false),
  vision: z.boolean().default(false),
  structuredOutput: z.boolean().default(false),
});

export type ProviderModelCapabilities = z.infer<
  typeof ProviderModelCapabilitiesSchema
>;

export const ProviderModelSchema = z.object({
  id: z.string().trim().min(1).max(300),
  providerId: ProviderIdSchema,
  displayName: z.string().trim().min(1).max(300),
  contextWindow: z.number().int().positive().nullable().default(null),
  outputLimit: z.number().int().positive().nullable().default(null),
  lifecycleStatus: ProviderLifecycleStatusSchema.default("active"),
  source: ProviderModelSourceSchema,
  capabilities: ProviderModelCapabilitiesSchema.default(() =>
    ProviderModelCapabilitiesSchema.parse({}),
  ),
  raw: z.record(z.string(), z.unknown()).optional(),
});

export type ProviderModel = z.infer<typeof ProviderModelSchema>;

export const ProviderModelCacheSchema = z.object({
  providerId: ProviderIdSchema,
  models: z.array(ProviderModelSchema).default([]),
  fetchedAt: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
  source: z.enum(["none", "hosted", "provider", "curated", "manual"]).default("none"),
});

export type ProviderModelCache = z.infer<typeof ProviderModelCacheSchema>;

export const ProviderConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().trim().min(1).max(2048).nullable().default(null),
  defaultModel: z.string().trim().min(1).max(300).nullable().default(null),
  modelOverrides: z.array(z.string().trim().min(1).max(300)).max(500).default([]),
  updatedAt: z.string().nullable().default(null),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ProviderConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().trim().min(1).max(2048).nullable().optional(),
  defaultModel: z.string().trim().min(1).max(300).nullable().optional(),
  modelOverrides: z
    .array(z.string().trim().min(1).max(300))
    .max(500)
    .optional(),
});

export type ProviderConfigPatch = z.infer<typeof ProviderConfigPatchSchema>;

export const ProviderCatalogModelSchema = z.object({
  id: z.string().trim().min(1).max(300),
  displayName: z.string().trim().min(1).max(300),
  contextWindow: z.number().int().positive().nullable().optional(),
  outputLimit: z.number().int().positive().nullable().optional(),
  lifecycleStatus: ProviderLifecycleStatusSchema.optional(),
  capabilities: ProviderModelCapabilitiesSchema.partial().optional(),
});

export type ProviderCatalogModel = z.infer<typeof ProviderCatalogModelSchema>;

export const ProviderCatalogProviderSchema = z.object({
  id: ProviderIdSchema,
  displayName: z.string().trim().min(1).max(160),
  lifecycleStatus: ProviderLifecycleStatusSchema.default("active"),
  credentialModes: z.array(ProviderCredentialModeSchema).default([]),
  routing: ProviderRoutingSchema,
  capabilities: ProviderCapabilitiesSchema,
  defaultEnabled: z.boolean().optional(),
  defaultBaseUrl: z.string().trim().min(1).max(2048).nullable().optional(),
  defaultModel: z.string().trim().min(1).max(300).nullable().optional(),
  modelCacheSource: z.enum(["none", "hosted", "provider", "curated", "manual"]),
  models: z.array(ProviderCatalogModelSchema).default([]),
});

export type ProviderCatalogProvider = z.infer<
  typeof ProviderCatalogProviderSchema
>;

export const ProviderCatalogSchema = z.object({
  version: z.literal(1).default(1),
  generatedAt: z.string().datetime(),
  providers: z.array(ProviderCatalogProviderSchema),
});

export type ProviderCatalog = z.infer<typeof ProviderCatalogSchema>;

export const ProviderStatusSchema = z.object({
  id: ProviderIdSchema,
  displayName: z.string().trim().min(1).max(160),
  lifecycleStatus: ProviderLifecycleStatusSchema.default("active"),
  credentialModes: z.array(ProviderCredentialModeSchema).default([]),
  routing: ProviderRoutingSchema.default(() => ProviderRoutingSchema.parse({})),
  capabilities: ProviderCapabilitiesSchema.default(() =>
    ProviderCapabilitiesSchema.parse({}),
  ),
  credential: ProviderCredentialStatusSchema.default(() =>
    ProviderCredentialStatusSchema.parse({}),
  ),
  enabled: z.boolean().default(false),
  available: z.boolean().default(false),
  defaultModel: z.string().trim().min(1).max(300).nullable().default(null),
  modelIds: z.array(z.string().trim().min(1).max(300)).max(1000).default([]),
  lastError: z.string().nullable().default(null),
});

export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const ProviderSettingsSchema = z.object({
  version: z.literal(1).default(1),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  statuses: z.record(z.string(), ProviderStatusSchema).default({}),
  modelCaches: z.record(z.string(), ProviderModelCacheSchema).default({}),
  updatedAt: z.string().nullable().default(null),
});

export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

export const ChatModelRefSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().trim().min(1).max(300),
});

export type ChatModelRef = z.infer<typeof ChatModelRefSchema>;

export const ProviderSettingsUpdateSchema = z.object({
  providers: z.record(z.string(), ProviderConfigPatchSchema).optional(),
});

export type ProviderSettingsUpdate = z.infer<
  typeof ProviderSettingsUpdateSchema
>;

export const ProviderCredentialWriteRequestSchema = z
  .object({
    source: z.enum(["local_secret", "env"]).default("local_secret"),
    value: z.string().min(1).max(20000).optional(),
    envVar: z.string().trim().min(1).max(160).optional(),
  })
  .superRefine((value, context) => {
    if (value.source === "env" && !value.envVar) {
      context.addIssue({
        code: "custom",
        path: ["envVar"],
        message: "envVar is required when provider credential source is env.",
      });
    }
    if (value.source === "local_secret" && !value.value) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "value is required when provider credential source is local_secret.",
      });
    }
  });

export type ProviderCredentialWriteRequest = z.infer<
  typeof ProviderCredentialWriteRequestSchema
>;

export const ProviderCredentialDeleteRequestSchema = z.object({
  source: z.enum(["local_secret", "env", "chatgpt_subscription"]).optional(),
});

export type ProviderCredentialDeleteRequest = z.infer<
  typeof ProviderCredentialDeleteRequestSchema
>;

export const ProviderValidationRequestSchema = z.object({
  modelId: z.string().trim().min(1).max(300).optional(),
  baseUrl: z.string().trim().min(1).max(2048).optional(),
});

export type ProviderValidationRequest = z.infer<
  typeof ProviderValidationRequestSchema
>;

export const ProviderModelsRequestSchema = z.object({
  query: z.string().trim().max(200).optional(),
  refresh: z.boolean().default(false),
  limit: z.number().int().positive().max(500).default(100),
});

export type ProviderModelsRequest = z.infer<typeof ProviderModelsRequestSchema>;

export const ProviderModelsRefreshRequestSchema = z.object({
  query: z.string().trim().max(200).optional(),
  force: z.boolean().default(false),
});

export type ProviderModelsRefreshRequest = z.infer<
  typeof ProviderModelsRefreshRequestSchema
>;
