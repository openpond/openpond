import {
  ProviderModelCacheSchema,
  ProviderModelSchema,
  ProviderSettingsSchema,
  type ProviderModel,
  type ProviderSettings,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { managedCatalogModelId, readManagedModelCatalog } from "./managed-adapter-catalog.js";

type ManagedModelCatalog = { models: ProviderModel[]; error: string | null };

export async function listManagedAdapterProviderModels(
  store: SqliteStore,
  teamId?: string | null,
): Promise<ManagedModelCatalog> {
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
  const localModels = lineages
    .filter(
      (lineage) =>
        lineage.status === "imported" &&
        lineage.managedServing &&
        lineage.managedServing.teamId === teamId &&
        !["deleted", "rejected"].includes(lineage.managedServing.canonicalArtifactState ?? ""),
    )
    .sort((left, right) => right.importedAt.localeCompare(left.importedAt))
    .map((lineage) =>
      ProviderModelSchema.parse({
        id: lineage.id,
        providerId: "openpond",
        displayName:
          lineage.managedServing?.canonicalModelName ??
          projectNames.get(lineage.modelId) ??
          lineage.modelId,
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
          canonicalArtifactId: lineage.managedServing?.canonicalArtifactId,
          managedServing: true,
          activeBindingRoles: activeRoles.get(lineage.id) ?? [],
        },
      }),
    );
  if (!teamId) return { models: [], error: null };
  try {
    const remote = await readManagedModelCatalog(teamId);
    const remoteModels = remote.map((model) =>
      ProviderModelSchema.parse({
        id: managedCatalogModelId(teamId, model.id),
        providerId: "openpond",
        displayName: model.metadata.artifact_label || model.id,
        source: "provider",
        capabilities: { streaming: true, toolCalling: true },
        raw: {
          managedServing: true,
          canonicalArtifactId: model.metadata.artifact_id,
          deploymentState: model.metadata.deployment_state,
        },
      }),
    );
    const remoteArtifacts = new Set(remote.map((model) => model.metadata.artifact_id));
    return {
      models: [
        ...remoteModels,
        ...localModels.filter(
          (model) => !remoteArtifacts.has(String(model.raw?.canonicalArtifactId)),
        ),
      ],
      error: null,
    };
  } catch (error) {
    return {
      models: localModels,
      error: error instanceof Error ? error.message : "Managed model catalog unavailable.",
    };
  }
}

export function withManagedAdapterProviderModels(
  settings: ProviderSettings,
  catalog: ManagedModelCatalog,
): ProviderSettings {
  const { models } = catalog;
  const current = settings.modelCaches.openpond;
  const merged = [
    ...models,
    ...(current?.models ?? []).filter(
      (model) =>
        model.raw?.managedServing !== true && !models.some((managed) => managed.id === model.id),
    ),
  ];
  const cache = ProviderModelCacheSchema.parse({
    providerId: "openpond",
    models: merged,
    fetchedAt: current?.fetchedAt ?? new Date().toISOString(),
    lastError: catalog.error ?? current?.lastError ?? null,
    source: current?.source ?? "curated",
  });
  const status = settings.statuses.openpond;
  return ProviderSettingsSchema.parse({
    ...settings,
    modelCaches: { ...settings.modelCaches, openpond: cache },
    statuses: status
      ? {
          ...settings.statuses,
          openpond: { ...status, modelIds: merged.map((model) => model.id) },
        }
      : settings.statuses,
  });
}
