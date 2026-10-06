import type { ChatProvider, ProviderSettings } from "@openpond/contracts";
import { defaultModelForProvider, modelOptionsForProvider, type DropdownOption } from "../../lib/app-models";

const nativeProviders = new Set(["claude-code", "opencode", "grok-build"]);

export type ComposerModelGroup = {
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
  return providerOptions.flatMap((providerOption) => {
    if (providerOption.value === "setup-provider") return [];
    const provider = providerOption.value as ChatProvider;
    const options = provider === currentProvider ? currentModelOptions : modelOptionsForProvider(provider, providerSettings);
    return options.length || nativeProviders.has(provider)
      ? [{ provider, label: providerOption.label, defaultModel: defaultModelForProvider(provider, providerSettings), options }]
      : [];
  });
}

export function modelSelectionForGroup(group: ComposerModelGroup): { provider: ChatProvider; model: string } | null {
  const selected = group.options.find((option) => option.value === group.defaultModel) ?? group.options[0];
  if (!selected && !nativeProviders.has(group.provider)) return null;
  // An empty selection asks the native agent to use its advertised current model.
  // It does not manufacture a model alias or persist a provider default.
  return { provider: group.provider, model: selected?.value ?? "" };
}
