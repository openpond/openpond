import { LocalModelChatConfigurationSchema } from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";

export function createTrainingModelConfigurationService(store: SqliteStore) {
  async function updateModelConfiguration(input: {
    modelId: string;
    configuration: unknown;
  }) {
    const model = await store.getModelArtifactLineage(input.modelId);
    if (!model || model.status !== "imported") {
      throw new Error("Imported model not found.");
    }
    const configuration = LocalModelChatConfigurationSchema.parse({
      ...(input.configuration as Record<string, unknown>),
      updatedAt: new Date().toISOString(),
    });
    return store.saveModelArtifactLineage({
      ...model,
      chatConfiguration: configuration,
    });
  }

  async function setModelPinned(input: {
    modelId: string;
    pinned: boolean;
  }) {
    const model = await store.getModelArtifactLineage(input.modelId);
    if (!model) throw new Error("Model version not found.");
    if (!input.pinned) {
      const activeBinding = (await store.listModelBindings()).find(
        (binding) =>
          binding.status === "active" &&
          binding.modelArtifactLineageId === model.id,
      );
      if (activeBinding) {
        throw new Error("Current Model versions stay pinned.");
      }
    }
    return store.saveModelArtifactLineage({
      ...model,
      pinned: input.pinned,
    });
  }

  return { setModelPinned, updateModelConfiguration };
}
