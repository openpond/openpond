import path from "node:path";
import { expect } from "vitest";
import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  RftRecipeSchema,
  SftRecipeSchema,
  TasksetSchema,
  type RftRecipe,
  type SftRecipe,
} from "../../packages/contracts/src";
import { computeTasksetHash, contentHash } from "../../packages/taskset-sdk/src";
import {
  generateCrossSystemTasks,
  generateCrossSystemWorld,
} from "../../apps/server/src/training/cross-system-operations/world-generator";
import { tasksetFixture } from "./training-fixtures";

export const API_KEY = "fw_test_secret_that_must_never_appear";
export const resolveApprovalActor = async () => "0xglu";

export function fireworksRecipe(): SftRecipe {
  return SftRecipeSchema.parse({
    schemaVersion: "openpond.sftRecipe.v1",
    method: "sft",
    parameterization: "lora",
    baseModel: {
      id: "accounts/fireworks/models/qwen3-0p6b",
      revision: "fireworks-managed-model-resource-v1",
      tokenizerRevision: "fireworks-provider-managed",
      chatTemplateHash: "fireworks-qwen3-chat-v1",
    },
    dataset: {
      trainSplit: "train",
      validationSplit: "frozen_eval",
      completionOnly: true,
      maxSequenceLength: 512,
    },
    lora: {
      rank: 8,
      alpha: 16,
      dropout: 0.05,
      targetModules: [
        "q_proj",
        "k_proj",
        "v_proj",
        "o_proj",
        "gate_proj",
        "up_proj",
        "down_proj",
      ],
    },
    optimizer: {
      learningRate: 0.0002,
      epochs: 1,
      maxSteps: 8,
      batchSize: 1,
      gradientAccumulationSteps: 1,
      seed: 17,
    },
    resourceLimits: {
      cpuThreads: 1,
      memoryBytes: 1_000_000_000,
      wallTimeMs: 3_600_000,
    },
  });
}

export function rftTasksetFixture() {
  const base = tasksetFixture({ ready: true });
  const worldSpecs = [
    { seed: 101, split: "train" as const, difficulty: "easy" as const },
    { seed: 202, split: "frozen_eval" as const, difficulty: "easy" as const },
  ];
  const generatedTasks = worldSpecs.flatMap((spec) =>
    generateCrossSystemTasks(generateCrossSystemWorld(spec))
      .filter((task) => task.phrasingVariant === 0),
  );
  const selectedTasks = [
    generatedTasks.find((task) => task.split === "train")!,
    generatedTasks.find((task) => task.split === "frozen_eval")!,
  ];
  const tasks = selectedTasks.map((task, index) => ({
    ...base.tasks[index]!,
    id: `authored_${task.id}`,
    clusterKey: task.clusterKey,
    split: task.split,
    input: { prompt: task.prompt },
    expectedOutput: { text: `ANSWER: ${JSON.stringify(task.expectedAnswer)}` },
    privilegedContextRef: `private_${task.id}`,
    tags: ["cross-system-operations"],
    metadata: {
      taskId: task.id,
      family: task.family,
      worldId: task.worldId,
    },
  }));
  const draft = TasksetSchema.parse({
    ...base,
    status: "needs_review",
    readiness: null,
    capabilities: {
      ...base.capabilities,
      taskKind: "single_agent",
      supportedSignals: ["reward"],
      compatibleMethods: ["grpo"],
      rewardKinds: ["deterministic"],
      requiresTools: true,
      requiresState: true,
      environmentPlacements: ["provider_native"],
    },
    environment: {
      ...base.environment,
      kind: "stateful_harness",
      stateful: true,
      toolNames: ["search_crm", "query_billing", "search_support", "run_python"],
      metadata: {
        flagship: "cross-system-operations",
        toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
      },
    },
    tasks,
    graderFixtures: base.graderFixtures.map((fixture) => ({
      ...fixture,
      taskId: tasks[1]!.id,
      output: fixture.expectedPassed
        ? { text: tasks[1]!.expectedOutput!.text }
        : fixture.output,
    })),
    learningSignals: {
      demonstrations: [],
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: [{
        id: "reward_train",
        kind: "reward",
        taskId: tasks[0]!.id,
        sourceRefs: [base.sourceRefs[0]!.id],
        artifactRef: "private_deterministic_grader",
        approved: true,
        confidence: 1,
        metadata: {},
      }],
      labels: [],
    },
    metadata: {
      ...base.metadata,
      flagship: "cross-system-operations",
      trainingMethod: "grpo",
      worldSpecs,
    },
    contentHash: "00000000",
  });
  const hash = computeTasksetHash(draft);
  return TasksetSchema.parse({
    ...draft,
    status: "ready",
    readiness: {
      schemaVersion: "openpond.tasksetReadiness.v1",
      tasksetId: draft.id,
      tasksetHash: hash,
      ready: true,
      recommendedMethod: "grpo",
      trainingPath: { primaryMethod: "grpo", bootstrap: null },
      compatibleDestinationClasses: ["hosted_byok"],
      blockers: [],
      warnings: [],
      baselineReportId: "baseline_rft_fixture",
      baselineReward: {
        count: 4,
        mean: 0.5,
        min: 0,
        max: 1,
        variance: 0.25,
      },
      generatedAt: "2026-07-17T00:00:00.000Z",
    },
    contentHash: hash,
  });
}

