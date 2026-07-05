import {
  PROVIDER_IDS,
  ProviderCapabilitiesSchema,
  ProviderCatalogProviderSchema,
  ProviderConfigSchema,
  ProviderCredentialStatusSchema,
  ProviderIdSchema,
  ProviderModelCacheSchema,
  ProviderModelSchema,
  ProviderModelsRefreshRequestSchema,
  ProviderModelsRequestSchema,
  ProviderSettingsSchema,
  ProviderStatusSchema,
  ProviderValidationRequestSchema,
  type AccountState,
  type CodexStatus,
  type ProviderCatalog,
  type ProviderCatalogProvider,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderCredentialMode,
  type ProviderCredentialSource,
  type ProviderId,
  type ProviderLifecycleStatus,
  type ProviderModel,
  type ProviderModelCache,
  type ProviderModelCapabilities,
  type ProviderModelDiscovery,
  type ProviderModelsRefreshRequest,
  type ProviderModelsRequest,
  type ProviderRouting,
  type ProviderSettings,
  type ProviderStatus,
  type ProviderValidationRequest,
} from "@openpond/contracts";
import type { ProvidersFile } from "../types.js";
import type { ProviderSecretRecord, ProviderSecrets } from "./provider-secrets.js";

type ProviderPresetModel = {
  id: string;
  displayName: string;
  contextWindow?: number | null;
  outputLimit?: number | null;
  lifecycleStatus?: ProviderLifecycleStatus;
  capabilities?: Partial<ProviderModelCapabilities>;
};

type ServerProviderPreset = {
  id: ProviderId;
  displayName: string;
  lifecycleStatus?: ProviderLifecycleStatus;
  credentialModes: ProviderCredentialMode[];
  routing: Partial<ProviderRouting>;
  capabilities: Partial<ProviderCapabilities> & {
    modelDiscovery?: ProviderModelDiscovery;
  };
  defaultEnabled?: boolean;
  defaultBaseUrl?: string | null;
  defaultModel?: string | null;
  modelCacheSource: ProviderModelCache["source"];
  models: readonly ProviderPresetModel[];
};

const COMMON_OPENAI_COMPATIBLE_MODELS: Partial<ProviderModelCapabilities> = {
  streaming: true,
  toolCalling: true,
  structuredOutput: true,
};

const REASONING_MODEL_CAPABILITIES: Partial<ProviderModelCapabilities> = {
  ...COMMON_OPENAI_COMPATIBLE_MODELS,
  reasoning: true,
};

const VISION_REASONING_MODEL_CAPABILITIES: Partial<ProviderModelCapabilities> = {
  ...REASONING_MODEL_CAPABILITIES,
  vision: true,
};

const ZAI_CODING_PLAN_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_PREVIOUS_DEFAULT_BASE_URLS = new Set([
  "https://api.z.ai/api/paas/v4",
  "https://open.bigmodel.cn/api/paas/v4",
]);

