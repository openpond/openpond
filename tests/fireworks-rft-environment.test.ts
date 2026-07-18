import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  RftRecipeSchema,
  TasksetSchema,
  TrainingApprovalSchema,
  TrainingJobSchema,
  TrainingPlanSchema,
  type RftRecipe,
  type Taskset,
} from "../packages/contracts/src";
import {
  computeTasksetHash,
  contentHash,
} from "../packages/taskset-sdk/src";
import { createTrainingPlan } from "../packages/training-sdk/src";
import {
  createFireworksRftEnvironment,
  validateFireworksRftCallbackCredential,
} from "../apps/server/src/training/fireworks-rft-environment";
import {
  generateCrossSystemTasks,
  generateCrossSystemWorld,
} from "../apps/server/src/training/cross-system-operations";
import {
  tasksetFixture,
  withTrainingStore,
} from "./helpers/training-fixtures";

const API_KEY = "fw_rft_test_secret_never_persist";
const MODEL = "accounts/fireworks/models/qwen3-0p6b";

describe.sequential("Fireworks RFT remote environment", () => {
  test("accepts only a scoped callback credential for the active Fireworks account", async () => {
    expect(await validateFireworksRftCallbackCredential({
      apiKey: "scoped",
      expectedAccountIds: ["test-account"],
      request: async () => jsonResponse({
        accounts: [{ name: "accounts/test-account" }],
      }),
    })).toBe(true);
    expect(await validateFireworksRftCallbackCredential({
      apiKey: "scoped",
      expectedAccountIds: ["test-account"],
      request: async () => jsonResponse({
        accounts: [{ name: "accounts/other-account" }],
      }),
    })).toBe(false);
  });

  test("executes the exact versioned train world, reports reward, and replays duplicate callbacks idempotently", async () =>
    withTrainingStore(async ({ store }) => {
      const taskset = crossSystemTasksetFixture();
      const recipe = rftRecipe(taskset);
      const { plan, job } = await seedActiveRftJob(store, taskset, recipe);
      await store.saveTrainingJob(TrainingJobSchema.parse({
        ...job,
        id: "job_sft_sibling",
        approvalId: "approval_sft_sibling",
        metadata: {
          ...job.metadata,
          trainingMethod: "sft",
          providerJobId: "provider-sft-job",
        },
      }));
      await store.saveTrainingJob(TrainingJobSchema.parse({
        ...job,
        id: "job_rft_sibling",
        approvalId: "approval_rft_sibling",
        metadata: {
          ...job.metadata,
          providerJobId: "provider-other-rft-job",
        },
      }));
      const trainTask = taskset.tasks.find((task) => task.split === "train")!;
      const generated = generateCrossSystemTasks(
        generateCrossSystemWorld(taskset.metadata.worldSpecs![0] as never),
      ).find((task) => task.id === trainTask.metadata.taskId)!;
      const requests: Array<Record<string, unknown>> = [];
      const statuses: Array<Record<string, unknown>> = [];
      let modelCalls = 0;
      let returnBareAnswer = false;
      let bareAnswer: Record<string, unknown> = generated.expectedAnswer;
      const environment = createFireworksRftEnvironment({
        store,
        resolveCredential: credential,
        request: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(body);
          modelCalls += 1;
          if (returnBareAnswer) {
            return jsonResponse({
              choices: [{
                message: {
                  content: JSON.stringify(bareAnswer),
                },
              }],
            });
          }
          if (modelCalls === 1) {
            return jsonResponse({
              choices: [{
                message: {
                  content: "",
                  tool_calls: [{
                    id: "call_search",
                    type: "function",
                    function: {
                      name: "search_crm",
                      arguments: JSON.stringify({
                        query: "*",
                        fields: ["account_id"],
                        cursor: null,
                        limit: 1,
                      }),
                    },
                  }],
                },
              }],
            });
          }
          return jsonResponse({
            choices: [{
              message: {
                content: `ANSWER: ${JSON.stringify(generated.expectedAnswer)}`,
              },
            }],
          });
        },
        logger: () => ({
          info: (_message, metadata) => {
            if (metadata) statuses.push(metadata);
          },
          error: (_message, metadata) => {
            if (metadata) statuses.push(metadata);
          },
        }),
      });
      const payload = initPayload({
        rowId: trainTask.id,
        runId: "eval-protocol-generated-run-1",
        prompt: String(trainTask.input.prompt),
      });

      const first = await environment.handle(payload);
      expect(first).toMatchObject({
        status: 200,
        body: {
          status: "completed",
          reward_eligible: true,
          replayed: false,
        },
      });
      expect(Number(first.body.reward)).toBeGreaterThan(0.8);
      expect(Number(first.body.reward)).toBeLessThanOrEqual(1);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.model).toBe(
        `fireworks_ai/${MODEL}` +
          "#accounts/test-account/deployments/rft-hotreload-provider-rft-job",
      );
      expect(requests[0]?.reasoning_effort).toBe("none");
      expect(JSON.stringify(requests[0])).not.toContain("expectedAnswer");
      expect(JSON.stringify(requests[0])).not.toContain(JSON.stringify(generated.expectedAnswer));
      expect(JSON.stringify(requests[1])).toContain("tool");
      expect(statuses.some((status) =>
        (status.extras as Record<string, unknown> | undefined)?.reward_eligible === true,
      )).toBe(true);

      const receipts = await store.listRolloutTrajectoryReceipts({ jobId: job.id });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        planId: plan.id,
        tasksetId: taskset.id,
        tasksetHash: taskset.contentHash,
        taskId: trainTask.id,
        status: "succeeded",
        environment: {
          id: "cross-system-operations",
          version: CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
          worldId: generated.worldId,
          toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH,
        },
        policy: {
          modelId: MODEL,
          checkpointId: "checkpoint-1",
        },
        verifier: {
          outcome: "correct",
          rewardEligible: true,
        },
      });
      expect(receipts[0]?.trajectory?.steps.some((step) => step.kind === "tool_call")).toBe(true);
      expect(receipts[0]?.reward.normalized).toBe(first.body.reward);
      expect(JSON.stringify(receipts)).not.toContain(API_KEY);

      const replay = await environment.handle(payload);
      expect(replay).toMatchObject({
        status: 200,
        body: { replayed: true },
      });
      expect(modelCalls).toBe(2);
      expect(await store.listRolloutTrajectoryReceipts({ jobId: job.id })).toHaveLength(1);

      returnBareAnswer = true;
      const bare = await environment.handle({
        ...payload,
        metadata: {
          ...payload.metadata,
          rollout_id: "rollout-bare-answer",
        },
      });
      expect(bare).toMatchObject({
        status: 200,
        body: {
          reward: 0.6,
          reward_eligible: true,
        },
      });
      const shapedReceipts = await store.listRolloutTrajectoryReceipts({
        jobId: job.id,
      });
      expect(shapedReceipts.find((item) =>
        item.providerTrace.rolloutId === "rollout-bare-answer")).toMatchObject({
        status: "succeeded",
        failureClass: "parse_failure",
        verifier: {
          outcome: "parse_failure",
          exactAnswer: false,
        },
        reward: {
          eligible: true,
          raw: 0.6,
          normalized: 0.6,
          components: {
            semanticAnswer: 0.6,
            responseContract: 0,
            requiredToolEvidence: 0,
          },
        },
      });
      bareAnswer = {
        ...generated.expectedAnswer,
        account_ids: [],
      };
      const partial = await environment.handle({
        ...payload,
        metadata: {
          ...payload.metadata,
          rollout_id: "rollout-partial-answer",
        },
      });
      expect(partial).toMatchObject({
        status: 200,
        body: {
          reward: 0.3,
          reward_eligible: true,
        },
      });
      expect((await store.listRolloutTrajectoryReceipts({ jobId: job.id }))
        .find((item) =>
          item.providerTrace.rolloutId === "rollout-partial-answer"))
        .toMatchObject({
          verifier: {
            outcome: "parse_failure",
            exactAnswer: false,
          },
          reward: {
            normalized: 0.3,
            components: {
              semanticAnswer: 0.3,
              responseContract: 0,
              requiredToolEvidence: 0,
            },
          },
        });
      bareAnswer = generated.expectedAnswer;
      const checkpoint = await environment.handle({
        ...payload,
        completion_params: {
          ...payload.completion_params,
          model:
            "accounts/test-account/models/"
            + "provider-rft-job-epoch-0-chunk-0",
          checkpoint_id: "checkpoint-epoch-0-chunk-0",
        },
        metadata: {
          ...payload.metadata,
          rollout_id: "rollout-checkpoint-policy",
        },
      });
      expect(checkpoint).toMatchObject({
        status: 200,
        body: {
          reward_eligible: true,
          replayed: false,
        },
      });
      expect((await store.listRolloutTrajectoryReceipts({ jobId: job.id }))
        .find((item) =>
          item.providerTrace.rolloutId === "rollout-checkpoint-policy"))
        .toMatchObject({
          status: "succeeded",
          policy: {
            modelId:
              "accounts/test-account/models/"
              + "provider-rft-job-epoch-0-chunk-0",
            checkpointId: "checkpoint-epoch-0-chunk-0",
          },
        });
      expect(await environment.handle({
        ...payload,
        api_key: "wrong",
      })).toMatchObject({
        status: 401,
        body: { error: "unauthenticated_fireworks_rollout" },
      });
    }));

  test("enforces the recipe rollout budget before another model call", async () =>
    withTrainingStore(async ({ store }) => {
      const taskset = crossSystemTasksetFixture();
      const baseRecipe = rftRecipe(taskset);
      const recipe = RftRecipeSchema.parse({
        ...baseRecipe,
        resourceLimits: { ...baseRecipe.resourceLimits, maxRollouts: 1 },
      });
      const { job } = await seedActiveRftJob(store, taskset, recipe);
      const trainTask = taskset.tasks.find((task) => task.split === "train")!;
      let modelCalls = 0;
      const environment = createFireworksRftEnvironment({
        store,
        resolveCredential: credential,
        request: async () => {
          modelCalls += 1;
          return jsonResponse({
            choices: [{ message: { content: "ANSWER: {}" } }],
          });
        },
        logger: () => ({ info: () => undefined, error: () => undefined }),
      });
      const payload = initPayload({
        rowId: trainTask.id,
        runId: "eval-protocol-generated-run-budget",
        prompt: String(trainTask.input.prompt),
      });

      expect(await environment.handle(payload)).toMatchObject({ status: 200 });
      expect(await environment.handle({
        ...payload,
        metadata: { ...payload.metadata, rollout_id: "rollout-over-budget" },
      })).toMatchObject({
        status: 429,
        body: { error: expect.stringContaining("rollout budget exhausted") },
      });
      expect(modelCalls).toBe(1);
      expect(await store.listRolloutTrajectoryReceipts({ jobId: job.id })).toHaveLength(1);
    }));

  test("enforces the recipe payload limit before rollout execution", async () =>
    withTrainingStore(async ({ store }) => {
      const taskset = crossSystemTasksetFixture();
      const baseRecipe = rftRecipe(taskset);
      const recipe = RftRecipeSchema.parse({
        ...baseRecipe,
        resourceLimits: { ...baseRecipe.resourceLimits, maxPayloadBytes: 128 },
      });
      const { job } = await seedActiveRftJob(store, taskset, recipe);
      const trainTask = taskset.tasks.find((task) => task.split === "train")!;
      let modelCalls = 0;
      const environment = createFireworksRftEnvironment({
        store,
        resolveCredential: credential,
        request: async () => {
          modelCalls += 1;
          return jsonResponse({ choices: [{ message: { content: "ANSWER: {}" } }] });
        },
        logger: () => ({ info: () => undefined, error: () => undefined }),
      });

      expect(await environment.handle(initPayload({
        rowId: trainTask.id,
        runId: String(job.metadata.providerJobId),
        prompt: String(trainTask.input.prompt),
      }))).toMatchObject({
        status: 413,
        body: { error: expect.stringContaining("payload exceeded") },
      });
      expect(modelCalls).toBe(0);
      expect(await store.listRolloutTrajectoryReceipts({ jobId: job.id })).toHaveLength(0);
    }));

  test("fails closed on authentication, frozen rows, stale policy, and concurrency exhaustion", async () =>
    withTrainingStore(async ({ store }) => {
      const taskset = crossSystemTasksetFixture();
      const { job } = await seedActiveRftJob(store, taskset, rftRecipe(taskset));
      const trainTask = taskset.tasks.find((task) => task.split === "train")!;
      const frozenTask = taskset.tasks.find((task) => task.split === "frozen_eval")!;
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const environment = createFireworksRftEnvironment({
        store,
        resolveCredential: credential,
        maxConcurrency: 1,
        request: async () => {
          await gate;
          return jsonResponse({ choices: [{ message: { content: "ANSWER: {}" } }] });
        },
        logger: () => ({ info: () => undefined, error: () => undefined }),
      });
      const valid = initPayload({
        rowId: trainTask.id,
        runId: String(job.metadata.providerJobId),
        prompt: String(trainTask.input.prompt),
      });
      expect(await environment.handle({
        ...valid,
        api_key: "wrong",
        metadata: { ...valid.metadata, rollout_id: "rollout-auth" },
      })).toMatchObject({
        status: 401,
      });
      const frozenPayload = initPayload({
        rowId: frozenTask.id,
        runId: String(job.metadata.providerJobId),
        prompt: String(frozenTask.input.prompt),
      });
      expect(await environment.handle({
        ...frozenPayload,
        metadata: { ...frozenPayload.metadata, rollout_id: "rollout-frozen" },
      })).toMatchObject({ status: 409 });
      expect(await environment.handle({
        ...valid,
        metadata: { ...valid.metadata, rollout_id: "rollout-stale" },
        completion_params: { ...valid.completion_params, model: "accounts/fireworks/models/other" },
      })).toMatchObject({ status: 409 });

      const first = environment.handle({
        ...valid,
        metadata: { ...valid.metadata, rollout_id: "rollout-concurrent-1" },
      });
      await waitUntil(() => environment.activeCount() === 1);
      const second = await environment.handle({
        ...valid,
        metadata: { ...valid.metadata, rollout_id: "rollout-concurrent-2" },
      });
      expect(second).toMatchObject({
        status: 429,
        body: { error: "rollout_concurrency_exhausted", retryable: true },
      });
      releaseGate();
      await Promise.race([
        first,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("The admitted rollout did not finish after its model gate was released.")),
            2_000,
          );
          timer.unref?.();
        }),
      ]);
    }));
});

