import type {
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
} from "@openpond/cloud";

const FIREWORKS_API_BASE_URL = "https://api.fireworks.ai";
const FIREWORKS_INFERENCE_BASE_URL = "https://api.fireworks.ai/inference/v1";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type FireworksAccount = {
  name: string;
  displayName?: string;
  state?: string;
  suspendState?: string;
};

export type FireworksModel = {
  name: string;
  state?: string;
  tunable?: boolean;
  rlTunable?: boolean;
  supportsLora?: boolean;
  supportsServerless?: boolean;
  trainingContextLength?: number;
  peftDetails?: { baseModel?: string; r?: number; targetModules?: string[] };
};

export type FireworksDataset = {
  name: string;
  state?: string;
  exampleCount?: string;
  estimatedTokenCount?: string;
  status?: { code?: string; message?: string };
};

export type FireworksMoney = {
  currencyCode?: string;
  units?: string;
  nanos?: number;
};

export type FireworksSftJob = {
  name: string;
  displayName?: string;
  state?: string;
  status?: { code?: string; message?: string };
  dataset?: string;
  outputModel?: string;
  baseModel?: string;
  createTime?: string;
  updateTime?: string;
  completedTime?: string;
  estimatedCost?: FireworksMoney;
  jobProgress?: {
    percent?: number;
    epoch?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalInputRequests?: number;
    totalProcessedRequests?: number;
    successfullyProcessedRequests?: number;
    failedRequests?: number;
  };
  metricsFileSignedUrl?: string;
  trainerLogsSignedUrl?: string;
};

export type FireworksRftJob = {
  name: string;
  displayName?: string;
  state?: string;
  status?: { code?: string; message?: string };
  dataset?: string;
  evaluator?: string;
  createTime?: string;
  updateTime?: string;
  completedTime?: string;
  estimatedCost?: FireworksMoney;
  trainingConfig?: {
    outputModel?: string;
    baseModel?: string;
    learningRate?: number;
    maxContextLength?: number;
    loraRank?: number;
    epochs?: number;
  };
  inferenceParameters?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    responseCandidatesCount?: number;
    extraBody?: string;
  };
  lossConfig?: { method?: string; klBeta?: number };
  maxConcurrentRollouts?: number;
  outputStats?: string;
  outputMetrics?: string;
  jobProgress?: FireworksSftJob["jobProgress"] & { outputRows?: number };
};

export type FireworksDeployment = {
  name?: string;
  baseModel?: string;
  displayName?: string;
  description?: string;
  createTime?: string;
  updateTime?: string;
  deleteTime?: string;
  state?: "STATE_UNSPECIFIED" | "CREATING" | "READY" | "DELETING" | "FAILED" | "UPDATING" | "DELETED";
  status?: { code?: string; message?: string };
  minReplicaCount?: number;
  maxReplicaCount?: number;
  replicaCount?: number;
  acceleratorCount?: number;
  acceleratorType?: string;
  precision?: string;
  enableAddons?: boolean;
  enableHotReloadLatestAddon?: boolean;
  deploymentShape?: string;
  replicaStats?: {
    pendingSchedulingReplicaCount?: number;
    downloadingModelReplicaCount?: number;
    initializingReplicaCount?: number;
    readyReplicaCount?: number;
  };
};

export type FireworksDeployedModel = {
  name?: string;
  displayName?: string;
  description?: string;
  createTime?: string;
  updateTime?: string;
  model?: string;
  deployment?: string;
  default?: boolean;
  state?: "STATE_UNSPECIFIED" | "UNDEPLOYING" | "DEPLOYING" | "DEPLOYED" | "UPDATING";
  status?: { code?: string; message?: string };
  serverless?: boolean;
  public?: boolean;
};

export type FireworksDeploymentShapeVersion = {
  name?: string;
  validated?: boolean;
  public?: boolean;
  latestValidated?: boolean;
  snapshot?: {
    name?: string;
    displayName?: string;
    baseModel?: string;
    acceleratorCount?: number;
    acceleratorType?: string;
    precision?: string;
    enableAddons?: boolean;
    numLoraDeviceCached?: number;
    numPeftDeviceCached?: number;
    presetType?: string;
  };
};

export function fireworksRftChunkSize(
  exampleCount: number,
  targetOptimizerSteps: number,
): number {
  const examples = Math.max(1, Math.trunc(exampleCount));
  const target = Math.max(1, Math.trunc(targetOptimizerSteps));
  return Math.max(1, Math.min(10_000, Math.ceil(examples / target)));
}