const FALLBACK_PROVIDER_PRESETS: readonly ServerProviderPreset[] = [
  {
    id: "openpond",
    displayName: "OpenPond",
    credentialModes: ["openpond-account", "openpond-managed"],
    routing: { hostedOpChat: true, localRuntime: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "hosted",
      toolCalling: true,
    },
    defaultEnabled: true,
    defaultModel: "openpond-chat",
    modelCacheSource: "hosted",
    models: [
      {
        id: "openpond-chat",
        displayName: "OpenPond Chat",
        contextWindow: 128000,
        capabilities: COMMON_OPENAI_COMPATIBLE_MODELS,
      },
    ],
  },
  {
    id: "codex",
    displayName: "Codex",
    credentialModes: ["codex-login"],
    routing: { localRuntime: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "none",
      toolCalling: true,
      reasoning: true,
    },
    defaultEnabled: true,
    defaultModel: "gpt-5.5",
    modelCacheSource: "curated",
    models: [
      { id: "gpt-5.5", displayName: "GPT-5.5", capabilities: REASONING_MODEL_CAPABILITIES },
      { id: "gpt-5.4", displayName: "GPT-5.4", capabilities: REASONING_MODEL_CAPABILITIES },
      {
        id: "gpt-5.4-mini",
        displayName: "GPT-5.4 mini",
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "gpt-5.3-codex-spark",
        displayName: "GPT-5.3 Codex Spark",
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
      { id: "gpt-5.2", displayName: "GPT-5.2", capabilities: REASONING_MODEL_CAPABILITIES },
    ],
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    credentialModes: ["local-byok"],
    routing: { localRuntime: true, localByok: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "provider",
      toolCalling: true,
      reasoning: true,
      imageInput: true,
    },
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4",
    modelCacheSource: "curated",
    models: [
      {
        id: "claude-sonnet-4",
        displayName: "Claude Sonnet 4",
        capabilities: VISION_REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "claude-opus-4",
        displayName: "Claude Opus 4",
        capabilities: VISION_REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "claude-3-5-sonnet-latest",
        displayName: "Claude 3.5 Sonnet",
        capabilities: VISION_REASONING_MODEL_CAPABILITIES,
      },
    ],
  },
  {
    id: "openai",
    displayName: "OpenAI",
    credentialModes: ["local-byok"],
    routing: { localRuntime: true, localByok: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "provider",
      toolCalling: true,
      reasoning: true,
      imageInput: true,
      structuredOutput: true,
    },
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.5",
    modelCacheSource: "curated",
    models: [
      { id: "gpt-5.5", displayName: "GPT-5.5", capabilities: VISION_REASONING_MODEL_CAPABILITIES },
      { id: "gpt-5.4", displayName: "GPT-5.4", capabilities: VISION_REASONING_MODEL_CAPABILITIES },
      {
        id: "gpt-4.1",
        displayName: "GPT-4.1",
        capabilities: VISION_REASONING_MODEL_CAPABILITIES,
      },
    ],
  },
  {
    id: "google",
    displayName: "Google Gemini",
    credentialModes: ["local-byok"],
    routing: { localRuntime: true, localByok: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "provider",
      toolCalling: true,
      reasoning: true,
      imageInput: true,
    },
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-2.5-pro",
    modelCacheSource: "curated",
    models: [
      {
        id: "gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        capabilities: VISION_REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        capabilities: VISION_REASONING_MODEL_CAPABILITIES,
      },
    ],
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    credentialModes: ["local-byok"],
    routing: { localRuntime: true, localByok: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "provider",
      toolCalling: true,
      reasoning: true,
      imageInput: true,
      structuredOutput: true,
    },
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4",
    modelCacheSource: "curated",
    models: [
      {
        id: "anthropic/claude-sonnet-4",
        displayName: "Claude Sonnet 4",
        capabilities: VISION_REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "openai/gpt-5.5",
        displayName: "GPT-5.5",
        capabilities: VISION_REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "google/gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        capabilities: VISION_REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "deepseek/deepseek-chat",
        displayName: "DeepSeek Chat",
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "moonshotai/kimi-k2",
        displayName: "Kimi K2",
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "z-ai/glm-5.2",
        displayName: "GLM-5.2",
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "qwen/qwen3-coder",
        displayName: "Qwen3 Coder",
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
    ],
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    credentialModes: ["local-byok"],
    routing: { localRuntime: true, localByok: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "provider",
      toolCalling: true,
      reasoning: true,
    },
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    modelCacheSource: "curated",
    models: [
      {
        id: "deepseek-chat",
        displayName: "DeepSeek Chat",
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "deepseek-reasoner",
        displayName: "DeepSeek Reasoner",
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
    ],
  },
  {
    id: "zai",
    displayName: "Z.ai / GLM",
    credentialModes: ["local-byok"],
    routing: { localRuntime: true, localByok: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "provider",
      toolCalling: true,
      reasoning: true,
    },
    defaultBaseUrl: ZAI_CODING_PLAN_BASE_URL,
    defaultModel: "glm-5.2",
    modelCacheSource: "curated",
    models: [
      {
        id: "glm-5.2",
        displayName: "GLM-5.2",
        contextWindow: 1_000_000,
        outputLimit: 128_000,
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "glm-5.1",
        displayName: "GLM-5.1",
        contextWindow: 200_000,
        outputLimit: 128_000,
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "glm-5",
        displayName: "GLM-5",
        contextWindow: 200_000,
        outputLimit: 128_000,
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "glm-4.7",
        displayName: "GLM-4.7",
        contextWindow: 200_000,
        outputLimit: 128_000,
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
    ],
  },
  {
    id: "moonshot",
    displayName: "Moonshot / Kimi",
    credentialModes: ["local-byok"],
    routing: { localRuntime: true, localByok: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "provider",
      toolCalling: true,
      reasoning: true,
    },
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2",
    modelCacheSource: "curated",
    models: [
      { id: "kimi-k2", displayName: "Kimi K2", capabilities: REASONING_MODEL_CAPABILITIES },
      {
        id: "moonshot-v1-128k",
        displayName: "Moonshot v1 128K",
        contextWindow: 128000,
        capabilities: COMMON_OPENAI_COMPATIBLE_MODELS,
      },
    ],
  },
  {
    id: "together",
    displayName: "Together",
    credentialModes: ["local-byok"],
    routing: { localRuntime: true, localByok: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "provider",
      toolCalling: true,
      reasoning: true,
    },
    defaultBaseUrl: "https://api.together.xyz/v1",
    defaultModel: "Qwen/Qwen2.5-Coder-32B-Instruct",
    modelCacheSource: "curated",
    models: [
      {
        id: "Qwen/Qwen2.5-Coder-32B-Instruct",
        displayName: "Qwen2.5 Coder 32B",
        capabilities: COMMON_OPENAI_COMPATIBLE_MODELS,
      },
      {
        id: "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
        displayName: "Llama 3.1 405B Turbo",
        capabilities: COMMON_OPENAI_COMPATIBLE_MODELS,
      },
    ],
  },
  {
    id: "groq",
    displayName: "Groq",
    credentialModes: ["local-byok"],
    routing: { localRuntime: true, localByok: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "provider",
      toolCalling: true,
      reasoning: true,
    },
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    modelCacheSource: "curated",
    models: [
      {
        id: "llama-3.3-70b-versatile",
        displayName: "Llama 3.3 70B Versatile",
        capabilities: COMMON_OPENAI_COMPATIBLE_MODELS,
      },
      {
        id: "openai/gpt-oss-120b",
        displayName: "GPT OSS 120B",
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
    ],
  },
  {
    id: "fireworks",
    displayName: "Fireworks",
    credentialModes: ["local-byok"],
    routing: { localRuntime: true, localByok: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "provider",
      toolCalling: true,
      reasoning: true,
    },
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/kimi-k2-instruct",
    modelCacheSource: "curated",
    models: [
      {
        id: "accounts/fireworks/models/kimi-k2-instruct",
        displayName: "Kimi K2 Instruct",
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
      {
        id: "accounts/fireworks/models/deepseek-r1",
        displayName: "DeepSeek R1",
        capabilities: REASONING_MODEL_CAPABILITIES,
      },
    ],
  },
  {
    id: "custom-openai-compatible",
    displayName: "Local / Custom OpenAI-compatible",
    credentialModes: ["local-byok", "custom"],
    routing: { localRuntime: true, localByok: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "manual",
      toolCalling: true,
      structuredOutput: true,
    },
    defaultBaseUrl: null,
    defaultModel: null,
    modelCacheSource: "manual",
    models: [],
  },
];

const FALLBACK_PRESETS_BY_ID = new Map<ProviderId, ServerProviderPreset>(
  FALLBACK_PROVIDER_PRESETS.map((preset) => [preset.id, preset]),
);

function serverPresetFromCatalogProvider(
  provider: ProviderCatalogProvider,
): ServerProviderPreset {
  const parsed = ProviderCatalogProviderSchema.parse(provider);
  return {
    id: parsed.id,
    displayName: parsed.displayName,
    lifecycleStatus: parsed.lifecycleStatus,
    credentialModes: parsed.credentialModes,
    routing: parsed.routing,
    capabilities: parsed.capabilities,
    defaultEnabled: parsed.defaultEnabled,
    defaultBaseUrl: normalizeDefaultBaseUrlForProvider(parsed.id, parsed.defaultBaseUrl ?? null),
    defaultModel: parsed.defaultModel,
    modelCacheSource: parsed.modelCacheSource,
    models: parsed.models,
  };
}

function providerPresetMap(catalog?: ProviderCatalog | null): Map<ProviderId, ServerProviderPreset> {
  const presets = new Map(FALLBACK_PRESETS_BY_ID);
  for (const provider of catalog?.providers ?? []) {
    presets.set(provider.id, serverPresetFromCatalogProvider(provider));
  }
  return presets;
}

export function listProviderPresets(catalog?: ProviderCatalog | null): readonly ServerProviderPreset[] {
  const presets = providerPresetMap(catalog);
  return PROVIDER_IDS.map((providerId) => {
    const preset = presets.get(providerId);
    if (!preset) throw new Error(`Unknown provider: ${providerId}`);
    return preset;
  });
}

export function getProviderPreset(
  providerId: ProviderId,
  catalog?: ProviderCatalog | null,
): ServerProviderPreset {
  const preset = providerPresetMap(catalog).get(providerId);
  if (!preset) throw new Error(`Unknown provider: ${providerId}`);
  return preset;
}

export function parseProviderId(providerId: string): ProviderId {
  return ProviderIdSchema.parse(providerId);
}

export function providerAllowsLocalCredential(
  providerId: ProviderId,
  catalog?: ProviderCatalog | null,
): boolean {
  const modes = getProviderPreset(providerId, catalog).credentialModes;
  return modes.includes("local-byok") || modes.includes("custom");
}

export function parseProviderModelsRequest(input: unknown): ProviderModelsRequest {
  return ProviderModelsRequestSchema.parse(input);
}

export function parseProviderModelsRefreshRequest(input: unknown): ProviderModelsRefreshRequest {
  return ProviderModelsRefreshRequestSchema.parse(input);
}

export function parseProviderValidationRequest(input: unknown): ProviderValidationRequest {
  return ProviderValidationRequestSchema.parse(input);
}

function providerConfigForPreset(
  preset: ServerProviderPreset,
  stored: ProviderConfig | undefined,
): ProviderConfig {
  const storedBaseUrl = normalizeDefaultBaseUrlForProvider(preset.id, stored?.baseUrl ?? null);
  const presetBaseUrl = normalizeDefaultBaseUrlForProvider(preset.id, preset.defaultBaseUrl ?? null);
  return ProviderConfigSchema.parse({
    enabled: stored?.enabled ?? preset.defaultEnabled ?? false,
    baseUrl: storedBaseUrl ?? presetBaseUrl,
    defaultModel: stored?.defaultModel ?? preset.defaultModel ?? null,
    modelOverrides: stored?.modelOverrides ?? [],
    updatedAt: stored?.updatedAt ?? null,
  });
}

function normalizeDefaultBaseUrlForProvider(
  providerId: ProviderId,
  baseUrl: string | null,
): string | null {
  if (providerId !== "zai" || !baseUrl) return baseUrl;
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return ZAI_PREVIOUS_DEFAULT_BASE_URLS.has(normalized)
    ? ZAI_CODING_PLAN_BASE_URL
    : normalized;
}

function providerModelFromPreset(
  providerId: ProviderId,
  model: ProviderPresetModel,
  source: ProviderModel["source"],
): ProviderModel {
  return ProviderModelSchema.parse({
    id: model.id,
    providerId,
    displayName: model.displayName,
    contextWindow: model.contextWindow ?? null,
    outputLimit: model.outputLimit ?? null,
    lifecycleStatus: model.lifecycleStatus ?? "active",
    source,
    capabilities: model.capabilities ?? {},
  });
}

function manualModel(providerId: ProviderId, modelId: string): ProviderModel {
  return ProviderModelSchema.parse({
    id: modelId,
    providerId,
    displayName: modelId,
    contextWindow: null,
    outputLimit: null,
    lifecycleStatus: "active",
    source: "manual",
    capabilities: {},
  });
}

function uniqueModels(models: ProviderModel[]): ProviderModel[] {
  const seen = new Set<string>();
  const output: ProviderModel[] = [];
  for (const model of models) {
    const key = `${model.providerId}:${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(model);
  }
  return output;
}

function starterModelsForPreset(
  preset: ServerProviderPreset,
  config: ProviderConfig,
  cacheSource: ProviderModel["source"],
): ProviderModel[] {
  const models = preset.models.map((model) => providerModelFromPreset(preset.id, model, cacheSource));
  for (const modelId of [...config.modelOverrides, config.defaultModel].filter(
    (value): value is string => Boolean(value),
  )) {
    models.push(manualModel(preset.id, modelId));
  }
  return uniqueModels(models);
}

export function buildProviderModelCache(input: {
  providerId: ProviderId;
  file: ProvidersFile;
  fetchedAt?: string | null;
  catalog?: ProviderCatalog | null;
}): ProviderModelCache {
  const preset = getProviderPreset(input.providerId, input.catalog);
  const config = providerConfigForPreset(preset, input.file.providers[input.providerId]);
  const existing = input.file.modelCaches?.[input.providerId];
  const source = preset.modelCacheSource === "hosted" ? "hosted" : preset.modelCacheSource;
  const models = starterModelsForPreset(
    preset,
    config,
    source === "manual" ? "manual" : source === "hosted" ? "hosted" : "curated",
  );
  return ProviderModelCacheSchema.parse({
    providerId: preset.id,
    models,
    fetchedAt: input.fetchedAt ?? existing?.fetchedAt ?? null,
    lastError: null,
    source: models.length > 0 ? source : "none",
  });
}

function modelCacheForSettings(
  preset: ServerProviderPreset,
  config: ProviderConfig,
  existing: ProviderModelCache | undefined,
): ProviderModelCache {
  const source = existing?.source && existing.source !== "none" ? existing.source : preset.modelCacheSource;
  const cacheSource = source === "hosted" ? "hosted" : source === "manual" ? "manual" : "curated";
  const cachedModels = existing?.models ?? [];
  const starterModels = starterModelsForPreset(preset, config, cacheSource);
  const models = uniqueModels([...cachedModels, ...starterModels]);
  return ProviderModelCacheSchema.parse({
    providerId: preset.id,
    models,
    fetchedAt: existing?.fetchedAt ?? null,
    lastError: existing?.lastError ?? null,
    source: models.length > 0 ? source : "none",
  });
}

function redactIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const atIndex = trimmed.indexOf("@");
  if (atIndex > 1) {
    return `${trimmed.slice(0, 1)}***${trimmed.slice(atIndex)}`;
  }
  if (trimmed.length <= 6) return "***";
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
}

function redactSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function credentialStatusFromSecret(secret: ProviderSecretRecord | undefined) {
  if (!secret) return ProviderCredentialStatusSchema.parse({});
  const source: ProviderCredentialSource = secret.source;
  if (secret.source === "env") {
    const envValue = secret.envVar ? process.env[secret.envVar] : undefined;
    const connected = Boolean(envValue);
    return ProviderCredentialStatusSchema.parse({
      connected,
      source,
      redacted: connected && secret.envVar ? `${secret.envVar}=${redactSecret(envValue)}` : null,
      lastValidatedAt: secret.lastValidatedAt ?? null,
      lastError:
        secret.lastError ??
        (connected || !secret.envVar ? null : `Environment variable ${secret.envVar} is not set.`),
    });
  }
  return ProviderCredentialStatusSchema.parse({
    connected: Boolean(secret.value),
    source,
    redacted: redactSecret(secret.value),
    lastValidatedAt: secret.lastValidatedAt ?? null,
    lastError: secret.lastError ?? null,
  });
}

function credentialStatusForPreset(input: {
  preset: ServerProviderPreset;
  account?: AccountState | null;
  codex?: CodexStatus | null;
  secret?: ProviderSecretRecord;
}) {
  if (input.preset.id === "openpond") {
    const connected = input.account?.state === "signed_in";
    return ProviderCredentialStatusSchema.parse({
      connected,
      source: connected ? "openpond_account" : "none",
      redacted: redactIdentity(input.account?.email ?? input.account?.activeProfile?.handle ?? null),
      lastValidatedAt: input.account?.apiHealth?.checkedAt ?? null,
      lastError: input.account?.state === "auth_error" ? input.account.error : null,
    });
  }
  if (input.preset.id === "codex") {
    const connected = input.codex?.authHealth === "signed_in";
    return ProviderCredentialStatusSchema.parse({
      connected,
      source: connected ? "codex_login" : "none",
      redacted: redactIdentity(input.codex?.account?.email ?? input.codex?.account?.label ?? null),
      lastValidatedAt: null,
      lastError:
        input.codex?.authHealth === "auth_error"
          ? input.codex.appServer.lastError ?? "Codex authentication failed."
          : input.codex?.appServer.lastError ?? null,
    });
  }
  return credentialStatusFromSecret(input.secret);
}

function providerAvailable(input: {
  preset: ServerProviderPreset;
  config: ProviderConfig;
  credentialConnected: boolean;
  codex?: CodexStatus | null;
}): boolean {
  if (input.preset.id === "openpond") return input.credentialConnected;
  if (input.preset.id === "codex") {
    return Boolean(input.codex?.available) && input.credentialConnected;
  }
  return input.config.enabled && input.credentialConnected;
}

function providerStatus(input: {
  preset: ServerProviderPreset;
  config: ProviderConfig;
  cache: ProviderModelCache;
  account?: AccountState | null;
  codex?: CodexStatus | null;
  secret?: ProviderSecretRecord;
}): ProviderStatus {
  const credential = credentialStatusForPreset(input);
  return ProviderStatusSchema.parse({
    id: input.preset.id,
    displayName: input.preset.displayName,
    lifecycleStatus: input.preset.lifecycleStatus ?? "active",
    credentialModes: input.preset.credentialModes,
    routing: input.preset.routing,
    capabilities: ProviderCapabilitiesSchema.parse(input.preset.capabilities),
    credential,
    enabled: input.config.enabled,
    available: providerAvailable({
      preset: input.preset,
      config: input.config,
      credentialConnected: credential.connected,
      codex: input.codex,
    }),
    defaultModel: input.config.defaultModel,
    modelIds: input.cache.models.map((model) => model.id),
    lastError: input.cache.lastError,
  });
}

export function buildProviderSettings(input: {
  file: ProvidersFile;
  secrets?: ProviderSecrets | null;
  account?: AccountState | null;
  codex?: CodexStatus | null;
  catalog?: ProviderCatalog | null;
}): ProviderSettings {
  const providers: Record<string, ProviderConfig> = { ...input.file.providers };
  const modelCaches: Record<string, ProviderModelCache> = { ...(input.file.modelCaches ?? {}) };
  const statuses: Record<string, ProviderStatus> = {};

  for (const preset of listProviderPresets(input.catalog)) {
    const providerId = preset.id;
    const config = providerConfigForPreset(preset, providers[providerId]);
    const cache = modelCacheForSettings(preset, config, modelCaches[providerId]);
    providers[providerId] = config;
    modelCaches[providerId] = cache;
    statuses[providerId] = providerStatus({
      preset,
      config,
      cache,
      account: input.account,
      codex: input.codex,
      secret: input.secrets?.providers[providerId],
    });
  }

  return ProviderSettingsSchema.parse({
    version: 1,
    providers,
    statuses,
    modelCaches,
    updatedAt: null,
  });
}

export function listProviderModels(
  settings: ProviderSettings,
  providerId: ProviderId,
  request: ProviderModelsRequest,
): { providerId: ProviderId; models: ProviderModel[]; cache: ProviderModelCache; query: string | null } {
  const cache = settings.modelCaches[providerId] ?? ProviderModelCacheSchema.parse({ providerId });
  const query = request.query?.trim().toLowerCase() ?? "";
  const models = query
    ? cache.models.filter((model) =>
        `${model.id} ${model.displayName}`.toLowerCase().includes(query),
      )
    : cache.models;
  return {
    providerId,
    models: models.slice(0, request.limit),
    cache,
    query: query || null,
  };
}
