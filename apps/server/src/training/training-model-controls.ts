import { LocalModelChatConfigurationSchema } from "@openpond/contracts";

import type { SqliteStore } from "../store/store.js";
import type { createFireworksServingService } from "./fireworks-serving-service.js";

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

export async function stopActiveFireworksServingSessions(
  fireworksServing: ReturnType<typeof createFireworksServingService>,
  input: {
    tasksetId?: string;
    modelArtifactLineageId?: string;
    reason: string;
  },
): Promise<void> {
  const sessions = (await fireworksServing.list()).filter(
    (session) =>
      ["starting", "ready", "stopping"].includes(session.state) &&
      (!input.tasksetId || session.tasksetId === input.tasksetId) &&
      (!input.modelArtifactLineageId ||
        session.modelArtifactLineageId === input.modelArtifactLineageId),
  );
  for (const session of sessions) {
    const stopped = await fireworksServing.stop(session.id, "user");
    if (stopped.state !== "stopped") {
      throw new Error(
        `${input.reason} could not confirm Fireworks cleanup: ${stopped.error ?? stopped.state}.`,
      );
    }
  }
}
