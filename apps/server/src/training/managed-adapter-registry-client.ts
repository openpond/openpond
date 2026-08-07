import type {
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
} from "@openpond/cloud";
import { withVercelProtectionBypass } from "@openpond/cloud";
import type { ModelBinding } from "@openpond/contracts";
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
  status: "draft" | "qualified" | "retired";
};

export type ManagedRegistryCapabilities = {
  schemaVersion: "openpond.modelAdapterPlatformCapabilities.v1";
  baseModelProfileContractVersion: "openpond.baseModelProfile.v2";
  baseProfiles: ManagedRegistryBaseProfile[];
  lifecyclePolicyOwner: "sandbox";
};

export type ManagedAdapterChatDelta = {
  text?: string;
  usage?: unknown;
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
    const headers = withVercelProtectionBypass(
      requestUrl,
      hostedApiAuthHeaders(access.token),
      dependencies.env
    );
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
  }): AsyncGenerator<ManagedAdapterChatDelta, void, unknown> {
    const access = await resolveInferenceAccess(input.teamId);
    assertResolvedTeam(access.teamId, input.teamId);
    const requestUrl = `${access.apiBaseUrl}/v1/chat/completions`;
    const headers = withVercelProtectionBypass(
      requestUrl,
      hostedApiAuthHeaders(access.token),
      dependencies.env
    );
    headers.set("accept", "text/event-stream");
    headers.set("content-type", "application/json");
    headers.set("x-openpond-team-id", access.teamId);
    headers.set("idempotency-key", input.requestId);
    headers.set("x-request-id", input.requestId);
    const response = await fetchImpl(
      requestUrl,
      {
        method: "POST",
        headers,
        signal: input.signal,
        body: JSON.stringify({
          model: input.logicalModelName,
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
    for await (const raw of parseSse(response.body, input.signal)) {
      if (isRecord(raw) && isRecord(raw.error)) {
        throw new Error(
          typeof raw.error.code === "string"
            ? raw.error.code
            : "managed_adapter_stream_failed"
        );
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
    reader.releaseLock();
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
