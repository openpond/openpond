import { readFile } from "node:fs/promises";
import type {
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
} from "@openpond/cloud";
import {
  ManagedAdapterEvaluationEvidenceSchema,
  ManagedAdapterServingReceiptRecordSchema,
  type ManagedAdapterDeploymentEvidence,
  type ManagedAdapterEvaluationEvidence,
  type ManagedAdapterServingPoolEvidence,
  type ManagedAdapterServingReceiptRecord,
  type ModelBinding,
  type TrainingArtifact,
} from "@openpond/contracts";
import {
  hostedApiAuthHeaders,
  resolveManagedAdapterControlAccess,
  resolveManagedAdapterUserAccess,
} from "../openpond/hosted-api-access.js";
import {
  type OpenPondTrainingProvenancePayload,
} from "./managed-adapter-training-provenance.js";

export const MANAGED_QWEN3_8B_BASE_PROFILE_ID = "qwen3-8b-b968826d";
export const MANAGED_QWEN3_8B_BASE_REVISION =
  "b968826d9c46dd6066d109eabc6255188de91218";
export const MANAGED_QWEN3_0_6B_BASE_PROFILE_ID =
  "qwen3-0-6b-c1899de2";
export const MANAGED_QWEN3_0_6B_BASE_REVISION =
  "c1899de289a04d12100db370d81485cdf75e47ca";

export type ManagedRegistryArtifact = {
  id: string;
  source: string;
  sourceRef: string;
  state: string;
  promotable: boolean;
  customerBindingAllowed: boolean;
  contentHash: string | null;
  baseProfileId: string | null;
  evaluation: ManagedAdapterEvaluationEvidence | null;
};

export type ManagedRegistryDeployment = {
  id: string;
  artifactId: string;
  state: string;
  evidence: ManagedAdapterDeploymentEvidence | null;
};

export type ManagedRegistryServingPool = ManagedAdapterServingPoolEvidence;
export type ManagedRegistryServingReceipt =
  ManagedAdapterServingReceiptRecord;

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
  teamId: string,
) => Promise<{ apiBaseUrl: string; token: string; teamId: string }>;

