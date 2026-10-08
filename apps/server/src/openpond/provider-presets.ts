import type { ProviderId, ProviderLifecycleStatus, ProviderModelCapabilities, ProviderCredentialMode, ProviderRouting, ProviderCapabilities, ProviderModelDiscovery, ProviderModelCache } from "@openpond/contracts";

export type ProviderPresetModel = {
  id: string;
  displayName: string;
  contextWindow?: number | null;
  outputLimit?: number | null;
  lifecycleStatus?: ProviderLifecycleStatus;
  capabilities?: Partial<ProviderModelCapabilities>;
};

export type ServerProviderPreset = {
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

export function acpPreset(id: ProviderId, displayName: string): ServerProviderPreset {
  return { id, displayName, credentialModes: ["native-agent-login"], routing: { localRuntime: true },
    capabilities: { chatCompletions: true, streaming: true, toolCalling: true, modelDiscovery: "provider" },
    defaultEnabled: false, defaultModel: null, modelCacheSource: "provider", models: [] };
}

