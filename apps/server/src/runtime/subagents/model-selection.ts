import type { ChatModelRef, CodexReasoningEffort, ProviderSettings } from "@openpond/contracts";

/** The same configured model catalog used by the desktop model picker. */
export function subagentModelCatalog(settings: ProviderSettings | null) {
  return Object.values(settings?.statuses ?? {})
    .filter(status => status.enabled && status.available && status.routing.localRuntime)
    .flatMap(status => {
      const cached = settings?.modelCaches[status.id]?.models ?? [];
      return [...new Set([...status.modelIds, ...cached.map(model => model.id)])].map(id => {
        const model = cached.find(model => model.id === id);
        return { modelRef: { providerId: status.id, modelId: id }, name: model?.displayName ?? id,
          reasoningEfforts: model?.capabilities.reasoningEfforts ?? [] };
      });
    });
}

export function assertSubagentModelSelection(settings: ProviderSettings | null, modelRef: ChatModelRef, reasoningEffort?: CodexReasoningEffort) {
  const model = subagentModelCatalog(settings).find(model => model.modelRef.providerId === modelRef.providerId && model.modelRef.modelId === modelRef.modelId);
  if (!model) throw new Error(`Subagent model ${modelRef.providerId}/${modelRef.modelId} is not available. Use openpond_subagent_models to select a configured model.`);
  if (reasoningEffort && !model.reasoningEfforts.includes(reasoningEffort))
    throw new Error(`Subagent model ${modelRef.providerId}/${modelRef.modelId} does not advertise reasoning effort ${reasoningEffort}. Use openpond_subagent_models to inspect supported efforts.`);
}
