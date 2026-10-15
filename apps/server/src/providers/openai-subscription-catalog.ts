import { createHash } from "node:crypto";
import type { ProviderModelCache, ProviderSettings } from "@openpond/contracts";
import { listOpenAiCompatibleProviderModels } from "../openpond/openai-compatible-provider.js";
import type { ProviderChatGptSubscriptionCredential, ProviderSecrets } from "../openpond/provider-secrets.js";

const catalogs = new Map<string, { expires: number; value: Promise<ProviderModelCache> }>();

/** Subscription discovery is account-scoped and shared by concurrent UI reads. */
export async function withOpenAiSubscriptionCatalog(settings: ProviderSettings, input: {
  secrets: ProviderSecrets; clientVersion?: string; force?: boolean;
  saveCredential: (credential: ProviderChatGptSubscriptionCredential) => Promise<void>;
}): Promise<ProviderSettings> {
  const status = settings.statuses.openai;
  const secret = input.secrets.providers.openai;
  if (!status?.enabled || secret?.source !== "chatgpt_subscription" || !secret.oauth) return settings;
  const key = createHash("sha256").update(JSON.stringify([secret.oauth.accountId, secret.oauth.accessToken,
    secret.oauth.refreshToken, input.clientVersion])).digest("hex");
  let entry = catalogs.get(key);
  if (!entry || (input.force || entry.expires <= Date.now()) && entry.expires !== Infinity) {
    if (catalogs.size > 20) catalogs.clear();
    entry = { expires: Infinity, value: (async (): Promise<ProviderModelCache> => {
      try {
        const models = await listOpenAiCompatibleProviderModels({ providerId: "openai", settings, secrets: input.secrets,
          subscriptionClientVersion: input.clientVersion, requestTimeoutMs: 15_000,
          saveChatGptSubscriptionCredential: async (_provider, credential) => input.saveCredential(credential) });
        return { providerId: "openai", models, source: "provider", fetchedAt: new Date().toISOString(), lastError: null };
      } catch {
        return { providerId: "openai", models: [], source: "provider", fetchedAt: new Date().toISOString(),
          lastError: "Unable to load models for this ChatGPT subscription. Refresh models in Providers to retry." };
      }
    })() };
    catalogs.set(key, entry);
    const current = entry;
    void entry.value.then(value => { current.expires = Date.now() + (value.lastError ? 30_000 : 300_000); });
  }
  const catalog = await entry.value;
  settings.modelCaches.openai = catalog;
  status.modelIds = catalog.models.map(model => model.id);
  const configured = settings.providers.openai?.defaultModel;
  status.defaultModel = configured && status.modelIds.includes(configured) ? configured : status.modelIds[0] ?? null;
  if (catalog.lastError) { status.available = false; status.lastError = catalog.lastError; }
  return settings;
}
