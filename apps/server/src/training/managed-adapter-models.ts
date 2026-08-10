import {
  ProviderModelCacheSchema,
  ProviderModelSchema,
  ProviderSettingsSchema,
  managedAdapterProjectionReady,
  type ProviderModel,
  type ProviderSettings,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";

export async function listManagedAdapterProviderModels(store: SqliteStore): Promise<ProviderModel[]> {
  const [lineages, bindings, modelProjects] = await Promise.all([
    store.listModelArtifactLineage(),
    store.listModelBindings(),
    store.listModelProjects(),
  ]);
  const projectNames = new Map(modelProjects.map((project) => [project.id, project.name]));
  const activeRoles = new Map<string, string[]>();
  for (const binding of bindings) {
    if (binding.status !== "active") continue;
    const roles = activeRoles.get(binding.modelArtifactLineageId) ?? [];
    roles.push(`${binding.role}:${binding.roleTargetId}`);
    activeRoles.set(binding.modelArtifactLineageId, roles);
  }
  return lineages
    .filter((lineage) => lineage.status === "imported" && lineage.managedServing && managedAdapterProjectionReady(lineage.managedServing))
    .sort((left, right) => right.importedAt.localeCompare(left.importedAt))
    .map((lineage) => ProviderModelSchema.parse({
      id: lineage.id,
      providerId: "openpond",
      displayName: projectNames.get(lineage.modelId) ?? lineage.modelId,
      contextWindow: lineage.chatConfiguration.contextWindowTokens,
      outputLimit: lineage.chatConfiguration.maxOutputTokens,
      lifecycleStatus: "preview",
      source: "cache",
      capabilities: {
        streaming: true,
        toolCalling: true,
        reasoning: false,
        vision: false,
        structuredOutput: false,
      },
      raw: {
        lineageId: lineage.id,
        managedServing: true,
        activeBindingRoles: activeRoles.get(lineage.id) ?? [],
      },
    }));
}

export function withManagedAdapterProviderModels(settings: ProviderSettings, models: ProviderModel[]): ProviderSettings {
  const current = settings.modelCaches.openpond;
  const merged = [
    ...models,
    ...(current?.models ?? []).filter((model) => !models.some((managed) => managed.id === model.id)),
  ];
  const cache = ProviderModelCacheSchema.parse({
    providerId: "openpond",
    models: merged,
    fetchedAt: current?.fetchedAt ?? new Date().toISOString(),
    lastError: current?.lastError ?? null,
    source: current?.source ?? "curated",
  });
  const status = settings.statuses.openpond;
  return ProviderSettingsSchema.parse({
    ...settings,
    modelCaches: { ...settings.modelCaches, openpond: cache },
    statuses: status ? {
      ...settings.statuses,
      openpond: { ...status, modelIds: merged.map((model) => model.id) },
    } : settings.statuses,
  });
}