async function seedActiveRftJob(
  store: Parameters<Parameters<typeof withTrainingStore>[0]>[0]["store"],
  taskset: Taskset,
  recipe: RftRecipe,
) {
  await store.upsertTaskset(taskset);
  const draft = createTrainingPlan({
    taskset,
    destinationId: "fireworks",
    recipe,
    exportApproved: true,
    retentionDays: 7,
  });
  const compatibility = {
    schemaVersion: "openpond.trainingCompatibility.v1" as const,
    compatible: true,
    destinationId: "fireworks" as const,
    tasksetId: taskset.id,
    recipeMethod: "grpo" as const,
    issues: [],
    checkedAt: "2026-07-17T02:00:00.000Z",
  };
  const plan = TrainingPlanSchema.parse({
    ...draft,
    environmentPlacement: "provider_native",
    compatibility,
    estimatedCostUsd: 3,
    contentHash: contentHash({ ...draft, compatibility, contentHash: "" }),
  });
  await store.saveTrainingPlan(plan);
  const approval = TrainingApprovalSchema.parse({
    schemaVersion: "openpond.trainingApproval.v1",
    id: "approval_rft",
    planId: plan.id,
    bundleHash: "bundlehash00000000",
    destinationId: "fireworks",
    modelId: MODEL,
    method: "grpo",
    parameterization: "lora",
    maximumCostUsd: 9,
    approvedBy: "0xglu",
    approvedAt: "2026-07-17T02:00:00.000Z",
  });
  await store.saveTrainingApproval(approval);
  const job = TrainingJobSchema.parse({
    schemaVersion: "openpond.trainingJob.v1",
    id: "job_rft",
    planId: plan.id,
    bundleHash: approval.bundleHash,
    approvalId: approval.id,
    destinationId: "fireworks",
    status: "running",
    nonProduction: false,
    workerPid: null,
    startedAt: "2026-07-17T02:00:00.000Z",
    completedAt: null,
    error: null,
    createdAt: "2026-07-17T02:00:00.000Z",
    updatedAt: "2026-07-17T02:00:00.000Z",
    metadata: {
      trainingMethod: "grpo",
      providerJobId: "provider-rft-job",
      providerPolicyModel: MODEL,
      providerAccountId: "test-account",
    },
  });
  await store.saveTrainingJob(job);
  return { plan, approval, job };
}

