import type {
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolChoice,
} from "@openpond/cloud";
import type {
  ManagedAdapterServingProjection,
  ModelBinding,
} from "@openpond/contracts";
import { managedAdapterProjectionReady } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { ManagedAdapterRegistryClient } from "./managed-adapter-registry-client.js";
import {
  managedBindingLogicalModelName,
} from "./managed-adapter-sync-service.js";

type ManagedBindingContext = {
  binding: ModelBinding;
  projection: ManagedAdapterServingProjection;
  baseModelId: string;
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
    if (!lineage?.managedServing) return null;
    const versions =
      typeof dependencies.store.listModelVersions === "function"
        ? await dependencies.store.listModelVersions({
            modelId: lineage.modelId,
          })
        : [];
    const version = versions.find(
      (candidate) => candidate.artifactLineageId === lineage.id,
    );
    return {
      binding,
      projection: lineage.managedServing,
      baseModelId: version?.baseModel.modelId ?? lineage.modelId,
    };
  }

  async function appliesTo(modelId: string | null | undefined): Promise<boolean> {
    // A managed projection owns this product identity even while it is waking,
    // degraded, or failed. Returning false here would silently route a
    // retired remote route through local inference, bypassing the production
    // gateway, billing, and kill switch.
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
    if (!resolved || !managedAdapterProjectionReady(resolved.projection)) {
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
      messages: managedAdapterMessages(input.messages, resolved.baseModelId),
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

function managedAdapterMessages(
  messages: HostedChatMessage[],
  baseModelId: string,
): HostedChatMessage[] {
  if (!/\bqwen3(?:\b|[-_.])/i.test(baseModelId)) return messages;
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return messages;
  const content = messages[lastUserIndex]?.content;
  if (typeof content !== "string" || /(?:^|\s)\/no_think(?:\s|$)/.test(content)) {
    return messages;
  }
  return messages.map((message, index) =>
    index === lastUserIndex
      ? { ...message, content: `${content}\n\n/no_think` }
      : message,
  );
}

async function bindingFromRuntimeModelId(
  store: SqliteStore,
  modelId: string | null | undefined,
): Promise<ModelBinding | null> {
  if (!modelId) return null;
  if (!modelId.startsWith("binding:")) {
    const bindings = await store.listModelBindings();
    return (
      bindings
        .filter(
          (binding) =>
            binding.status === "active" &&
            binding.role === "chat_manual" &&
            binding.modelArtifactLineageId === modelId,
        )
        .sort((left, right) => {
          const leftDefault = left.roleTargetId === "default" ? 1 : 0;
          const rightDefault = right.roleTargetId === "default" ? 1 : 0;
          return (
            rightDefault - leftDefault ||
            right.promotedAt.localeCompare(left.promotedAt) ||
            left.id.localeCompare(right.id)
          );
        })[0] ?? null
    );
  }
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