export function fireworksRftRecipe(): RftRecipe {
  return RftRecipeSchema.parse({
    schemaVersion: "openpond.rftRecipe.v1",
    method: "grpo",
    parameterization: "lora",
    baseModel: {
      id: "accounts/fireworks/models/qwen3-0p6b",
      revision: "fireworks-managed-model-resource-v1",
      tokenizerRevision: "fireworks-provider-managed",
      chatTemplateHash: "fireworks-qwen3-chat-v1",
    },
    dataset: {
      trainSplit: "train",
      validationSplit: "frozen_eval",
      maxPromptTokens: 1024,
    },
    lora: { rank: 8 },
    rollout: {
      groupSize: 4,
      concurrency: 4,
      maxTurns: 15,
      maxOutputTokens: 512,
      temperature: 0.8,
      topP: 0.95,
      seed: 17,
    },
    optimizer: {
      learningRate: 0.0002,
      maxSteps: 2,
    },
    reward: {
      graderId: "expected_output",
      graderHash: "graderhash00000000",
      environmentId: "cross-system-operations",
      environmentVersion: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
      toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
    },
    resourceLimits: {
      wallTimeMs: 180_000,
      maxRollouts: 8,
      maxPayloadBytes: 1_000_000,
    },
  });
}

export function fireworksMock(options: {
  remainRunning?: boolean;
  failSftCreates?: number;
  inferenceUnavailable?: boolean;
  deploymentStatusFailures?: number;
} = {}) {
  const calls: string[] = [];
  let uploadedDataset = "";
  let remainingSftCreateFailures = options.failSftCreates ?? 0;
  let remainingDeploymentStatusFailures =
    options.deploymentStatusFailures ?? 0;
  const deployments = new Map<string, Record<string, unknown>>();
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL
      ? input
      : input.url);
    const route = `${init.method ?? "GET"} ${url.pathname}${url.search}`;
    calls.push(route);
    const authorization = new Headers(init.headers).get("authorization");
    if (url.hostname !== "weights.example.test") {
      expect(authorization).toBe(`Bearer ${API_KEY}`);
    }
    if (url.pathname === "/v1/accounts") {
      return jsonResponse({ accounts: [{ name: "accounts/test-account" }] });
    }
    if (
      url.pathname === "/v1/accounts/fireworks/models/qwen3-0p6b" ||
      url.pathname === "/v1/accounts/fireworks/models/qwen3-8b"
    ) {
      return jsonResponse({
        name: url.pathname.slice("/v1/".length),
        state: "READY",
        tunable: true,
        rlTunable: true,
        supportsLora: true,
      });
    }
    if (url.pathname === "/v1/accounts/-/deploymentShapes/-/versions") {
      return jsonResponse({
        deploymentShapeVersions: [{
          name: "accounts/fireworks/deploymentShapes/rft-qwen3-0p6b/versions/mock",
          validated: true,
          latestValidated: true,
          snapshot: {
            name: "accounts/fireworks/deploymentShapes/rft-qwen3-0p6b",
            baseModel: "accounts/fireworks/models/qwen3-0p6b",
            acceleratorCount: 1,
            acceleratorType: "NVIDIA_H200_141GB",
            precision: "BF16",
          },
        }],
      });
    }
    if (
      url.pathname === "/v1/accounts/test-account/deployments" &&
      init.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as {
        baseModel: string;
        minReplicaCount: number;
        maxReplicaCount: number;
        precision?: string;
        enableAddons?: boolean;
        enableHotReloadLatestAddon?: boolean;
        deploymentShape?: string;
      };
      const deploymentId = url.searchParams.get("deploymentId");
      if (deploymentId?.startsWith("op-eval-trained-")) {
        expect(body).toMatchObject({
          baseModel: "accounts/fireworks/models/qwen3-0p6b",
          enableAddons: false,
          enableHotReloadLatestAddon: true,
        });
        expect(body).not.toHaveProperty("deploymentShape");
      }
      const response = {
        name: `accounts/test-account/deployments/${deploymentId}`,
        baseModel: body.baseModel,
        state: url.searchParams.get("validateOnly") === "true"
          ? "STATE_UNSPECIFIED"
          : "CREATING",
        minReplicaCount: body.minReplicaCount,
        maxReplicaCount: body.maxReplicaCount,
        acceleratorCount: 1,
        acceleratorType: "NVIDIA_H100_80GB",
        precision: body.precision,
        enableAddons: body.enableAddons,
        enableHotReloadLatestAddon: body.enableHotReloadLatestAddon,
        deploymentShape:
          body.deploymentShape ?? "mock-single-h100",
      };
      if (
        deploymentId &&
        url.searchParams.get("validateOnly") !== "true"
      ) {
        deployments.set(deploymentId, {
          ...response,
          state: "READY",
          replicaStats: { readyReplicaCount: 1 },
        });
      }
      return jsonResponse(response);
    }
    if (
      url.pathname === "/v1/accounts/test-account/deployments" &&
      init.method !== "POST"
    ) {
      return jsonResponse({ deployments: [...deployments.values()] });
    }
    if (url.pathname.startsWith("/v1/accounts/test-account/deployments/")) {
      const deploymentId = url.pathname.split("/").at(-1)!;
      if (init.method === "DELETE") {
        deployments.delete(deploymentId);
        return jsonResponse({});
      }
      if (remainingDeploymentStatusFailures > 0) {
        remainingDeploymentStatusFailures -= 1;
        return jsonResponse({ code: 13, message: "" }, 500);
      }
      return jsonResponse(deployments.get(deploymentId) ?? {
        code: 5,
        message: "deployment not found",
      }, deployments.has(deploymentId) ? 200 : 404);
    }
    if (
      url.pathname === "/v1/accounts/test-account/deployedModels" &&
      init.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as {
        model: string;
        deployment: string;
        serverless: boolean;
        public: boolean;
      };
      expect(body).toMatchObject({
        model: "accounts/test-account/models/op-model-fixture",
        deployment: expect.stringContaining(
          "accounts/test-account/deployments/op-eval-trained-",
        ),
        serverless: false,
        public: false,
      });
      return jsonResponse({
        name: "accounts/test-account/deployedModels/op-eval-lora-fixture",
        ...body,
        state: "DEPLOYING",
      });
    }
    if (url.pathname === "/v1/accounts/test-account/deployedModels") {
      return jsonResponse({ deployedModels: [] });
    }
    if (url.pathname.startsWith("/v1/accounts/test-account/deployedModels/")) {
      if (init.method === "DELETE") return jsonResponse({});
      return jsonResponse({
        name: "accounts/test-account/deployedModels/op-eval-lora-fixture",
        state: "DEPLOYED",
      });
    }
    if (
      url.pathname === "/v1/accounts/test-account/datasets" &&
      init.method === "POST"
    ) {
      return jsonResponse({
        name: "accounts/test-account/datasets/op-sft-data-fixture",
        state: "UPLOADING",
      });
    }
    if (url.pathname.endsWith(":upload")) {
      const file = (init.body as FormData).get("file");
      if (!(file instanceof Blob)) throw new Error("Expected Fireworks dataset Blob.");
      uploadedDataset = await file.text();
      return jsonResponse({});
    }
    if (
      url.pathname.startsWith("/v1/accounts/test-account/datasets/") &&
      init.method !== "POST"
    ) {
      return jsonResponse({
        name: `accounts/test-account/datasets/${url.pathname.split("/").at(-1)}`,
        state: "READY",
      });
    }
    if (
      url.pathname === "/v1/accounts/test-account/supervisedFineTuningJobs" &&
      init.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("earlyStop");
      expect(body).toMatchObject({
        evalAutoCarveout: false,
        outputModel: expect.stringMatching(/^accounts\/test-account\/models\/op-model-/),
        purpose: "PURPOSE_PILOT",
      });
      if (remainingSftCreateFailures > 0) {
        remainingSftCreateFailures -= 1;
        return jsonResponse({
          code: 3,
          message: "invalid fine-tuning job",
        }, 400);
      }
      const jobId = url.searchParams.get("supervisedFineTuningJobId");
      return jsonResponse({
        name: `accounts/test-account/supervisedFineTuningJobs/${jobId}`,
        state: "JOB_STATE_PENDING",
        outputModel: "op-model-fixture",
        estimatedCost: { currencyCode: "USD", units: "2", nanos: 500_000_000 },
      });
    }
    if (
      url.pathname.includes("/supervisedFineTuningJobs/") &&
      url.pathname.endsWith(":cancel")
    ) {
      return jsonResponse({});
    }
    if (url.pathname.includes("/supervisedFineTuningJobs/")) {
      return jsonResponse({
        name: `accounts/test-account/supervisedFineTuningJobs/${url.pathname.split("/").at(-1)}`,
        state: options.remainRunning ? "JOB_STATE_RUNNING" : "JOB_STATE_COMPLETED",
        outputModel: "op-model-fixture",
        completedTime: options.remainRunning ? undefined : "2026-07-17T00:10:00.000Z",
        estimatedCost: { currencyCode: "USD", units: "2", nanos: 500_000_000 },
        jobProgress: { percent: options.remainRunning ? 25 : 100, epoch: 1 },
      });
    }
    if (url.pathname.endsWith(":getDownloadEndpoint")) {
      return jsonResponse({
        filenameToSignedUrls: {
          "adapter_model.safetensors": "https://weights.example.test/adapter_model.safetensors",
        },
      });
    }
    if (url.hostname === "weights.example.test") {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }
    if (url.pathname === "/inference/v1/chat/completions") {
      if (options.inferenceUnavailable) {
        return jsonResponse({
          error: {
            message: "Model not found, inaccessible, and/or not deployed",
          },
        }, 500);
      }
      const body = JSON.parse(String(init.body)) as { model: string };
      return jsonResponse({
        choices: [{
          message: {
            content: body.model.includes("op-model-fixture")
              || body.model.includes("op-eval-trained")
              ? "Goodbye friend"
              : "Incorrect base answer",
          },
        }],
        usage: { total_tokens: 8 },
      });
    }
    throw new Error(`Unexpected Fireworks request: ${route}`);
  };
  return {
    request,
    calls,
    get uploadedDataset() {
      return uploadedDataset;
    },
  };
}