function crossSystemTasksetFixture(): Taskset {
  const base = tasksetFixture();
  const specs = [
    { seed: 101, split: "train" as const, difficulty: "easy" as const },
    { seed: 202, split: "frozen_eval" as const, difficulty: "easy" as const },
  ];
  const generated = specs.flatMap((spec) =>
    generateCrossSystemTasks(generateCrossSystemWorld(spec)).filter((task) => task.phrasingVariant === 0),
  );
  const selected = [
    generated.find((task) => task.split === "train")!,
    generated.find((task) => task.split === "frozen_eval")!,
  ];
  const tasks = selected.map((task, index) => ({
    ...base.tasks[index]!,
    id: `authored_${task.id}`,
    clusterKey: task.clusterKey,
    split: task.split,
    input: { prompt: task.prompt },
    expectedOutput: { text: `ANSWER: ${JSON.stringify(task.expectedAnswer)}` },
    privilegedContextRef: `private_${task.id}`,
    tags: ["cross-system-operations"],
    metadata: { taskId: task.id, family: task.family, worldId: task.worldId },
  }));
  const draft = TasksetSchema.parse({
    ...base,
    id: "taskset_cross_system_rft",
    name: "Cross-System Operations RFT",
    objective: "Reconcile exact operational state through bounded tools.",
    status: "needs_review",
    tasks,
    graderFixtures: base.graderFixtures.map((fixture) => ({
      ...fixture,
      taskId: tasks[1]!.id,
    })),
    learningSignals: {
      demonstrations: [],
      preferences: [],
      corrections: [],
      feedback: [],
      rewards: [{
        id: "reward_cross_system",
        kind: "reward",
        taskId: tasks[0]!.id,
        sourceRefs: [base.sourceRefs[0]!.id],
        artifactRef: "cross-system-verifier",
        approved: true,
        confidence: 1,
        metadata: {},
      }],
      labels: [],
    },
    environment: {
      ...base.environment,
      kind: "stateful_harness",
      stateful: true,
      toolNames: ["search_crm", "query_billing", "search_support", "run_python"],
      metadata: { toolContractHash: CROSS_SYSTEM_TOOL_CONTRACT_HASH },
    },
    capabilities: {
      ...base.capabilities,
      taskKind: "single_agent",
      supportedSignals: ["reward"],
      compatibleMethods: ["grpo"],
      requiresTools: true,
      requiresState: true,
      environmentPlacements: ["remote", "provider_native"],
    },
    readiness: null,
    contentHash: "00000000",
    metadata: {
      ...base.metadata,
      trainingMethod: "grpo",
      worldSpecs: specs,
    },
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
      compatibleDestinationClasses: ["export", "hosted_byok"],
      blockers: [],
      warnings: [],
      baselineReportId: "baseline_cross_system",
      generatedAt: "2026-07-17T02:00:00.000Z",
    },
    contentHash: hash,
  });
}

