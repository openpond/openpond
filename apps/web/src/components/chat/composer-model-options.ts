import { isRegisteredAcpProvider } from "@openpond/contracts/providers";
import type { ChatProvider, ProviderSettings } from "@openpond/contracts";
import { readChatSelectionPreference } from "../../lib/chat-selection-preference";
import { defaultModelForProvider, modelOptionsForProvider, type DropdownOption } from "../../lib/app-models";

const nativeProviders = new Set(["claude-code", "opencode", "grok-build"]);

export type ComposerModelGroup = {
  key: string;
  provider: ChatProvider;
  label: string;
  defaultModel: string;
  options: DropdownOption[];
};

/** A native provider remains selectable before its session catalog is loaded. */
export function composerModelGroups({ currentModelOptions, currentProvider, providerOptions, providerSettings }: {
  currentModelOptions: DropdownOption[];
  currentProvider: ChatProvider;
  providerOptions: DropdownOption[];
  providerSettings?: ProviderSettings | null;
}): ComposerModelGroup[] {
  return providerOptions.flatMap<ComposerModelGroup>((providerOption) => {
    if (providerOption.value === "setup-provider") return [];
    const provider = providerOption.value as ChatProvider;
    const options = provider === currentProvider ? currentModelOptions : modelOptionsForProvider(provider, providerSettings);
    if (provider === "custom-openai-compatible") {
      const cached = providerSettings?.modelCaches[provider]?.models ?? [];
      const groups = new Map<string, DropdownOption[]>();
      for (const option of options) {
        const name = cached.find((entry) => entry.id === option.value)?.raw?.connectionProvider;
        const label = typeof name === "string" ? name : providerOption.label;
        groups.set(label, [...(groups.get(label) ?? []), option]);
      }
      return [...groups].map(([label, options]) => ({ key: `${provider}:${label}`, provider, label, defaultModel: options[0]!.value, options }));
    }
    return options.length || (isRegisteredAcpProvider(provider) || nativeProviders.has(provider))
      ? [{ key: provider, provider, label: providerOption.label, defaultModel: defaultModelForProvider(provider, providerSettings), options }]
      : [];
  });
}

export function modelSelectionForGroup(group: ComposerModelGroup): { provider: ChatProvider; model: string } | null {
  const saved = readChatSelectionPreference();
  const preferred = saved?.modelsByProvider?.[group.provider] ?? (saved?.provider === group.provider ? saved.model : undefined);
  const selected = group.options.find((option) => option.value === preferred)
    ?? group.options.find((option) => option.value === group.defaultModel) ?? group.options[0];
  if (!selected && !(isRegisteredAcpProvider(group.provider) || nativeProviders.has(group.provider))) return null;
  // Keep a native provider's own explicit choice while its catalog loads;
  // otherwise an empty selection asks the agent to use its current model.
  return { provider: group.provider, model: selected?.value ?? preferred ?? "" };
}
