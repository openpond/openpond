import { ProviderConfigSchema, ProviderStatusSchema, ProviderModelCacheSchema, type ProviderSettings } from "@openpond/contracts/providers";
import { listUrlModels } from "./connection.js";

export async function withUrlModels(home: string, settings: ProviderSettings): Promise<ProviderSettings> {
  const models = await listUrlModels(home);
  const result = { ...settings, providers: { ...settings.providers }, statuses: { ...settings.statuses }, modelCaches: { ...settings.modelCaches } };
  if (models.length) {
    const saved = models;
    const providerId = "custom-openai-compatible";
    const currentModels = settings.modelCaches[providerId]?.models ?? [];
    const combined = [...currentModels, ...saved.map((model) => ({ id: model.id, providerId, displayName: model.name, source: "manual" as const, raw: { connectionProvider: model.providerName },
      capabilities: { streaming: model.protocol === "openai", toolCalling: false, reasoning: false, reasoningEfforts: [], vision: false, structuredOutput: false } }))];
    result.providers[providerId] = ProviderConfigSchema.parse({ ...settings.providers[providerId], enabled: true, defaultModel: saved[0]!.id });
    result.statuses[providerId] = ProviderStatusSchema.parse({ ...settings.statuses[providerId],
      id: providerId, displayName: "Models from URL", enabled: true, available: true, defaultModel: saved[0]!.id, modelIds: combined.map((model) => model.id),
      credentialModes: ["custom"], credential: { connected: true, source: "local_secret" },
      routing: { localRuntime: true, localByok: true }, capabilities: { chatCompletions: true, streaming: true, modelDiscovery: "none", toolCalling: false },
    });
    result.modelCaches[providerId] = ProviderModelCacheSchema.parse({ providerId, source: "manual", models: combined });
  }
  return result;
}
