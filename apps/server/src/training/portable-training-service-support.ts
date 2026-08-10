import type { TrainingDestinationCapabilities } from "@openpond/contracts";
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
  searchTrainingModels?: (
    query: string,
  ) => Promise<RegistryModelSearchResult[]>;
}) {
  async function catalog(
    query = "",
    preferredMethod?: "sft" | "dpo" | "grpo" | "ppo",
  ) {
    const [destinationCapabilities, searchResults, adapterCompute] = await Promise.all([
      input.destinations(),
      query.trim().length >= 2
        ? (input.searchTrainingModels ?? searchHuggingFaceModels)(query)
        : Promise.resolve([]),
      input.adapters.computeCapabilities(),
    ]);
    return createPortableTrainingCatalog({
      candidates: projectBaseModelCandidates({ destinations: destinationCapabilities }),
      destinations: destinationCapabilities,
      searchResults,
      registeredEngineIds: input.adapters.engineIds(),
      adapterCompute,
      preferredMethod,
    });
  }

  async function prepare(inputPlan: {
    modelRunId: string;
    maximumSpendUsd?: number | null;
    retentionDays?: number | null;
  }) {
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
