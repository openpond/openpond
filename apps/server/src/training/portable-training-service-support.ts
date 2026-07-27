import type {
  ComputeInventory,
  SignedWorkerCatalog,
  TrainingDestinationCapabilities,
  WorkerCatalogEntry,
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
  resolvePortableBindings,
} from "./portable-training-catalog.js";

export function createPortableTrainingServiceSupport(input: {
  store: Pick<SqliteStore, "getModelRunDraft">;
  destinations: () => Promise<TrainingDestinationCapabilities[]>;
  adapters: TrainingAdapterRegistry;
  computeInventory?: () => Promise<ComputeInventory | null>;
  revalidateCompute?: () => Promise<unknown>;
  workerCatalog?: () => Promise<SignedWorkerCatalog | null>;
  workerImages?: {
    inspect(entry: WorkerCatalogEntry): Promise<{ cached: boolean }>;
  };
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
      workerCatalog,
      searchResults,
      adapterCompute,
      adapterRuntimes,
    ] = await Promise.all([
      input.destinations(),
      input.computeInventory?.() ?? Promise.resolve(null),
      input.workerCatalog?.() ?? Promise.resolve(null),
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
      workerCatalog,
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
    const bindings = resolvePortableBindings({
      modelRun,
      catalog: trainingCatalog,
    });
    const worker = bindings.engine
      ? trainingCatalog.workers.find(
          (candidate) =>
            candidate.engineAdapterId === bindings.engine?.adapterId,
        ) ?? null
      : null;
    const configuredWorkerAlreadyRunning =
      worker !== null &&
      ((input.connectedWorkerConfigured === true &&
        input.connectedWorkerImageDigest === worker.image.digest) ||
        (modelRun.destinationId === "prime_hosted" &&
          input.primeRawConfigured === true));
    const workerCached = configuredWorkerAlreadyRunning
      ? true
      : worker && input.workerImages
        ? (await input.workerImages.inspect(worker)).cached
        : false;
    return preparePortableModelRun({
      modelRun,
      catalog: trainingCatalog,
      workerCached,
      maximumSpendUsd: inputPlan.maximumSpendUsd,
      retentionDays: inputPlan.retentionDays,
    });
  }

  return { catalog, prepare };
}
