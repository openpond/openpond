import { isManagedSteeringChatModel, resolveManagedSteeringChat } from "./managed-steering-chat.js";
import { isManagedEngramChatModel, resolveManagedEngramChat } from "./managed-engram-chat.js";
import { isManagedWeightChatModel, resolveManagedWeightChat } from "./managed-weight-chat.js";
import { acknowledgeManagedDecisionChatScore, decisionChatScoreText, isManagedDecisionChatModel, parseManagedDecisionChatInput, scoreManagedDecisionChat } from "./managed-decision-chat.js";
import type { HostedChatMessage, HostedChatTool, HostedChatToolChoice } from "@openpond/cloud";
import type { ManagedAdapterServingProjection, ModelBinding } from "@openpond/contracts";
import { managedAdapterProjectionReady } from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import type { ManagedAdapterRegistryClient } from "./managed-adapter-registry-client.js";
import { managedBindingLogicalModelName } from "./managed-adapter-sync-service.js";

import { managedCatalogSelection, readManagedModelCatalog } from "./managed-adapter-catalog.js";

type ManagedBindingContext = {
  binding: ModelBinding;
  projection: ManagedAdapterServingProjection;
  baseModelId: string;
};

export function createManagedAdapterChatRuntime(dependencies: {
  store: SqliteStore;
  client: ManagedAdapterRegistryClient;
  resolveSelectedTeamId?: () => Promise<string | null>;
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
    const version = versions.find((candidate) => candidate.artifactLineageId === lineage.id);
    const artifact = version
      ? null
      : await dependencies.store.getTrainingArtifact(lineage.artifactId);
    return {
      binding,
      projection: lineage.managedServing,
      baseModelId: version?.baseModel.modelId ?? artifact?.baseModelId ?? lineage.modelId,
    };
  }

  async function appliesTo(modelId: string | null | undefined): Promise<boolean> {
    // A managed projection owns this product identity even while it is waking,
    // degraded, or failed. Returning false here would silently route a
    // retired remote route through local inference, bypassing the production
    // gateway, billing, and kill switch.
    return isManagedDecisionChatModel(modelId) || isManagedWeightChatModel(modelId) || isManagedSteeringChatModel(modelId) || isManagedEngramChatModel(modelId) || modelId?.startsWith("managed:") === true || Boolean(await context(modelId));
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
  } & import("openpond-sdk/training").SteeringInferenceOptions & import("openpond-sdk/training").EngramInferenceOptions) {
    if (input.messages.some((message) => message.images?.length)) {
      throw new Error(
        "The selected trained Model does not support native image review. Use a vision-capable reviewer; the comparison will remain unscorable otherwise.",
      );
    }
    const options = {
      ...(input.savedModel === undefined ? {} : {savedModel: input.savedModel}),
      ...(input.steering === undefined ? {} : {steering: input.steering}),
    };
    if (isManagedDecisionChatModel(input.modelId)) {
      if (!input.modelId || input.steering !== undefined || input.engram !== undefined)
        throw new Error("Use the selected Decision Model without steering or memory overrides.");
      if (input.toolChoice === "required" || typeof input.toolChoice === "object" && input.toolChoice !== null)
        throw new Error("Decision Models score allowed answers and do not call tools.");
      const lastUser = input.messages.slice().reverse().find(message => message.role === "user");
      if (typeof lastUser?.content !== "string") throw new Error("Provide the state and allowed answers to score.");
      const receipt = await scoreManagedDecisionChat({ store: dependencies.store, modelId: input.modelId,
        selectedTeamId: await dependencies.resolveSelectedTeamId?.() ?? null, requestId: input.requestId,
        payload: parseManagedDecisionChatInput(lastUser.content), signal: input.signal,
        ...(input.savedModel === undefined ? {} : { savedModel: input.savedModel }) });
      yield { text: decisionChatScoreText(receipt), raw: { decisionReceipt: receipt, modelId: input.modelId } };
      await acknowledgeManagedDecisionChatScore({ store: dependencies.store, modelId: input.modelId, requestId: input.requestId, receipt });
      yield { finishReason: "stop" };
      return;
    }
    if (isManagedWeightChatModel(input.modelId)) {
      if (!input.modelId || input.steering !== undefined || input.engram !== undefined)
        throw new Error("Select the exact learned-weight Model without an activation or memory override.");
      const resolved = await resolveManagedWeightChat({store: dependencies.store, modelId: input.modelId,
        selectedTeamId: await dependencies.resolveSelectedTeamId?.() ?? null,
        options: input.savedModel === undefined ? {} : {savedModel: input.savedModel}});
      if (!resolved) throw new Error("The saved learned-weight Model selection is unavailable.");
      yield* dependencies.client.streamChat({teamId: resolved.teamId, logicalModelName: resolved.logicalModelName,
        ...resolved.options, weightAdmission: resolved.admission,
        messages: input.messages, requestId: input.requestId, signal: input.signal,
        maxNewTokens: input.maxNewTokens, temperature: input.temperature, tools: input.tools, toolChoice: input.toolChoice});
      return;
    }
    if (isManagedEngramChatModel(input.modelId)) {
      if (!input.modelId || input.steering !== undefined) throw new Error("Select the exact saved memory Model without a steering override.");
      const resolved = await resolveManagedEngramChat({store: dependencies.store, modelId: input.modelId,
        selectedTeamId: await dependencies.resolveSelectedTeamId?.() ?? null,
        options: {...(input.savedModel === undefined ? {} : {savedModel: input.savedModel}), ...(input.engram === undefined ? {} : {engram: input.engram})}});
      if (!resolved) throw new Error("The saved memory Model selection is unavailable.");
      yield* dependencies.client.streamChat({teamId: resolved.teamId, logicalModelName: resolved.logicalModelName,
        ...resolved.options, engramAdmission: resolved.admission,
        messages: input.messages, requestId: input.requestId, signal: input.signal,
        maxNewTokens: input.maxNewTokens, temperature: input.temperature, tools: input.tools, toolChoice: input.toolChoice});
      return;
    }
    if (input.engram !== undefined) throw new Error("Memory module options require an exact saved memory Model selection.");
    if (isManagedSteeringChatModel(input.modelId)) {
      if (!input.modelId) throw new Error("Select the exact saved steering Model.");
      const resolved = await resolveManagedSteeringChat({store: dependencies.store, modelId: input.modelId,
        selectedTeamId: await dependencies.resolveSelectedTeamId?.() ?? null, options});
      if (!resolved) throw new Error("The saved steering Model selection is unavailable.");
      yield* dependencies.client.streamChat({teamId: resolved.teamId, logicalModelName: resolved.logicalModelName,
        ...resolved.options, steeringAdmission: resolved.admission,
        messages: input.messages, requestId: input.requestId, signal: input.signal,
        maxNewTokens: input.maxNewTokens, temperature: input.temperature, tools: input.tools, toolChoice: input.toolChoice});
      return;
    }
    if (Object.keys(options).length) throw new Error("Steering options require an exact saved steering Model selection.");
    const selection = managedCatalogSelection(input.modelId);
    if (selection) {
      const selectedTeamId = await dependencies.resolveSelectedTeamId?.();
      if (selectedTeamId !== selection.teamId)
        throw new Error("Select this model's workspace before sending a message.");
      const catalog = await readManagedModelCatalog(selection.teamId, { fresh: true });
      const model = catalog.find((entry) => entry.id === selection.artifactId);
      if (!model) throw new Error("This managed model is no longer available in this workspace.");
      if (!model.logicalModelName)
        throw new Error("Enable serving for this model in Training before sending a message.");
      // Do not hide cold models or route their requests to an unrelated hosted model.
      // The personalized gateway enforces serving readiness and billing.
      yield* dependencies.client.streamChat({
        teamId: selection.teamId,
        logicalModelName: model.logicalModelName,
        ...(input.savedModel === undefined ? {} : { savedModel: input.savedModel }),
        ...(input.steering === undefined ? {} : { steering: input.steering }),
        messages: managedAdapterMessages(input.messages, model.metadata.base_profile_id),
        requestId: input.requestId,
        signal: input.signal,
        maxNewTokens: input.maxNewTokens,
        temperature: input.temperature,
        tools: input.tools,
        toolChoice: input.toolChoice,
      });
      return;
    }
    const resolved = await context(input.modelId);
    if (!resolved || !managedAdapterProjectionReady(resolved.projection)) {
      throw new Error("The selected trained Model is not ready on managed serving.");
    }
    const teamId = resolved.projection.teamId;
    if (!teamId) {
      throw new Error("The selected trained Model is not ready on managed serving.");
    }
    yield* dependencies.client.streamChat({
      teamId,
      logicalModelName: managedBindingLogicalModelName(resolved.binding),
      ...(input.savedModel === undefined ? {} : { savedModel: input.savedModel }),
      ...(input.steering === undefined ? {} : { steering: input.steering }),
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
    index === lastUserIndex ? { ...message, content: `${content}\n\n/no_think` } : message,
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
