import { readFile } from "node:fs/promises";
import type {
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
} from "@openpond/cloud";
import type { ModelBinding, TrainingArtifact } from "@openpond/contracts";
import {
  registryArtifacts,
  registryDeployments,
  requiredRegistryArtifact,
  requiredRegistryCapabilities,
} from "./managed-adapter-registry-parsers.js";
import {
  hostedApiAuthHeaders,
  resolveManagedAdapterControlAccess,
  resolveManagedAdapterUserAccess,
} from "../openpond/hosted-api-access.js";
import { type OpenPondTrainingProvenancePayload } from "./managed-adapter-training-provenance.js";

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

type UploadCapability = {
  path: string;
  url: string;
  headers: Record<string, string>;
};

type PortableUploadFile = {
  artifact: TrainingArtifact;
  path: string;
  mediaType: "application/json" | "application/vnd.safetensors";
};

export type FireworksSourceImport = {
  teamId: string;
  lineageId: string;
  label: string;
  baseProfileId: string;
  trainingJobId: string;
  trainingPlanId: string;
  sourceArtifactId: string;
  sourceArtifactSha256: string;
  tasksetId: string;
  tasksetHash: string;
  evaluationArtifactId: string | null;
  evaluationArtifactSha256: string | null;
  providerRunId: string | null;
  files: PortableUploadFile[];
};

export type OpenPondTrainingSourceImport = {
  teamId: string;
  lineageId: string;
  label: string;
  baseProfileId: string;
  files: PortableUploadFile[];
  provenance: OpenPondTrainingProvenancePayload;
};

export type ManagedAdapterRegistryClientDependencies = {
  fetchImpl?: typeof fetch;
  readFileImpl?: typeof readFile;
  resolveRegistryAccess?: ManagedAdapterAccessResolver;
  resolveTrustedSourceAccess?: ManagedAdapterAccessResolver;
  resolveInferenceAccess?: ManagedAdapterAccessResolver;
};

type ManagedAdapterAccessResolver = (
  teamId: string
) => Promise<{ apiBaseUrl: string; token: string; teamId: string }>;

