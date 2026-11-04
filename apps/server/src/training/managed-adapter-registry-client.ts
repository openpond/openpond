import type { ManagedSteeringChatAdmission } from "./managed-steering-chat.js";
import type { ManagedEngramChatAdmission } from "./managed-engram-chat.js";
import { ManagedWeightChatOptionsSchema, type ManagedWeightChatAdmission } from "./managed-weight-chat.js";
import type {
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
  HostedChatUsage,
} from "@openpond/cloud";
import type { ModelBinding } from "@openpond/contracts";
import { canonicalSha256, SteeringInferenceReceiptSchema, parseAndVerifySteeringInferenceReceipt, SteeringInferenceOptionsSchema, type SteeringInferenceOptions } from "openpond-sdk/training";
import { EngramInferenceOptionsSchema, EngramInferenceReceiptSchema, parseAndVerifyEngramInferenceReceipt, type EngramInferenceOptions } from "openpond-sdk/training";
import { canonicalJson, WeightModelInferenceReceiptSchema, parseAndVerifyWeightModelInferenceReceipt } from "openpond-sdk/training";
import {
  registryArtifacts,
  registryDeployments,
  requiredRegistryCapabilities,
} from "./managed-adapter-registry-parsers.js";
import {
  hostedApiAuthHeaders,
  resolveManagedAdapterUserAccess,
} from "../openpond/hosted-api-access.js";

export type ManagedRegistryArtifact = {
  id: string;
  label?: string | null;
  source: string;
  sourceRef: string;
  state: string;
  promotable: boolean;
  customerBindingAllowed: boolean;
  contentHash: string | null;
  baseProfileId: string | null;
};

export type ManagedRegistryDeployment = {
  id: string;
  artifactId: string;
  state: string;
};

export type ManagedRegistryBaseProfile = {
  id: string;
  repository: string;
  revision: string;
  tokenizerRevision: string;
  chatTemplateHash: string;
  status: "draft" | "supported" | "retired";
};

export type ManagedRegistryCapabilities = {
  schemaVersion: "openpond.modelAdapterPlatformCapabilities.v1";
  baseModelProfileContractVersion: "openpond.baseModelProfile.v2";
  baseProfiles: ManagedRegistryBaseProfile[];
  lifecyclePolicyOwner: "sandbox";
};

export type ManagedAdapterChatDelta = {
  text?: string;
  usage?: HostedChatUsage;
  finishReason?: string;
  toolCalls?: HostedChatToolCall[];
  raw?: unknown;
};

export type ManagedAdapterRegistryClientDependencies = {
  fetchImpl?: typeof fetch;
  resolveRegistryAccess?: ManagedAdapterAccessResolver;
  resolveInferenceAccess?: ManagedAdapterAccessResolver;
  env?: Record<string, string | undefined>;
};

type ManagedAdapterAccessResolver = (
  teamId: string
) => Promise<{ apiBaseUrl: string; token: string; teamId: string }>;

