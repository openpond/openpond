import type {
  ChatModelRef,
  ChatProvider,
  ProviderSettings,
} from "@openpond/contracts";

import {
  chatProviderLabel,
  modelOptionsForProvider,
  providerOptionsFromSettings,
} from "../../lib/app-models";

export type LabChatModelOptionGroup = {
  providerId: ChatProvider;
  providerLabel: string;
  models: Array<{ label: string; value: string }>;
};

export function labChatModelOptions(
  settings: ProviderSettings | null,
  selected: ChatModelRef,
): LabChatModelOptionGroup[] {
  const groups = providerOptionsFromSettings(settings, {
    includeUnavailable: false,
  }).flatMap((provider) => {
    const models = modelOptionsForProvider(provider.value, settings).map(
      (model) => ({
        label: model.label,
        value: chatModelValue({
          providerId: provider.value,
          modelId: model.value,
        }),
      }),
    );
    return models.length
      ? [{ providerId: provider.value, providerLabel: provider.label, models }]
      : [];
  });
  const selectedValue = chatModelValue(selected);
  if (groups.some((group) => group.models.some((model) => model.value === selectedValue))) {
    return groups;
  }
  return [
    {
      providerId: selected.providerId,
      providerLabel: chatProviderLabel(selected.providerId, settings),
      models: [{ label: selected.modelId, value: selectedValue }],
    },
    ...groups,
  ];
}

export function chatModelValue(model: ChatModelRef): string {
  return JSON.stringify([model.providerId, model.modelId]);
}

export function chatModelFromValue(value: string): ChatModelRef | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length !== 2
      || typeof parsed[0] !== "string"
      || typeof parsed[1] !== "string"
    ) {
      return null;
    }
    return {
      providerId: parsed[0] as ChatModelRef["providerId"],
      modelId: parsed[1],
    };
  } catch {
    return null;
  }
}