export function fireworksRftOptimizerSteps(
  exampleCount: number,
  chunkSize: number,
): number {
  return Math.ceil(
    Math.max(1, Math.trunc(exampleCount))
      / Math.max(1, Math.trunc(chunkSize)),
  );
}

export function fireworksRftRolloutCount(
  exampleCount: number,
  groupSize: number,
): number {
  return Math.max(1, Math.trunc(exampleCount))
    * Math.max(1, Math.trunc(groupSize));
}

type FireworksFetch = typeof fetch;

export class FireworksApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly request: FireworksFetch = fetch,
  ) {
    if (!apiKey.trim()) throw new Error("The saved Fireworks provider credential is unavailable.");
  }

  async resolveAccount(): Promise<FireworksAccount> {
    const payload = await this.json<{ accounts?: FireworksAccount[] }>("/v1/accounts");
    const accounts = payload.accounts ?? [];
    const account =
      accounts.find((candidate) =>
        candidate.state !== "SUSPENDED" &&
        (!candidate.suspendState || candidate.suspendState === "UNSUSPENDED")) ??
      accounts[0];
    if (!account?.name?.startsWith("accounts/")) {
      throw new Error("Fireworks returned no account accessible to the saved provider credential.");
    }
    if (
      account.state === "SUSPENDED" ||
      (account.suspendState && account.suspendState !== "UNSUSPENDED")
    ) {
      throw new Error(
        `Fireworks account ${resourceId(account.name)} is suspended (${account.suspendState ?? account.state}).`,
      );
    }
    return account;
  }

  async model(modelName: string): Promise<FireworksModel> {
    return this.json<FireworksModel>(`/v1/${qualifiedResource(modelName)}`);
  }

  async createDataset(input: {
    accountId: string;
    datasetId: string;
    displayName: string;
    exampleCount: number;
  }): Promise<FireworksDataset> {
    return this.json<FireworksDataset>(`/v1/accounts/${encodeURIComponent(input.accountId)}/datasets`, {
      method: "POST",
      body: JSON.stringify({
        datasetId: input.datasetId,
        dataset: {
          displayName: input.displayName,
          exampleCount: String(input.exampleCount),
          userUploaded: {},
          format: "CHAT",
        },
      }),
    });
  }

  async uploadDataset(input: {
    accountId: string;
    datasetId: string;
    filename: string;
    bytes: Buffer;
  }): Promise<void> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([input.bytes.toString("utf8")], { type: "application/jsonl" }),
      input.filename,
    );
    await this.json(
      `/v1/accounts/${encodeURIComponent(input.accountId)}/datasets/${encodeURIComponent(input.datasetId)}:upload`,
      { method: "POST", body: form },
    );
  }

  async dataset(accountId: string, datasetId: string): Promise<FireworksDataset> {
    return this.json<FireworksDataset>(
      `/v1/accounts/${encodeURIComponent(accountId)}/datasets/${encodeURIComponent(datasetId)}`,
    );
  }

  async createSftJob(input: {
    accountId: string;
    jobId: string;
    displayName: string;
    datasetName: string;
    outputModelId: string;
    baseModel: string;
    epochs: number;
    learningRate: number;
    maxContextLength: number;
    loraRank: number;
  }): Promise<FireworksSftJob> {
    const query = new URLSearchParams({ supervisedFineTuningJobId: input.jobId });
    return this.json<FireworksSftJob>(
      `/v1/accounts/${encodeURIComponent(input.accountId)}/supervisedFineTuningJobs?${query}`,
      {
        method: "POST",
        body: JSON.stringify({
          dataset: input.datasetName,
          displayName: input.displayName,
          outputModel: accountModelResource(input.accountId, input.outputModelId),
          baseModel: qualifiedResource(input.baseModel),
          epochs: Math.max(1, Math.ceil(input.epochs)),
          learningRate: input.learningRate,
          maxContextLength: input.maxContextLength,
          loraRank: input.loraRank,
          evalAutoCarveout: false,
          purpose: "PURPOSE_PILOT",
        }),
      },
    );
  }

  async sftJob(accountId: string, jobId: string): Promise<FireworksSftJob> {
    return this.json<FireworksSftJob>(
      `/v1/accounts/${encodeURIComponent(accountId)}/supervisedFineTuningJobs/${encodeURIComponent(jobId)}`,
    );
  }

  async cancelSftJob(accountId: string, jobId: string): Promise<void> {
    await this.json(
      `/v1/accounts/${encodeURIComponent(accountId)}/supervisedFineTuningJobs/${encodeURIComponent(jobId)}:cancel`,
      { method: "POST", body: "{}" },
    );
  }

  async createRftJob(input: {
    accountId: string;
    jobId: string;
    displayName: string;
    datasetName: string;
    evaluatorName: string;
    outputModelId: string;
    baseModel: string;
    learningRate: number;
    maxContextLength: number;
    loraRank: number;
    chunkSize: number;
    groupSize: number;
    maxOutputTokens: number;
    temperature: number;
    topP: number;
    maxConcurrentRollouts: number;
    lossMethod: "grpo" | "dapo" | "gspo-token";
    klBeta: number | null;
  }): Promise<FireworksRftJob> {
    const query = new URLSearchParams({
      reinforcementFineTuningJobId: input.jobId,
    });
    return this.json<FireworksRftJob>(
      `/v1/accounts/${encodeURIComponent(input.accountId)}/reinforcementFineTuningJobs?${query}`,
      {
        method: "POST",
        body: JSON.stringify({
          dataset: input.datasetName,
          evaluator: input.evaluatorName,
          displayName: input.displayName,
          evalAutoCarveout: false,
          trainingConfig: {
            outputModel: accountModelResource(input.accountId, input.outputModelId),
            baseModel: qualifiedResource(input.baseModel),
            learningRate: input.learningRate,
            maxContextLength: input.maxContextLength,
            loraRank: input.loraRank,
            epochs: 1,
            batchSizeSamples: input.groupSize,
            gradientAccumulationSteps: 1,
          },
          inferenceParameters: {
            maxOutputTokens: input.maxOutputTokens,
            temperature: input.temperature,
            topP: input.topP,
            responseCandidatesCount: input.groupSize,
            // Fireworks enables Qwen3 thinking by default. Keep provider-native
            // rollouts identical to OpenPond's train-signal baseline so the
            // output budget is spent on the answer that the grader consumes.
            extraBody: JSON.stringify({ reasoning_effort: "none" }),
          },
          chunkSize: Math.max(1, Math.min(10_000, input.chunkSize)),
          lossConfig: {
            method: providerRftLossMethod(input.lossMethod),
            ...(input.klBeta == null ? {} : { klBeta: input.klBeta }),
          },
          maxConcurrentRollouts: input.maxConcurrentRollouts,
          maxConcurrentEvaluations: Math.min(4, input.maxConcurrentRollouts),
          purpose: "PURPOSE_PILOT",
        }),
      },
    );
  }

  async rftJob(accountId: string, jobId: string): Promise<FireworksRftJob> {
    return this.json<FireworksRftJob>(
      `/v1/accounts/${encodeURIComponent(accountId)}/reinforcementFineTuningJobs/${encodeURIComponent(jobId)}`,
    );
  }

  async rftMetrics(
    accountId: string,
    jobId: string,
  ): Promise<unknown | null> {
    const response = await this.request(
      `${FIREWORKS_API_BASE_URL}/v1/accounts/${encodeURIComponent(accountId)}/reinforcementFineTuningJobs/${encodeURIComponent(jobId)}/metrics`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw await providerError(
        response,
        "Fireworks RFT metrics request",
        this.apiKey,
      );
    }
    const text = await boundedText(response);
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("Fireworks RFT metrics endpoint returned malformed JSON.");
    }
  }

  async cancelRftJob(accountId: string, jobId: string): Promise<void> {
    await this.json(
      `/v1/accounts/${encodeURIComponent(accountId)}/reinforcementFineTuningJobs/${encodeURIComponent(jobId)}:cancel`,
      { method: "POST", body: "{}" },
    );
  }

  async modelDownloadUrls(
    accountId: string,
    modelId: string,
  ): Promise<Record<string, string>> {
    const payload = await this.json<{ filenameToSignedUrls?: Record<string, string> }>(
      `/v1/accounts/${encodeURIComponent(accountId)}/models/${encodeURIComponent(modelId)}:getDownloadEndpoint`,
    );
    return payload.filenameToSignedUrls ?? {};
  }

  async createDeployment(input: {
    accountId: string;
    deploymentId: string;
    baseModel: string;
    displayName: string;
    description: string;
    validateOnly: boolean;
    acceleratorType?: "NVIDIA_A100_80GB" | "NVIDIA_H100_80GB";
    precision?: "BF16";
    enableAddons?: boolean;
    deploymentShape?: string;
    enableHotReloadLatestAddon?: boolean;
    purpose?: string;
  }): Promise<FireworksDeployment> {
    const query = new URLSearchParams({
      deploymentId: input.deploymentId,
      validateOnly: String(input.validateOnly),
      disableSpeculativeDecoding: "true",
    });
    return this.json<FireworksDeployment>(
      `/v1/accounts/${encodeURIComponent(input.accountId)}/deployments?${query}`,
      {
        method: "POST",
        body: JSON.stringify({
          baseModel: qualifiedResource(input.baseModel),
          displayName: input.displayName,
          description: input.description,
          minReplicaCount: 1,
          maxReplicaCount: 1,
          ...(input.deploymentShape
            ? { deploymentShape: qualifiedResource(input.deploymentShape) }
            : {
                acceleratorCount: 1,
                acceleratorType:
                  input.acceleratorType ?? "NVIDIA_H100_80GB",
                ...(input.precision ? { precision: input.precision } : {}),
              }),
          ...(input.enableAddons != null
            ? { enableAddons: input.enableAddons }
            : {}),
          ...(input.enableHotReloadLatestAddon != null
            ? {
                enableHotReloadLatestAddon:
                  input.enableHotReloadLatestAddon,
              }
            : {}),
          annotations: {
            "openpond-purpose": input.purpose ?? "frozen-evaluation",
          },
        }),
      },
    );
  }

  async listDeploymentShapeVersions(
    baseModel: string,
  ): Promise<FireworksDeploymentShapeVersion[]> {
    const query = new URLSearchParams({
      filter:
        `snapshot.base_model="${qualifiedResource(baseModel)}" AND latest_validated=true`,
      orderBy: "create_time desc",
      pageSize: "200",
    });
    const payload = await this.json<{
      deploymentShapeVersions?: FireworksDeploymentShapeVersion[];
    }>(`/v1/accounts/-/deploymentShapes/-/versions?${query}`);
    return payload.deploymentShapeVersions ?? [];
  }

  async loadLora(input: {
    accountId: string;
    model: string;
    deployment: string;
    displayName: string;
    description: string;
    replaceMergedAddon?: boolean;
  }): Promise<FireworksDeployedModel> {
    const query = input.replaceMergedAddon
      ? "?replaceMergedAddon=true"
      : "";
    return this.json<FireworksDeployedModel>(
      `/v1/accounts/${encodeURIComponent(input.accountId)}/deployedModels${query}`,
      {
        method: "POST",
        body: JSON.stringify({
          displayName: input.displayName,
          description: input.description,
          model: qualifiedResource(input.model),
          deployment: qualifiedResource(input.deployment),
          default: false,
          serverless: false,
          public: false,
        }),
      },
    );
  }

  async deployedModel(
    accountId: string,
    deployedModelId: string,
  ): Promise<FireworksDeployedModel> {
    return this.json<FireworksDeployedModel>(
      `/v1/accounts/${encodeURIComponent(accountId)}/deployedModels/${encodeURIComponent(deployedModelId)}`,
    );
  }

  async listDeployedModels(accountId: string): Promise<FireworksDeployedModel[]> {
    const payload = await this.json<{ deployedModels?: FireworksDeployedModel[] }>(
      `/v1/accounts/${encodeURIComponent(accountId)}/deployedModels?pageSize=200`,
    );
    return payload.deployedModels ?? [];
  }

  async unloadLora(
    accountId: string,
    deployedModelId: string,
  ): Promise<void> {
    await this.json(
      `/v1/accounts/${encodeURIComponent(accountId)}/deployedModels/${encodeURIComponent(deployedModelId)}`,
      { method: "DELETE" },
    );
  }

  async deployment(
    accountId: string,
    deploymentId: string,
  ): Promise<FireworksDeployment> {
    return this.json<FireworksDeployment>(
      `/v1/accounts/${encodeURIComponent(accountId)}/deployments/${encodeURIComponent(deploymentId)}`,
    );
  }

  async listDeployments(accountId: string): Promise<FireworksDeployment[]> {
    const payload = await this.json<{ deployments?: FireworksDeployment[] }>(
      `/v1/accounts/${encodeURIComponent(accountId)}/deployments?pageSize=200`,
    );
    return payload.deployments ?? [];
  }

  async deleteDeployment(
    accountId: string,
    deploymentId: string,
  ): Promise<void> {
    await this.json(
      `/v1/accounts/${encodeURIComponent(accountId)}/deployments/${encodeURIComponent(deploymentId)}?ignoreChecks=true`,
      { method: "DELETE" },
    );
  }

  async download(url: string): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("Fireworks artifact URL must use HTTPS.");
    const response = await this.request(parsed, { method: "GET" });
    if (!response.ok) throw await providerError(response, "Fireworks artifact download");
    return Buffer.from(await response.arrayBuffer());
  }

  async chatCompletion(input: {
    model: string;
    messages: Array<{ role: string; content: string | null }>;
    maxTokens: number;
    temperature?: number;
    reasoningEffort?: "none";
    deployment?: string;
  }): Promise<{ text: string; usage: unknown }> {
    const completion = await this.chatCompletionWithTools({
      ...input,
      messages: input.messages as HostedChatMessage[],
    });
    if (completion.toolCalls.length) {
      throw new Error("Fireworks inference returned tool calls for a text-only request.");
    }
    return { text: completion.text, usage: completion.usage };
  }

  async chatCompletionWithTools(input: {
    model: string;
    messages: HostedChatMessage[];
    maxTokens: number;
    temperature?: number;
    reasoningEffort?: "none";
    tools?: HostedChatTool[];
    toolChoice?: HostedChatToolChoice;
    deployment?: string;
  }): Promise<{
    text: string;
    toolCalls: HostedChatToolCall[];
    usage: unknown;
  }> {
    const payload = await this.json<{
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: HostedChatToolCall[];
        };
      }>;
      usage?: unknown;
    }>("/chat/completions", {
      baseUrl: FIREWORKS_INFERENCE_BASE_URL,
      method: "POST",
      headers: input.deployment
        ? { "fireworks-deployment": qualifiedResource(input.deployment) }
        : undefined,
      body: JSON.stringify({
        model: qualifiedResource(input.model),
        messages: input.messages,
        max_tokens: input.maxTokens,
        temperature: input.temperature ?? 0,
        ...(input.reasoningEffort
          ? { reasoning_effort: input.reasoningEffort }
          : {}),
        ...(input.tools?.length ? { tools: input.tools } : {}),
        ...(input.toolChoice ? { tool_choice: input.toolChoice } : {}),
      }),
    });
    const message = payload.choices?.[0]?.message;
    const text = message?.content ?? "";
    const toolCalls = message?.tool_calls ?? [];
    if (typeof text !== "string") {
      throw new Error("Fireworks inference returned invalid assistant content.");
    }
    if (!text && !toolCalls.length) {
      throw new Error("Fireworks inference returned neither assistant text nor tool calls.");
    }
    return {
      text,
      toolCalls,
      usage: payload.usage ?? null,
    };
  }

  private async json<T = Record<string, unknown>>(
    path: string,
    init: RequestInit & { baseUrl?: string } = {},
  ): Promise<T> {
    const baseUrl = init.baseUrl ?? FIREWORKS_API_BASE_URL;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (typeof init.body === "string") headers.set("Content-Type", "application/json");
    const response = await this.request(`${baseUrl}${path}`, { ...init, headers });
    if (!response.ok) throw await providerError(response, "Fireworks API request", this.apiKey);
    if (response.status === 204) return {} as T;
    const text = await boundedText(response);
    if (!text.trim()) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("Fireworks API returned malformed JSON.");
    }
  }
}