export function createManagedAdapterRegistryClient(
  dependencies: ManagedAdapterRegistryClientDependencies = {},
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
    init: RequestInit = {},
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
        managedApiError(payload, response.status, response.statusText),
      );
    }
    return payload as T;
  }

  async function listRegistryWithAccess(
    resolveAccess: ManagedAdapterAccessResolver,
    teamId: string,
  ): Promise<{
    artifacts: ManagedRegistryArtifact[];
    deployments: ManagedRegistryDeployment[];
    servingPools: ManagedRegistryServingPool[];
    servingReceipts: ManagedRegistryServingReceipt[];
  }> {
    const [
      artifactPayload,
      deploymentPayload,
      servingPoolPayload,
      servingReceiptPayload,
    ] = await Promise.all([
      requestJson<{ artifacts?: unknown }>(
        resolveAccess,
        teamId,
        "/v1/model-adapters/artifacts?limit=200",
      ),
      requestJson<{ deployments?: unknown }>(
        resolveAccess,
        teamId,
        "/v1/model-adapters/deployments",
      ),
      requestJson<{ pools?: unknown }>(
        resolveAccess,
        teamId,
        "/v1/model-adapters/serving-pools",
      ),
      requestJson<{ receipts?: unknown }>(
        resolveAccess,
        teamId,
        "/v1/model-adapters/serving-receipts?limit=100",
      ),
    ]);
    return {
      artifacts: registryArtifacts(artifactPayload.artifacts),
      deployments: registryDeployments(deploymentPayload.deployments),
      servingPools: registryServingPools(servingPoolPayload.pools),
      servingReceipts: registryServingReceipts(
        servingReceiptPayload.receipts,
      ),
    };
  }
  const listRegistry = (teamId: string) =>
    listRegistryWithAccess(resolveRegistryAccess, teamId);
  const listTrustedRegistry = (teamId: string) =>
    listRegistryWithAccess(resolveTrustedSourceAccess, teamId);

  async function publishFireworksSource(
    input: FireworksSourceImport,
  ): Promise<ManagedRegistryArtifact> {
    return uploadFireworksSource({
      input,
      resolveAccess: resolveRegistryAccess,
      trustedProvenance: false,
    });
  }

  async function publishTrustedFireworksSource(
    input: FireworksSourceImport,
  ): Promise<ManagedRegistryArtifact> {
    return uploadFireworksSource({
      input,
      resolveAccess: resolveTrustedSourceAccess,
      trustedProvenance: true,
    });
  }

  async function publishTrustedOpenPondTrainingSource(
    input: OpenPondTrainingSourceImport,
  ): Promise<ManagedRegistryArtifact> {
    return uploadSource({
      input,
      resolveAccess: resolveTrustedSourceAccess,
      baseProfileId: input.baseProfileId,
      source: "openpond_training",
      sourceRef: input.lineageId,
      idempotencyKey:
        `openpond-training:v5:${input.lineageId}:${input.provenance.sourceArtifactSha256}`,
      sourceProvenance: input.provenance,
      sourceImportPath:
        "/v1/model-adapters/openpond-training-publications",
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
      baseProfileId: MANAGED_QWEN3_8B_BASE_PROFILE_ID,
      source: trustedProvenance
        ? "openpond_fireworks"
        : null,
      sourceRef: trustedProvenance ? input.lineageId : null,
      idempotencyKey:
        `openpond-fireworks:${input.lineageId}:${input.sourceArtifactSha256}`,
      sourceProvenance: trustedProvenance
        ? {
            schemaVersion:
              "openpond.modelAdapterSourceProvenance.v1",
            sourceSystem: "openpond_fireworks",
            trainingJobId: input.trainingJobId,
            trainingPlanId: input.trainingPlanId,
            sourceArtifactId: input.sourceArtifactId,
            sourceArtifactSha256:
              input.sourceArtifactSha256,
            tasksetId: input.tasksetId,
            tasksetHash: input.tasksetHash,
            ...(input.evaluationArtifactId
            && input.evaluationArtifactSha256
              ? {
                  evaluationArtifactId:
                    input.evaluationArtifactId,
                  evaluationArtifactSha256:
                    input.evaluationArtifactSha256,
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
        ? sourceImportPath ??
          "/v1/model-adapters/source-imports"
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
      },
    );
    if (
      created.upload.state === "created" ||
      created.upload.state === "uploading"
    ) {
      const filesByPath = new Map(
        input.files.map((file) => [file.path, file]),
      );
      if (
        created.uploadCapabilities.length !== input.files.length ||
        new Set(created.uploadCapabilities.map((item) => item.path))
          .size !== input.files.length
      ) {
        throw new Error(
          "Managed adapter upload capabilities did not match the declared files.",
        );
      }
      for (const capability of created.uploadCapabilities) {
        const file = filesByPath.get(capability.path);
        if (!file) {
          throw new Error(
            "Managed adapter upload returned an undeclared file capability.",
          );
        }
        assertUploadCapability(capability);
        const bytes = await readFileImpl(file.artifact.path);
        if (bytes.byteLength !== file.artifact.sizeBytes) {
          throw new Error(
            `Training artifact ${file.artifact.id} changed before upload.`,
          );
        }
        const response = await fetchImpl(capability.url, {
          method: "PUT",
          headers: capability.headers,
          body: new Uint8Array(bytes),
        });
        if (!response.ok) {
          throw new Error(
            `Managed adapter byte upload failed with status ${response.status}.`,
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
      `/v1/model-adapters/uploads/${encodeURIComponent(created.upload.id)}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ expectedVersion: created.upload.version }),
      },
    );
    return requiredRegistryArtifact(completed.artifact);
  }

  async function requestEvaluationWithAccess(
    resolveAccess: ManagedAdapterAccessResolver,
    input: {
      teamId: string;
      artifactId: string;
      role?: "chat_manual";
    },
  ): Promise<void> {
    await requestJson(
      resolveAccess,
      input.teamId,
      `/v1/model-adapters/artifacts/${encodeURIComponent(input.artifactId)}/evaluations`,
      {
        method: "POST",
        body: JSON.stringify({
          role: input.role ?? "chat_manual",
        }),
      },
    );
  }

  async function requestEvaluation(input: {
    teamId: string;
    artifactId: string;
    role?: "chat_manual";
  }): Promise<void> {
    return requestEvaluationWithAccess(resolveRegistryAccess, input);
  }
  const requestTrustedEvaluation = (input: {
    teamId: string;
    artifactId: string;
    role?: "chat_manual";
  }) => requestEvaluationWithAccess(resolveTrustedSourceAccess, input);

  async function deployArtifactWithAccess(
    resolveAccess: ManagedAdapterAccessResolver,
    input: {
      teamId: string;
      artifactId: string;
      idleTimeoutSeconds?: number;
    },
  ): Promise<ManagedRegistryDeployment> {
    const result = await requestJson<{
      deployment: ManagedRegistryDeployment;
    }>(
      resolveAccess,
      input.teamId,
      `/v1/model-adapters/artifacts/${encodeURIComponent(input.artifactId)}/deploy`,
      {
        method: "POST",
        body: JSON.stringify({
          idleTimeoutSeconds:
            input.idleTimeoutSeconds ?? 300,
        }),
      },
    );
    return requiredRegistryDeployment(result.deployment);
  }
  const deployArtifact = (input: {
    teamId: string;
    artifactId: string;
    idleTimeoutSeconds?: number;
  }) => deployArtifactWithAccess(resolveRegistryAccess, input);
  const deployTrustedArtifact = (input: {
    teamId: string;
    artifactId: string;
    idleTimeoutSeconds?: number;
  }) => deployArtifactWithAccess(resolveTrustedSourceAccess, input);

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
    },
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
      },
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
      },
    );
    if (!response.ok || !response.body) {
      const payload = await response.text().catch(() => "");
      throw new Error(
        `Managed adapter stream failed with status ${response.status}${payload ? `: ${payload.slice(0, 512)}` : ""}.`,
      );
    }
    for await (const raw of parseSse(response.body, input.signal)) {
      if (isRecord(raw) && isRecord(raw.error)) {
        throw new Error(
          typeof raw.error.code === "string"
            ? raw.error.code
            : "managed_adapter_stream_failed",
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
                Boolean(value) && typeof value === "object",
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
    publishFireworksSource,
    publishTrustedFireworksSource,
    publishTrustedOpenPondTrainingSource,
    requestEvaluation,
    requestTrustedEvaluation,
    deployArtifact,
    deployTrustedArtifact,
    syncBinding,
    syncTrustedBinding,
    streamChat,
  };
}

export type ManagedAdapterRegistryClient = ReturnType<
  typeof createManagedAdapterRegistryClient
>;

function registryArtifacts(value: unknown): ManagedRegistryArtifact[] {
  return Array.isArray(value)
    ? value.map(requiredRegistryArtifact)
    : [];
}

function registryDeployments(value: unknown): ManagedRegistryDeployment[] {
  if (!Array.isArray(value)) return [];
  return value.map(requiredRegistryDeployment);
}

function requiredRegistryDeployment(
  item: unknown,
): ManagedRegistryDeployment {
  if (
    !isRecord(item) ||
    typeof item.id !== "string" ||
    typeof item.artifactId !== "string" ||
    typeof item.state !== "string"
  ) {
    throw new Error(
      "Managed adapter registry returned an invalid deployment.",
    );
  }
  return {
    id: item.id,
    artifactId: item.artifactId,
    state: item.state,
    evidence: managedDeploymentEvidence(item),
  };
}

function requiredRegistryArtifact(value: unknown): ManagedRegistryArtifact {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.source !== "string" ||
    typeof value.sourceRef !== "string" ||
    typeof value.state !== "string" ||
    typeof value.promotable !== "boolean" ||
    typeof value.customerBindingAllowed !== "boolean"
  ) {
    throw new Error("Managed adapter registry returned an invalid artifact.");
  }
  return {
    id: value.id,
    source: value.source,
    sourceRef: value.sourceRef,
    state: value.state,
    promotable: value.promotable,
    customerBindingAllowed: value.customerBindingAllowed,
    contentHash:
      typeof value.contentHash === "string" ? value.contentHash : null,
    baseProfileId:
      typeof value.baseProfileId === "string"
        ? value.baseProfileId
        : null,
    evaluation: registryEvaluation(value.evaluation),
  };
}

function registryEvaluation(
  value: unknown,
): ManagedAdapterEvaluationEvidence | null {
  const parsed = ManagedAdapterEvaluationEvidenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function managedDeploymentEvidence(
  value: Record<string, unknown>,
): ManagedAdapterDeploymentEvidence | null {
  if (
    value.schemaVersion !== "openpond.adapterDeployment.v1"
    || typeof value.provider !== "string"
    || !("poolId" in value)
    || typeof value.opaqueModelName !== "string"
    || !("providerConfigurationHash" in value)
    || !("lastVerifiedAt" in value)
    || !("failureCode" in value)
    || typeof value.createdAt !== "string"
    || typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return value as ManagedAdapterDeploymentEvidence;
}

function registryServingPools(
  value: unknown,
): ManagedRegistryServingPool[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !isRecord(item)
      || typeof item.id !== "string"
      || typeof item.baseProfileId !== "string"
      || typeof item.provider !== "string"
      || typeof item.state !== "string"
      || typeof item.workersMin !== "number"
      || typeof item.workersMax !== "number"
      || typeof item.idleTimeoutSeconds !== "number"
      || !("providerConfigurationHash" in item)
      || !("leaseExpiresAt" in item)
      || !("estimatedHourlyUsd" in item)
      || !("lastReconciledAt" in item)
      || !("failureCode" in item)
      || typeof item.createdAt !== "string"
      || typeof item.updatedAt !== "string"
    ) {
      return [];
    }
    return [item as ManagedRegistryServingPool];
  });
}

function registryServingReceipts(
  value: unknown,
): ManagedRegistryServingReceipt[] {
  if (!Array.isArray(value)) return [];
  return value.map(
    (item) => ManagedAdapterServingReceiptRecordSchema.parse(item),
  );
}

function assertResolvedTeam(
  resolvedTeamId: string,
  expectedTeamId: string,
): void {
  if (resolvedTeamId !== expectedTeamId) {
    throw new Error(
      "Managed adapter access resolved a different OpenPond team.",
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
    throw new Error("Fireworks lineage does not contain a complete portable PEFT adapter.");
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
    /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(
      url.hostname,
    );
  if (!local && !awsS3 && !cloudflareR2) {
    throw new Error(
      `Managed adapter upload capability used an unsafe URL host (${url.protocol}//${url.hostname}).`,
    );
  }
  if (
    Object.keys(capability.headers).some(
      (name) =>
        name.toLowerCase() !== "content-type" &&
        !name.toLowerCase().startsWith("x-amz-"),
    )
  ) {
    throw new Error("Managed adapter upload capability used unsafe headers.");
  }
}

async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
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
  fallback: string,
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
