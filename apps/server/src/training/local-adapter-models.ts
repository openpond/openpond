import {
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  CROSS_SYSTEM_TOOL_NAMES,
  ProviderConfigSchema,
  ProviderModelCacheSchema,
  ProviderModelSchema,
  ProviderSettingsSchema,
  ProviderStatusSchema,
  type ProviderModel,
  type ProviderSettings,
  type Taskset,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";

export const LOCAL_ADAPTER_PROVIDER_ID = "local-adapter" as const;

export async function listLocalAdapterProviderModels(store: SqliteStore): Promise<ProviderModel[]> {
  const [lineages, artifacts, jobs, plans] = await Promise.all([
    store.listModelArtifactLineage(),
    store.listTrainingArtifacts(),
    store.listTrainingJobs(),
    store.listTrainingPlans(),
  ]);
  const tasksets = (await Promise.all(
    [...new Set(lineages.map((lineage) => lineage.tasksetId))].map((tasksetId) => store.getTaskset(tasksetId)),
  )).filter((taskset) => taskset !== null);
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const tasksetById = new Map(tasksets.map((taskset) => [taskset.id, taskset]));
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));

  const selectedTasksets = new Set<string>();
  return lineages
    .filter((lineage) => lineage.status === "imported")
    .sort((left, right) => right.importedAt.localeCompare(left.importedAt))
    .filter((lineage) => {
      if (selectedTasksets.has(lineage.tasksetId)) return false;
      selectedTasksets.add(lineage.tasksetId);
      return true;
    })
    .map((lineage) => {
      const artifact = artifactById.get(lineage.artifactId);
      const job = jobById.get(lineage.jobId);
      const taskset = tasksetById.get(lineage.tasksetId);
      const plan = job ? planById.get(job.planId) : null;
      if (!artifact || artifact.kind !== "adapter" || !job || job.status !== "succeeded" || !taskset || !plan) {
        return null;
      }
      const toolCalling = supportsCrossSystemToolCalling(taskset);
      return ProviderModelSchema.parse({
        id: lineage.id,
        providerId: LOCAL_ADAPTER_PROVIDER_ID,
        displayName: taskset.name,
        contextWindow: lineage.chatConfiguration.contextWindowTokens,
        outputLimit: lineage.chatConfiguration.maxOutputTokens,
        lifecycleStatus: "preview",
        source: "cache",
        capabilities: {
          streaming: true,
          toolCalling,
          reasoning: false,
          vision: false,
          structuredOutput: false,
        },
        raw: {
          lineageId: lineage.id,
          artifactId: artifact.id,
          jobId: job.id,
          tasksetId: taskset.id,
          baseModelId: artifact.baseModelId,
          nonProduction: artifact.nonProduction,
          chatConfiguration: lineage.chatConfiguration,
          trainingMethod: plan.recipe.method,
          toolContractHash: toolCalling ? CROSS_SYSTEM_TOOL_CONTRACT_HASH : null,
        },
      });
    })
    .filter((model): model is ProviderModel => model !== null);
}

export function withLocalAdapterProviderModels(
  settings: ProviderSettings,
  models: ProviderModel[],
): ProviderSettings {
  const currentConfig = settings.providers[LOCAL_ADAPTER_PROVIDER_ID];
  const defaultModel = models.some((model) => model.id === currentConfig?.defaultModel)
    ? currentConfig?.defaultModel ?? null
    : models[0]?.id ?? null;
  const config = ProviderConfigSchema.parse({
    ...currentConfig,
    enabled: true,
    baseUrl: null,
    defaultModel,
    modelOverrides: [],
  });
  const cache = ProviderModelCacheSchema.parse({
    providerId: LOCAL_ADAPTER_PROVIDER_ID,
    models,
    fetchedAt: new Date().toISOString(),
    lastError: null,
    source: models.length ? "manual" : "none",
  });
  const status = ProviderStatusSchema.parse({
    id: LOCAL_ADAPTER_PROVIDER_ID,
    displayName: "Local trained models",
    lifecycleStatus: "preview",
    credentialModes: [],
    routing: { localRuntime: true },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: "manual",
      toolCalling: models.some((model) => model.capabilities.toolCalling),
      reasoning: false,
      imageInput: false,
      structuredOutput: false,
    },
    credential: {
      connected: true,
      source: "none",
      redacted: "Local runtime",
      lastValidatedAt: null,
      lastError: null,
    },
    enabled: true,
    available: models.length > 0,
    defaultModel,
    modelIds: models.map((model) => model.id),
    lastError: null,
  });
  return ProviderSettingsSchema.parse({
    ...settings,
    providers: { ...settings.providers, [LOCAL_ADAPTER_PROVIDER_ID]: config },
    modelCaches: { ...settings.modelCaches, [LOCAL_ADAPTER_PROVIDER_ID]: cache },
    statuses: { ...settings.statuses, [LOCAL_ADAPTER_PROVIDER_ID]: status },
  });
}

export function supportsCrossSystemToolCalling(taskset: Taskset): boolean {
  const toolNames = [...taskset.environment.toolNames].sort();
  return taskset.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH
    && taskset.environment.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH
    && taskset.environment.networkPolicy === "none"
    && taskset.environment.stateful
    && taskset.capabilities.requiresTools
    && JSON.stringify(toolNames) === JSON.stringify([...CROSS_SYSTEM_TOOL_NAMES].sort());
}