export function fireworksMoneyUsd(value: FireworksMoney | undefined): number | null {
  if (!value) return null;
  const units = Number(value.units ?? 0);
  const nanos = Number(value.nanos ?? 0);
  if (!Number.isFinite(units) || !Number.isFinite(nanos)) return null;
  return units + nanos / 1_000_000_000;
}

export function resourceId(name: string): string {
  return name.split("/").filter(Boolean).at(-1) ?? name;
}

function qualifiedResource(name: string): string {
  return name.replace(/^\/+/, "");
}

function accountModelResource(accountId: string, modelId: string): string {
  const resource = qualifiedResource(modelId);
  if (resource.startsWith("accounts/")) return resource;
  return `accounts/${accountId}/models/${resourceId(resource)}`;
}

function providerRftLossMethod(
  method: "grpo" | "dapo" | "gspo-token",
): "GRPO" | "DAPO" | "GSPO_TOKEN" {
  if (method === "dapo") return "DAPO";
  if (method === "gspo-token") return "GSPO_TOKEN";
  return "GRPO";
}

async function providerError(
  response: Response,
  label: string,
  secret?: string,
): Promise<Error> {
  const body = await boundedText(response);
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; code?: string };
      status?: { message?: string; code?: string };
    };
    detail =
      parsed.error?.message ??
      parsed.status?.message ??
      parsed.error?.code ??
      parsed.status?.code ??
      detail;
  } catch {
    // Retain the bounded text response.
  }
  let safe = detail
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:fw|sk)[-_][A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .slice(0, 2_000);
  if (secret) safe = safe.replaceAll(secret, "[redacted]");
  return new Error(`${label} failed (${response.status}): ${safe || response.statusText}`);
}

async function boundedText(response: Response): Promise<string> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Fireworks API response exceeded the safe response limit.");
  }
  return bytes.toString("utf8");
}
