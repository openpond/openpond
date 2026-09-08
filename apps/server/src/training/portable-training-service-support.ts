import type { ModelProject, TrainingDestinationCapabilities } from "@openpond/contracts";
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
import { buildManagedTrainingEvaluationSource } from "./managed-training-evaluation-source.js";

export function createPortableTrainingServiceSupport(input: {
  store: SqliteStore;
  storeDir: string;
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
    modelProjectId: string;
    modelProject?: ModelProject;
    maximumSpendUsd?: number | null;
    retentionDays?: number | null;
  }) {
    const modelProject = inputPlan.modelProject ?? await input.store.getModelProject(
      inputPlan.modelProjectId,
    );
    if (!modelProject) {
      throw new Error("A saved Model Project is required.");
    }
    if (modelProject.id !== inputPlan.modelProjectId) throw new Error("Model preparation identity does not match the selected configuration.");
    if (modelProject.trainingSetup.evaluationTasksetRef && modelProject.trainingSetup.destinationId !== "openpond_managed") {
      throw new Error("Separate held-out Tasksets currently require the OpenPond Managed evaluation adapter.");
    }
    if (modelProject.trainingSetup.destinationId === "openpond_managed") {
      const reference = modelProject.trainingSetup.tasksetRef;
      const taskset = reference ? await input.store.getTasksetRevision(reference.id, reference.revision, reference.contentHash) : null;
      if (!taskset || taskset.profileId !== modelProject.profileId) throw new Error("The training Taskset revision is unavailable in this workspace.");
      await buildManagedTrainingEvaluationSource({ store: input.store, storeDir: input.storeDir, trainingTaskset: taskset,
        trainingPlan: { evaluationTasksetRef: modelProject.trainingSetup.evaluationTasksetRef } });
    }
    const trainingCatalog = await catalog();
    return preparePortableModelRun({
      modelProject,
      catalog: trainingCatalog,
      maximumSpendUsd: inputPlan.maximumSpendUsd,
      retentionDays: inputPlan.retentionDays,
    });
  }

  return { catalog, prepare };
}