export function fireworksRftMock(options: { optimizerSteps?: number; trainedOutput?: string } = {}) {
  const calls: string[] = [];
  const inferenceBodies: Array<Record<string, unknown>> = [];
  const deployments = new Map<string, Record<string, unknown>>();
  let uploadedDataset = "";
  let rftCreateBody: Record<string, unknown> | null = null;
  const request: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL
      ? input
      : input.url);
    const route = `${init.method ?? "GET"} ${url.pathname}${url.search}`;
    calls.push(route);
    const authorization = new Headers(init.headers).get("authorization");
    if (url.hostname !== "weights.example.test") {
      expect(authorization).toBe(`Bearer ${API_KEY}`);
    }
    if (url.pathname === "/v1/accounts") {
      return jsonResponse({ accounts: [{ name: "accounts/test-account" }] });
    }
    if (url.pathname === "/v1/accounts/fireworks/models/qwen3-0p6b") {
      return jsonResponse({
        name: "accounts/fireworks/models/qwen3-0p6b",
        state: "READY",
        tunable: true,
        rlTunable: true,
        supportsLora: true,
      });
    }
    if (url.pathname === "/v1/accounts/-/deploymentShapes/-/versions") {
      return jsonResponse({
        deploymentShapeVersions: [{
          name: "accounts/fireworks/deploymentShapes/rft-qwen3-0p6b/versions/mock",
          validated: true,
          latestValidated: true,
          snapshot: {
            name: "accounts/fireworks/deploymentShapes/rft-qwen3-0p6b",
            baseModel: "accounts/fireworks/models/qwen3-0p6b",
            acceleratorCount: 1,
            acceleratorType: "NVIDIA_H200_141GB",
            precision: "BF16",
          },
        }],
      });
    }
    if (
      url.pathname === "/v1/accounts/test-account/deployments" &&
      init.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as {
        baseModel: string;
        minReplicaCount: number;
        maxReplicaCount: number;
        precision?: string;
        enableAddons?: boolean;
        enableHotReloadLatestAddon?: boolean;
        deploymentShape?: string;
      };
      const deploymentId = url.searchParams.get("deploymentId");
      if (deploymentId?.startsWith("op-eval-trained-")) {
        expect(body).toMatchObject({
          baseModel: "accounts/fireworks/models/qwen3-0p6b",
          enableAddons: false,
          enableHotReloadLatestAddon: true,
        });
        expect(body).not.toHaveProperty("deploymentShape");
      }
      const response = {
        name: `accounts/test-account/deployments/${deploymentId}`,
        baseModel: body.baseModel,
        state: url.searchParams.get("validateOnly") === "true"
          ? "STATE_UNSPECIFIED"
          : "CREATING",
        minReplicaCount: body.minReplicaCount,
        maxReplicaCount: body.maxReplicaCount,
        acceleratorCount: 1,
        acceleratorType: "NVIDIA_H100_80GB",
        precision: body.precision,
        enableAddons: body.enableAddons,
        enableHotReloadLatestAddon: body.enableHotReloadLatestAddon,
        deploymentShape:
          body.deploymentShape ?? "mock-single-h100",
      };
      if (
        deploymentId &&
        url.searchParams.get("validateOnly") !== "true"
      ) {
        deployments.set(deploymentId, {
          ...response,
          state: "READY",
          replicaStats: { readyReplicaCount: 1 },
        });
      }
      return jsonResponse(response);
    }
    if (
      url.pathname === "/v1/accounts/test-account/deployments" &&
      init.method !== "POST"
    ) {
      return jsonResponse({ deployments: [...deployments.values()] });
    }
    if (url.pathname.startsWith("/v1/accounts/test-account/deployments/")) {
      const deploymentId = url.pathname.split("/").at(-1)!;
      if (init.method === "DELETE") {
        deployments.delete(deploymentId);
        return jsonResponse({});
      }
      return jsonResponse(deployments.get(deploymentId) ?? {
        code: 5,
        message: "deployment not found",
      }, deployments.has(deploymentId) ? 200 : 404);
    }
    if (
      url.pathname === "/v1/accounts/test-account/deployedModels" &&
      init.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as {
        model: string;
        deployment: string;
        serverless: boolean;
        public: boolean;
      };
      expect(body).toMatchObject({
        model: expect.stringMatching(
          /^accounts\/test-account\/models\/op-rft-model-/,
        ),
        deployment: expect.stringContaining(
          "accounts/test-account/deployments/op-eval-trained-",
        ),
        serverless: false,
        public: false,
      });
      return jsonResponse({
        name: "accounts/test-account/deployedModels/op-eval-rft-lora-fixture",
        ...body,
        state: "DEPLOYING",
      });
    }
    if (url.pathname === "/v1/accounts/test-account/deployedModels") {
      return jsonResponse({ deployedModels: [] });
    }
    if (url.pathname.startsWith("/v1/accounts/test-account/deployedModels/")) {
      if (init.method === "DELETE") return jsonResponse({});
      return jsonResponse({
        name: "accounts/test-account/deployedModels/op-eval-rft-lora-fixture",
        state: "DEPLOYED",
      });
    }
    if (
      url.pathname === "/v1/accounts/test-account/datasets" &&
      init.method === "POST"
    ) {
      return jsonResponse({
        name: "accounts/test-account/datasets/op-rft-data-fixture",
        state: "UPLOADING",
      });
    }
    if (url.pathname.endsWith(":upload")) {
      const file = (init.body as FormData).get("file");
      if (!(file instanceof Blob)) throw new Error("Expected Fireworks dataset Blob.");
      uploadedDataset = await file.text();
      return jsonResponse({});
    }
    if (
      url.pathname.startsWith("/v1/accounts/test-account/datasets/") &&
      init.method !== "POST"
    ) {
      return jsonResponse({
        name: `accounts/test-account/datasets/${url.pathname.split("/").at(-1)}`,
        state: "READY",
      });
    }
    if (
      url.pathname === "/v1/accounts/test-account/reinforcementFineTuningJobs" &&
      init.method === "POST"
    ) {
      rftCreateBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      const jobId = url.searchParams.get("reinforcementFineTuningJobId");
      return jsonResponse({
        name: `accounts/test-account/reinforcementFineTuningJobs/${jobId}`,
        state: "JOB_STATE_PENDING",
        trainingConfig: {
          ...(rftCreateBody.trainingConfig as Record<string, unknown>),
          outputModel: (rftCreateBody.trainingConfig as Record<string, unknown>).outputModel,
        },
        inferenceParameters: rftCreateBody.inferenceParameters,
        lossConfig: rftCreateBody.lossConfig,
        maxConcurrentRollouts: rftCreateBody.maxConcurrentRollouts,
        estimatedCost: { currencyCode: "USD", units: "2" },
      });
    }
    if (url.pathname.includes("/reinforcementFineTuningJobs/")) {
      const jobId = url.pathname.split("/").at(-1);
      return jsonResponse({
        name: `accounts/test-account/reinforcementFineTuningJobs/${jobId}`,
        state: "JOB_STATE_COMPLETED",
        completedTime: "2026-07-17T00:10:00.000Z",
        trainingConfig: {
          outputModel: "accounts/test-account/models/op-rft-model-fixture",
          baseModel: "accounts/fireworks/models/qwen3-0p6b",
          learningRate: 0.0002,
          loraRank: 16,
        },
        outputStats: JSON.stringify({
          optimizer_steps: options.optimizerSteps ?? 2,
          rollout_count: 8,
        }),
        outputMetrics: JSON.stringify({
          mean_reward: 0.92,
        }),
        jobProgress: { percent: 100, outputRows: 8 },
        estimatedCost: { currencyCode: "USD", units: "2" },
      });
    }
    if (url.pathname.endsWith(":getDownloadEndpoint")) {
      return jsonResponse({
        filenameToSignedUrls: {
          "adapter_model.safetensors": "https://weights.example.test/adapter_model.safetensors",
        },
      });
    }
    if (url.hostname === "weights.example.test") {
      return new Response(new Uint8Array([5, 6, 7, 8]), { status: 200 });
    }
    if (url.pathname === "/inference/v1/chat/completions") {
      const body = JSON.parse(String(init.body)) as {
        model: string;
        messages?: Array<{ role?: string }>;
      } & Record<string, unknown>;
      inferenceBodies.push(body);
      const trained =
        body.model.includes("op-rft-model") ||
        body.model.includes("op-eval-trained");
      const hasToolResult = body.messages?.some(
        (message) => message.role === "tool",
      ) ?? false;
      return jsonResponse({
        choices: [{
          message: trained && !hasToolResult
            ? {
                content: "",
                tool_calls: [{
                  id: "call_search_crm",
                  type: "function",
                  function: {
                    name: "search_crm",
                    arguments: JSON.stringify({
                      query: "*",
                      fields: ["account_id", "name"],
                      cursor: null,
                      limit: 20,
                    }),
                  },
                }],
              }
            : {
                content: trained
                  ? options.trainedOutput ?? "Goodbye friend"
                  : "Incorrect base answer",
              },
        }],
        usage: { total_tokens: 8 },
      });
    }
    throw new Error(`Unexpected Fireworks RFT request: ${route}`);
  };
  return {
    request,
    calls,
    get uploadedDataset() {
      return uploadedDataset;
    },
    get rftCreateBody() {
      return rftCreateBody;
    },
    inferenceBodies,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