function rftRecipe(taskset: Taskset): RftRecipe {
  return RftRecipeSchema.parse({
    schemaVersion: "openpond.rftRecipe.v1",
    method: "grpo",
    parameterization: "lora",
    baseModel: {
      id: MODEL,
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
    optimizer: { learningRate: 0.0002, maxSteps: 2 },
    reward: {
      graderId: "cross-system-exact-verifier",
      graderHash: contentHash(taskset.graders),
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

function initPayload(input: {
  rowId: string;
  runId: string;
  prompt: string;
}) {
  return {
    completion_params: {
      model:
        `fireworks_ai/${MODEL}` +
        "#accounts/test-account/deployments/rft-hotreload-provider-rft-job",
      checkpoint_id: "checkpoint-1",
      temperature: 0.8,
      max_tokens: 512,
    },
    messages: [{ role: "user", content: input.prompt }],
    tools: null,
    model_base_url: "https://tracing.fireworks.ai/rollout_id/test",
    api_key: API_KEY,
    metadata: {
      invocation_id: "invocation-1",
      experiment_id: "experiment-1",
      rollout_id: "rollout-1",
      run_id: input.runId,
      row_id: input.rowId,
    },
  };
}

async function credential() {
  return {
    value: API_KEY,
    source: "local_secret" as const,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error("Timed out waiting for condition.");
}