export function createManagedAdapterRegistryClient(
  dependencies: ManagedAdapterRegistryClientDependencies = {}
) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolveRegistryAccess =
    dependencies.resolveRegistryAccess ??
    ((teamId) => resolveManagedAdapterUserAccess({ teamId }));
  const resolveInferenceAccess =
    dependencies.resolveInferenceAccess ??
    ((teamId) => resolveManagedAdapterUserAccess({ teamId }));
  async function requestJson<T>(
    resolveAccess: ManagedAdapterAccessResolver,
    teamId: string,
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const access = await resolveAccess(teamId);
    assertResolvedTeam(access.teamId, teamId);
    const requestUrl = `${access.apiBaseUrl}${path}`;
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("accept", "application/json");
    headers.set("x-openpond-team-id", access.teamId);
    if (init.body) headers.set("content-type", "application/json");
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    const response = await fetchImpl(requestUrl, {
      ...init,
      headers,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      message?: unknown;
    };
    if (!response.ok) {
      throw new Error(
        managedApiError(payload, response.status, response.statusText)
      );
    }
    return payload as T;
  }

  async function listRegistryWithAccess(
    resolveAccess: ManagedAdapterAccessResolver,
    teamId: string
  ): Promise<{
    artifacts: ManagedRegistryArtifact[];
    deployments: ManagedRegistryDeployment[];
  }> {
    const [artifactPayload, deploymentPayload] = await Promise.all([
      requestJson<{ artifacts?: unknown }>(
        resolveAccess,
        teamId,
        "/v1/model-adapters/artifacts?limit=200"
      ),
      requestJson<{ deployments?: unknown }>(
        resolveAccess,
        teamId,
        "/v1/model-adapters/deployments"
      ),
    ]);
    return {
      artifacts: registryArtifacts(artifactPayload.artifacts),
      deployments: registryDeployments(deploymentPayload.deployments),
    };
  }
  const listRegistry = (teamId: string) =>
    listRegistryWithAccess(resolveRegistryAccess, teamId);
  const capabilities = (teamId: string) =>
    capabilitiesWithAccess(resolveRegistryAccess, teamId);

  async function capabilitiesWithAccess(
    resolveAccess: ManagedAdapterAccessResolver,
    teamId: string
  ): Promise<ManagedRegistryCapabilities> {
    return requiredRegistryCapabilities(
      await requestJson<unknown>(
        resolveAccess,
        teamId,
        "/v1/model-adapters/capabilities"
      )
    );
  }

  async function syncBindingWithAccess(
    resolveAccess: ManagedAdapterAccessResolver,
    input: {
      teamId: string;
      binding: ModelBinding;
      logicalModelName: string;
      artifactId: string;
      deploymentId: string;
      bindingVersion: number;
      sourceUpdatedAt: string;
      state: "active" | "inactive" | "deleted";
    }
  ): Promise<void> {
    await requestJson(
      resolveAccess,
      input.teamId,
      "/v1/model-adapters/binding-projections",
      {
        method: "PUT",
        body: JSON.stringify({
          schemaVersion: "openpond.modelBindingProjection.v1",
          externalBindingId: input.binding.id,
          externalLineageId: input.binding.modelArtifactLineageId,
          logicalModelName: input.logicalModelName,
          bindingRole: input.binding.role,
          artifactId: input.artifactId,
          deploymentId: input.deploymentId,
          bindingVersion: input.bindingVersion,
          sourceUpdatedAt: input.sourceUpdatedAt,
          state: input.state,
        }),
      }
    );
  }
  const syncBinding = (input: {
    teamId: string;
    binding: ModelBinding;
    logicalModelName: string;
    artifactId: string;
    deploymentId: string;
    bindingVersion: number;
    sourceUpdatedAt: string;
    state: "active" | "inactive" | "deleted";
  }) => syncBindingWithAccess(resolveRegistryAccess, input);
  async function* streamChat(input: {
    teamId: string;
    logicalModelName: string;
    messages: HostedChatMessage[];
    requestId: string;
    signal: AbortSignal;
    maxNewTokens?: number;
    temperature?: number;
    tools?: HostedChatTool[];
    toolChoice?: HostedChatToolChoice;
    steeringAdmission?: ManagedSteeringChatAdmission;
    engramAdmission?: ManagedEngramChatAdmission;
    weightAdmission?: ManagedWeightChatAdmission;
  } & SteeringInferenceOptions & EngramInferenceOptions): AsyncGenerator<ManagedAdapterChatDelta, void, unknown> {
    if ([input.steeringAdmission, input.engramAdmission, input.weightAdmission].filter(Boolean).length > 1
      || input.engramAdmission && input.steering !== undefined || input.steeringAdmission && input.engram !== undefined
      || input.weightAdmission && (input.steering !== undefined || input.engram !== undefined))
      throw new Error("A saved Model request cannot compose different modification kinds.");
    const modification = input.weightAdmission ? ManagedWeightChatOptionsSchema.parse(
      input.savedModel === undefined ? {} : {savedModel: input.savedModel}) : input.engramAdmission ? EngramInferenceOptionsSchema.parse({
      ...(input.savedModel === undefined ? {} : {savedModel: input.savedModel}),
      ...(input.engram === undefined ? {} : {engram: input.engram}),
    }) : SteeringInferenceOptionsSchema.parse({
      ...(input.savedModel === undefined ? {} : { savedModel: input.savedModel }),
      ...(input.steering === undefined ? {} : { steering: input.steering }),
    });
    if (input.weightAdmission && (input.logicalModelName !== `personalized:model:${input.weightAdmission.selection.savedModel.modelProjectId}`
      || input.weightAdmission.version.teamId !== input.teamId
      || canonicalJson(modification) !== canonicalJson(input.weightAdmission.options)))
      throw new Error("Retain the exact learned-weight Model admission and original route before inference.");
    if (!input.engramAdmission && input.engram !== undefined) throw new Error("Retain the exact memory Model admission before inference.");
    const admission = input.weightAdmission ?? input.engramAdmission ?? input.steeringAdmission;
    const access = await resolveInferenceAccess(input.teamId);
    assertResolvedTeam(access.teamId, input.teamId);
    const assertInferenceOrigin = () => {
      if (admission && new URL(access.apiBaseUrl).origin !== admission.apiOrigin)
        throw new Error("The inference endpoint differs from this saved Model's original hosted API.");
    };
    assertInferenceOrigin();
    await admission?.assertCurrent();
    const requestUrl = `${access.apiBaseUrl}/v1/chat/completions`;
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("accept", "text/event-stream");
    headers.set("content-type", "application/json");
    headers.set("x-openpond-team-id", access.teamId);
    headers.set("idempotency-key", input.requestId);
    headers.set("x-request-id", input.requestId);
    await admission?.assertCurrent();
    assertInferenceOrigin();
    const response = await fetchImpl(
      requestUrl,
      {
        method: "POST",
        headers,
        signal: input.signal,
        body: JSON.stringify({
          model: input.logicalModelName,
          ...modification,
          messages: input.messages,
          stream: true,
          max_tokens: Math.min(4_096, Math.max(1, input.maxNewTokens ?? 512)),
          ...(input.temperature === undefined
            ? {}
            : { temperature: input.temperature }),
          ...(input.tools?.length ? { tools: input.tools } : {}),
          ...(input.toolChoice ? { tool_choice: input.toolChoice } : {}),
        }),
      }
    );
    if (!response.ok || !response.body) {
      const payload = await response.text().catch(() => "");
      throw new Error(
        `Managed adapter stream failed with status ${response.status}${
          payload ? `: ${payload.slice(0, 512)}` : ""
        }.`
      );
    }
    await admission?.assertCurrent();
    const serverRequestId = response.headers.get("x-openpond-request-id");
    let verifiedSteeringReceipt = false, verifiedEngramReceipt = false, verifiedWeightReceipt = false;
    for await (const raw of parseSse(response.body, input.signal)) {
      await admission?.assertCurrent();
      if (isRecord(raw) && isRecord(raw.error)) {
        throw new Error(typeof raw.error.code === "string" ? raw.error.code : "managed_adapter_stream_failed");
      }
      const envelope = isRecord(raw) && isRecord(raw.openpond) ? raw.openpond : null;
      const expectedReceipt = input.weightAdmission ? "weightReceipt" : input.engramAdmission ? "engramReceipt"
        : input.steeringAdmission ? "steeringReceipt" : null;
      if (["weightReceipt", "engramReceipt", "steeringReceipt", "decisionReceipt"].some(key =>
        envelope?.[key] !== undefined && key !== expectedReceipt))
        throw new Error("The Model returned a receipt for a different modification kind.");
      if (input.weightAdmission) {
        if (verifiedWeightReceipt) throw new Error("The learned-weight Model supplied output after its terminal receipt.");
        if (envelope?.weightReceipt !== undefined) {
          const receipt = WeightModelInferenceReceiptSchema.parse(envelope.weightReceipt), expected = input.weightAdmission;
          if (!serverRequestId || !isRecord(raw) || raw.id !== serverRequestId
            || raw.choices !== undefined && (!Array.isArray(raw.choices) || raw.choices.length !== 0))
            throw new Error("The learned-weight response lost its actual terminal inference identity.");
          // Request limits and engine generation are authenticated server
          // attestations. Verify every client-known immutable version, patch,
          // selection, route, runtime, image and cache-domain pin explicitly.
          await parseAndVerifyWeightModelInferenceReceipt(receipt, {teamId: input.teamId, requestId: serverRequestId,
            requestHash: receipt.requestHash, version: expected.version, selection: expected.selection,
            poolId: expected.poolId, routingBinding: expected.routingBinding, runtimeHash: expected.runtimeHash,
            workerImageDigest: expected.workerImageDigest, engineGeneration: receipt.engineGeneration,
            cacheNamespace: await canonicalSha256({requestHash: receipt.requestHash, runtimeHash: expected.runtimeHash, selection: expected.selection})});
          verifiedWeightReceipt = true;
          continue;
        }
      }
      if (input.engramAdmission) {
        if (verifiedEngramReceipt) throw new Error("The saved memory Model supplied output after its terminal receipt.");
        const envelope = isRecord(raw) && isRecord(raw.openpond) ? raw.openpond : null;
        if (envelope?.steeringReceipt !== undefined) throw new Error("The memory Model returned a different modification receipt.");
        if (envelope?.engramReceipt !== undefined) {
          const receipt = EngramInferenceReceiptSchema.parse(envelope.engramReceipt), expected = input.engramAdmission;
          if (!serverRequestId || !isRecord(raw) || raw.id !== serverRequestId)
            throw new Error("The saved memory response lost its actual inference request identity.");
          // Private admission limits and engine generation are authenticated
          // server attestations; exact public selection and routing stay pinned.
          await parseAndVerifyEngramInferenceReceipt(receipt, {teamId: input.teamId, requestId: serverRequestId,
            requestHash: receipt.requestHash, options: expected.options, selection: expected.selection,
            poolId: expected.poolId, routingBinding: expected.routingBinding, runtimeHash: expected.runtimeHash,
            workerImageDigest: expected.workerImageDigest, engineGeneration: receipt.engineGeneration,
            cacheNamespace: await canonicalSha256({requestHash: receipt.requestHash, runtimeHash: expected.runtimeHash, selection: expected.selection})});
          verifiedEngramReceipt = true;
        }
      }
      if (input.steeringAdmission) {
        if (verifiedSteeringReceipt) throw new Error("The saved Model supplied output after its terminal receipt.");
        const envelope = isRecord(raw) && isRecord(raw.openpond) ? raw.openpond : null;
        if (envelope?.engramReceipt !== undefined) throw new Error("The steering Model returned a different modification receipt.");
        if (envelope?.steeringReceipt !== undefined) {
          const receipt = SteeringInferenceReceiptSchema.parse(envelope.steeringReceipt), expected = input.steeringAdmission;
          if (!serverRequestId || !isRecord(raw) || raw.id !== serverRequestId)
            throw new Error("The saved Model response lost its actual inference request identity.");
          // The serving read exposes neither complete request admission limits
          // nor the engine epoch. requestHash and engineGeneration are values
          // attested by the authenticated server receipt, not independently
          // reconstructed client proof. Exact selection, request ID, binding,
          // runtime, pool, image and cache-domain checks remain client-owned.
          await parseAndVerifySteeringInferenceReceipt(receipt, {teamId: input.teamId, requestId: serverRequestId,
            requestHash: receipt.requestHash, options: expected.options, selection: expected.selection,
            poolId: expected.poolId, routingBinding: expected.routingBinding, runtimeHash: expected.runtimeHash,
            workerImageDigest: expected.workerImageDigest, engineGeneration: receipt.engineGeneration,
            cacheNamespace: await canonicalSha256({requestHash: receipt.requestHash, runtimeHash: expected.runtimeHash, selection: expected.selection})});
          verifiedSteeringReceipt = true;
        }
      }
      const usage = isRecord(raw) && isRecord(raw.usage) ? raw.usage : null;
      if (usage) yield { usage, raw };
      const choices =
        isRecord(raw) && Array.isArray(raw.choices) ? raw.choices : [];
      for (const choiceValue of choices) {
        const choice = isRecord(choiceValue) ? choiceValue : null;
        if (!choice) continue;
        const delta = isRecord(choice.delta) ? choice.delta : {};
        if (typeof delta.content === "string" && delta.content) {
          yield { text: delta.content, raw };
        }
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          yield {
            toolCalls: delta.tool_calls.filter(
              (value): value is HostedChatToolCall =>
                Boolean(value) && typeof value === "object"
            ),
            raw,
          };
        }
        if (typeof choice.finish_reason === "string") {
          yield { finishReason: choice.finish_reason, raw };
        }
      }
    }
    await admission?.assertCurrent();
    if (input.weightAdmission && !verifiedWeightReceipt)
      throw new Error("The learned-weight Model has not supplied verified terminal inference and cleanup evidence.");
    if (input.engramAdmission && !verifiedEngramReceipt)
      throw new Error("The saved memory Model has not supplied verified terminal inference and cleanup evidence.");
    if (input.steeringAdmission && !verifiedSteeringReceipt)
      throw new Error("The saved steering Model has not supplied verified terminal inference and cleanup evidence.");
  }

  return {
    listRegistry,
    capabilities,
    syncBinding,
    streamChat,
  };
}

export type ManagedAdapterRegistryClient = ReturnType<
  typeof createManagedAdapterRegistryClient
>;

function assertResolvedTeam(
  resolvedTeamId: string,
  expectedTeamId: string
): void {
  if (resolvedTeamId !== expectedTeamId) {
    throw new Error(
      "Managed adapter access resolved a different OpenPond team."
    );
  }
}

async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const payload of parseSseBlock(block)) yield payload;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    for (const payload of parseSseBlock(buffer)) yield payload;
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

function parseSseBlock(block: string): unknown[] {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return [];
  return [JSON.parse(data) as unknown];
}

function managedApiError(
  payload: { error?: unknown; message?: unknown },
  status: number,
  fallback: string
): string {
  const detail =
    typeof payload.message === "string"
      ? payload.message
      : typeof payload.error === "string"
      ? payload.error
      : fallback;
  return `Managed adapter API failed (${status}): ${detail.slice(0, 512)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
