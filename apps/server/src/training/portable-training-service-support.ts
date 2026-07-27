import type {
  ComputeInventory,
  TrainingDestinationCapabilities,
} from "@openpond/contracts";
import type { TrainingAdapterRegistry } from "@openpond/training-sdk";
import type { SqliteStore } from "../store/store.js";
import { projectBaseModelCandidates } from "./base-model-candidates.js";
import {
  searchHuggingFaceModels,
  type RegistryModelSearchResult,
} from "./model-registry-search.js";
import {
  createPortableTrainingCatalog,
  preparePortableModelRun,
} from "./portable-training-catalog.js";

export function createPortableTrainingServiceSupport(input: {
  store: Pick<SqliteStore, "getModelRunDraft">;
  destinations: () => Promise<TrainingDestinationCapabilities[]>;
  adapters: TrainingAdapterRegistry;
  computeInventory?: () => Promise<ComputeInventory | null>;
  revalidateCompute?: () => Promise<unknown>;
  connectedWorkerConfigured?: boolean;
  connectedEngineConfigured?: boolean;
  primeRawConfigured?: boolean;
  connectedWorkerImageDigest?: string | null;
  searchTrainingModels?: (
    query: string,
  ) => Promise<RegistryModelSearchResult[]>;
}) {
  async function catalog(query = "") {
    const [
      destinationCapabilities,
      compute,
      searchResults,
      adapterCompute,
      adapterRuntimes,
    ] = await Promise.all([
      input.destinations(),
      input.computeInventory?.() ?? Promise.resolve(null),
      query.trim().length >= 2
        ? (input.searchTrainingModels ?? searchHuggingFaceModels)(query)
        : Promise.resolve([]),
      input.adapters.computeCapabilities(),
      input.adapters.runtimeCapabilities(),
    ]);
    return createPortableTrainingCatalog({
      candidates: projectBaseModelCandidates({
        destinations: destinationCapabilities,
        inventory: compute,
      }),
      destinations: destinationCapabilities,
      inventory: compute,
      searchResults,
      registeredEngineIds: input.adapters.engineIds(),
      connectedWorkerConfigured:
        input.connectedWorkerConfigured ?? false,
      connectedEngineConfigured:
        input.connectedEngineConfigured ?? false,
      primeRawConfigured:
        input.primeRawConfigured ?? false,
      connectedWorkerImageDigest:
        input.connectedWorkerImageDigest ?? null,
      adapterCompute,
      adapterRuntimes,
    });
  }

  async function prepare(inputPlan: {
    modelRunId: string;
    maximumSpendUsd?: number | null;
    retentionDays?: number | null;
  }) {
    await input.revalidateCompute?.();
    const modelRun = await input.store.getModelRunDraft(
      inputPlan.modelRunId,
    );
    if (!modelRun || modelRun.status !== "ready_to_run") {
      throw new Error("A ready saved Model Run is required.");
    }
    const trainingCatalog = await catalog();
    return preparePortableModelRun({
      modelRun,
      catalog: trainingCatalog,
      maximumSpendUsd: inputPlan.maximumSpendUsd,
      retentionDays: inputPlan.retentionDays,
    });
  }

  return { catalog, prepare };
}