export function createManagedAdapterRegistryClient(
  dependencies: ManagedAdapterRegistryClientDependencies = {}
) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const resolveRegistryAccess =
    dependencies.resolveRegistryAccess ??
    ((teamId) => resolveManagedAdapterUserAccess({ teamId }));
  const resolveTrustedSourceAccess =
    dependencies.resolveTrustedSourceAccess ??
    ((teamId) => resolveManagedAdapterControlAccess({ teamId }));
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
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("accept", "application/json");
    headers.set("x-openpond-team-id", access.teamId);
    if (init.body) headers.set("content-type", "application/json");
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    const response = await fetchImpl(`${access.apiBaseUrl}${path}`, {
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
  const listTrustedRegistry = (teamId: string) =>
    listRegistryWithAccess(resolveTrustedSourceAccess, teamId);
  const capabilities = (teamId: string) =>
    capabilitiesWithAccess(resolveRegistryAccess, teamId);
  const trustedCapabilities = (teamId: string) =>
    capabilitiesWithAccess(resolveTrustedSourceAccess, teamId);

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

  async function publishFireworksSource(
    input: FireworksSourceImport
  ): Promise<ManagedRegistryArtifact> {
    return uploadFireworksSource({
      input,
      resolveAccess: resolveRegistryAccess,
      trustedProvenance: false,
    });
  }

  async function publishTrustedFireworksSource(
    input: FireworksSourceImport
  ): Promise<ManagedRegistryArtifact> {
    return uploadFireworksSource({
      input,
      resolveAccess: resolveTrustedSourceAccess,
      trustedProvenance: true,
    });
  }

  async function publishTrustedOpenPondTrainingSource(
    input: OpenPondTrainingSourceImport
  ): Promise<ManagedRegistryArtifact> {
    return uploadSource({
      input,
      resolveAccess: resolveTrustedSourceAccess,
      baseProfileId: input.baseProfileId,
      source: "openpond_training",
      sourceRef: input.lineageId,
      idempotencyKey: `openpond-training:v5:${input.lineageId}:${input.provenance.sourceArtifactSha256}`,
      sourceProvenance: input.provenance,
      sourceImportPath: "/v1/model-adapters/openpond-training-publications",
    });
  }

  async function uploadFireworksSource({
    input,
    resolveAccess,
    trustedProvenance,
  }: {
    input: FireworksSourceImport;
    resolveAccess: ManagedAdapterAccessResolver;
    trustedProvenance: boolean;
  }): Promise<ManagedRegistryArtifact> {
    return uploadSource({
      input,
      resolveAccess,
      baseProfileId: input.baseProfileId,
      source: trustedProvenance ? "openpond_fireworks" : null,
      sourceRef: trustedProvenance ? input.lineageId : null,
      idempotencyKey: `openpond-fireworks:${input.lineageId}:${input.sourceArtifactSha256}`,
      sourceProvenance: trustedProvenance
        ? {
            schemaVersion: "openpond.modelAdapterSourceProvenance.v1",
            sourceSystem: "openpond_fireworks",
            trainingJobId: input.trainingJobId,
            trainingPlanId: input.trainingPlanId,
            sourceArtifactId: input.sourceArtifactId,
            sourceArtifactSha256: input.sourceArtifactSha256,
            tasksetId: input.tasksetId,
            tasksetHash: input.tasksetHash,
            ...(input.evaluationArtifactId && input.evaluationArtifactSha256
              ? {
                  evaluationArtifactId: input.evaluationArtifactId,
                  evaluationArtifactSha256: input.evaluationArtifactSha256,
                }
              : {}),
            ...(input.providerRunId
              ? { providerRunId: input.providerRunId }
              : {}),
          }
        : null,
    });
  }

  async function uploadSource({
    input,
    resolveAccess,
    baseProfileId,
    source,
    sourceRef,
    idempotencyKey,
    sourceProvenance,
    sourceImportPath,
  }: {
    input: {
      teamId: string;
      label: string;
      files: PortableUploadFile[];
    };
    resolveAccess: ManagedAdapterAccessResolver;
    baseProfileId: string;
    source: "openpond_fireworks" | "openpond_training" | null;
    sourceRef: string | null;
    idempotencyKey: string;
    sourceProvenance: unknown | null;
    sourceImportPath?: string;
  }): Promise<ManagedRegistryArtifact> {
    assertPortableUploadFiles(input.files);
    const created = await requestJson<{
      upload: { id: string; version: number; state: string };
      uploadCapabilities: UploadCapability[];
    }>(
      resolveAccess,
      input.teamId,
      source
        ? sourceImportPath ?? "/v1/model-adapters/source-imports"
        : "/v1/model-adapters/uploads",
      {
        method: "POST",
        body: JSON.stringify({
          label: input.label,
          idempotencyKey,
          baseProfileId,
          ...(source && sourceRef && sourceProvenance
            ? {
                source,
                sourceRef,
                sourceProvenance,
              }
            : {}),
          files: input.files.map(({ artifact, path, mediaType }) => ({
            path,
            sizeBytes: artifact.sizeBytes,
            sha256: artifact.sha256,
            mediaType,
          })),
        }),
      }
    );
    if (
      created.upload.state === "created" ||
      created.upload.state === "uploading"
    ) {
      const filesByPath = new Map(input.files.map((file) => [file.path, file]));
      if (
        created.uploadCapabilities.length !== input.files.length ||
        new Set(created.uploadCapabilities.map((item) => item.path)).size !==
          input.files.length
      ) {
        throw new Error(
          "Managed adapter upload capabilities did not match the declared files."
        );
      }
      for (const capability of created.uploadCapabilities) {
        const file = filesByPath.get(capability.path);
        if (!file) {
          throw new Error(
            "Managed adapter upload returned an undeclared file capability."
          );
        }
        assertUploadCapability(capability);
        const bytes = await readFileImpl(file.artifact.path);
        if (bytes.byteLength !== file.artifact.sizeBytes) {
          throw new Error(
            `Training artifact ${file.artifact.id} changed before upload.`
          );
        }
        const response = await fetchImpl(capability.url, {
          method: "PUT",
          headers: capability.headers,
          body: new Uint8Array(bytes),
        });
        if (!response.ok) {
          throw new Error(
            `Managed adapter byte upload failed with status ${response.status}.`
          );
        }
      }
    } else if (
      (created.upload.state === "committing" ||
        created.upload.state === "committed") &&
      created.uploadCapabilities.length === 0
    ) {
      // Idempotent replay: complete below returns or resumes the same artifact.
    } else {
      throw new Error("Managed adapter upload is not resumable.");
    }
    const completed = await requestJson<{
      artifact: ManagedRegistryArtifact;
    }>(
      resolveAccess,
      input.teamId,
      `/v1/model-adapters/uploads/${encodeURIComponent(
        created.upload.id
      )}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ expectedVersion: created.upload.version }),
      }
    );
    return requiredRegistryArtifact(completed.artifact);
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
  const syncTrustedBinding = (input: {
    teamId: string;
    binding: ModelBinding;
    logicalModelName: string;
    artifactId: string;
    deploymentId: string;
    bindingVersion: number;
    sourceUpdatedAt: string;
    state: "active" | "inactive" | "deleted";
  }) => syncBindingWithAccess(resolveTrustedSourceAccess, input);

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
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("accept", "text/event-stream");
    headers.set("content-type", "application/json");
    headers.set("x-openpond-team-id", access.teamId);
    headers.set("idempotency-key", input.requestId);
    headers.set("x-request-id", input.requestId);
    const response = await fetchImpl(
      `${access.apiBaseUrl}/v1/chat/completions`,
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
    listTrustedRegistry,
    capabilities,
    trustedCapabilities,
    publishFireworksSource,
    publishTrustedFireworksSource,
    publishTrustedOpenPondTrainingSource,
    syncBinding,
    syncTrustedBinding,
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

function assertPortableUploadFiles(files: PortableUploadFile[]): void {
  const paths = files.map((file) => file.path);
  if (
    paths.length < 2 ||
    new Set(paths).size !== paths.length ||
    !paths.includes("adapter_config.json") ||
    !paths.some((path) => path.endsWith(".safetensors"))
  ) {
    throw new Error(
      "Fireworks lineage does not contain a complete portable PEFT adapter."
    );
  }
}

function assertUploadCapability(capability: UploadCapability): void {
  const url = new URL(capability.url);
  const local =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  const awsS3 =
    url.protocol === "https:" &&
    url.hostname.endsWith(".amazonaws.com") &&
    url.hostname.split(".").some((part) => part.startsWith("s3"));
  const cloudflareR2 =
    url.protocol === "https:" &&
    /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(url.hostname);
  if (!local && !awsS3 && !cloudflareR2) {
    throw new Error(
      `Managed adapter upload capability used an unsafe URL host (${url.protocol}//${url.hostname}).`
    );
  }
  if (
    Object.keys(capability.headers).some(
      (name) =>
        name.toLowerCase() !== "content-type" &&
        !name.toLowerCase().startsWith("x-amz-")
    )
  ) {
    throw new Error("Managed adapter upload capability used unsafe headers.");
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
