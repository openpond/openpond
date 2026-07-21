import type {
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolChoice,
} from "@openpond/cloud";
import type {
  ManagedAdapterServingProjection,
  ModelBinding,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { ManagedAdapterRegistryClient } from "./managed-adapter-registry-client.js";
import {
  managedBindingLogicalModelName,
} from "./managed-adapter-sync-service.js";

type ManagedBindingContext = {
  binding: ModelBinding;
  projection: ManagedAdapterServingProjection;
};

export function createManagedAdapterChatRuntime(dependencies: {
  store: SqliteStore;
  client: ManagedAdapterRegistryClient;
}) {
  async function context(
    modelId: string | null | undefined,
  ): Promise<ManagedBindingContext | null> {
    const binding = await bindingFromRuntimeModelId(dependencies.store, modelId);
    if (!binding) return null;
    const lineage = await dependencies.store.getModelArtifactLineage(
      binding.modelArtifactLineageId,
    );
    return lineage?.managedServing
      ? { binding, projection: lineage.managedServing }
      : null;
  }

  async function appliesTo(modelId: string | null | undefined): Promise<boolean> {
    // A managed projection owns this product identity even while it is waking,
    // degraded, or failed. Returning false here would silently route a
    // Fireworks-trained adapter through temporary Fireworks serving or a local
    // worker, bypassing the production gateway, billing, and kill switch.
    return Boolean(await context(modelId));
  }

  async function* stream(input: {
    modelId: string | null | undefined;
    messages: HostedChatMessage[];
    requestId: string;
    signal: AbortSignal;
    maxNewTokens?: number;
    temperature?: number;
    tools?: HostedChatTool[];
    toolChoice?: HostedChatToolChoice;
  }) {
    const resolved = await context(input.modelId);
    if (!resolved || !readyProjection(resolved.projection)) {
      throw new Error(
        "The selected trained Model is not ready on managed serving.",
      );
    }
    const teamId = resolved.projection.teamId;
    if (!teamId) {
      throw new Error(
        "The selected trained Model is not ready on managed serving.",
      );
    }
    yield* dependencies.client.streamChat({
      teamId,
      logicalModelName: managedBindingLogicalModelName(resolved.binding),
      messages: input.messages,
      requestId: input.requestId,
      signal: input.signal,
      maxNewTokens: input.maxNewTokens,
      temperature: input.temperature,
      tools: input.tools,
      toolChoice: input.toolChoice,
    });
  }

  return { appliesTo, stream };
}

function readyProjection(
  projection: ManagedAdapterServingProjection,
): boolean {
  return (
    projection.state === "ready" &&
    projection.canonicalArtifactState === "promotable" &&
    projection.canonicalDeploymentState === "ready" &&
    Boolean(projection.teamId) &&
    Boolean(projection.canonicalArtifactId) &&
    Boolean(projection.canonicalDeploymentId)
  );
}

async function bindingFromRuntimeModelId(
  store: SqliteStore,
  modelId: string | null | undefined,
): Promise<ModelBinding | null> {
  if (!modelId?.startsWith("binding:")) return null;
  const [, profileId, role, ...targetParts] = modelId.split(":");
  const roleTargetId = decodeURIComponent(targetParts.join(":"));
  if (
    !profileId ||
    !roleTargetId ||
    (role !== "chat_manual" &&
      role !== "agent" &&
      role !== "extension" &&
      role !== "authoring_optimizer")
  ) {
    return null;
  }
  return store.getActiveModelBinding({
    profileId,
    role,
    roleTargetId,
  });
}
