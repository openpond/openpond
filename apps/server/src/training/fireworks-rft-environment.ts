import { createHash, timingSafeEqual } from "node:crypto";
import {
  CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  DATASET_EXACT_ANSWER_ENVIRONMENT_ID,
  DATASET_EXACT_ANSWER_ENVIRONMENT_VERSION,
  DATASET_NO_TOOLS_CONTRACT_HASH,
  RolloutTrajectoryReceiptSchema,
  type GradeResult,
  type RolloutTrajectoryReceipt,
  type RftRecipe,
  type TaskDataRecord,
  type TaskAttemptResult,
  type TrainingJob,
  type TrainingPlan,
} from "@openpond/contracts";
import type {
  HostedChatMessage,
  HostedChatTool,
  HostedChatToolCall,
} from "@openpond/cloud";
import { contentHash } from "@openpond/taskset-sdk";
import {
  Status,
  createRolloutLogger,
  initRequestSchema,
  type InitRequest,
} from "eval-protocol";
import type { SqliteStore } from "../store/store.js";
import {
  resolveCrossSystemTrainTask,
  runCrossSystemRollout,
  verifyCrossSystemTrajectory,
} from "./cross-system-operations/index.js";
import type { FireworksProviderCredential } from "./fireworks-destination.js";
import {
  resolveExactAnswerTask,
  runExactAnswerRollout,
} from "./fireworks-exact-answer-environment.js";
import { rftTrainingReward } from "./rft-training-reward.js";

const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
const ACTIVE_JOB_STATUSES = new Set<TrainingJob["status"]>([
  "queued",
  "starting",
  "running",
  "reconciling",
]);

type RolloutLogger = {
  info(message: string, metadata?: Record<string, unknown>): unknown;
  error(message: string, metadata?: Record<string, unknown>): unknown;
};

export type FireworksRftEnvironmentResponse = {
  status: number;
  body: Record<string, unknown>;
};

export type FireworksRftCallbackCredentialValidator = (input: {
  apiKey: string;
  expectedAccountIds: string[];
}) => Promise<boolean>;

export function createFireworksRftEnvironment(input: {
  store: SqliteStore;
  resolveCredential: () => Promise<FireworksProviderCredential | null>;
  request?: typeof fetch;
  validateCallbackCredential?: FireworksRftCallbackCredentialValidator;
  resolveTask?: (input: {
    tasksetId: string;
    taskId: string;
    split: "train";
  }) => Promise<TaskDataRecord>;
  gradeAttempt?: (input: {
    tasksetId: string;
    taskId: string;
    attempt: TaskAttemptResult;
  }) => Promise<GradeResult>;
  maxConcurrency?: number;
  allowedModelOrigins?: string[];
  timestamp?: () => string;
  logger?: (rolloutId: string, options: { gatewayBaseUrl: string; apiKey: string }) => RolloutLogger;
}) {
  const request = input.request ?? fetch;
  const maxConcurrency = Math.max(1, Math.min(32, input.maxConcurrency ?? 4));
  const allowedModelOrigins = new Set(input.allowedModelOrigins ?? []);
  const timestamp = input.timestamp ?? (() => new Date().toISOString());
  const loggerFactory = input.logger ?? ((rolloutId, options) =>
    createRolloutLogger(rolloutId, { ...options, name: "openpond-rft" }));
  const inFlight = new Map<string, Promise<FireworksRftEnvironmentResponse>>();
  const validatedCallbackCredentials = new Map<string, {
    accountKey: string;
    expiresAt: number;
  }>();
  const reservedRolloutsByJob = new Map<string, Set<string>>();
  let admissionQueue = Promise.resolve();
  let active = 0;

  async function reserveRollout(
    job: TrainingJob,
    recipe: RftRecipe,
    rolloutId: string,
  ): Promise<() => void> {
    let unlock!: () => void;
    const previous = admissionQueue;
    admissionQueue = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      const existingRollouts = await input.store.listRolloutTrajectoryReceipts({
        jobId: job.id,
      });
      const existingIds = new Set(
        existingRollouts.map((candidate) => candidate.providerTrace.rolloutId),
      );
      const reserved = reservedRolloutsByJob.get(job.id) ?? new Set<string>();
      const uncommittedReservations = [...reserved].filter(
        (candidate) => !existingIds.has(candidate),
      ).length;
      const alreadyCommitted = existingIds.has(rolloutId);
      if (
        !alreadyCommitted
        && existingRollouts.length + uncommittedReservations
          >= recipe.resourceLimits.maxRollouts
      ) {
        throw new Error(
          `RFT rollout budget exhausted at ${recipe.resourceLimits.maxRollouts} admitted rollouts.`,
        );
      }
      reserved.add(rolloutId);
      reservedRolloutsByJob.set(job.id, reserved);
      return () => {
        reserved.delete(rolloutId);
        if (!reserved.size) reservedRolloutsByJob.delete(job.id);
      };
    } finally {
      unlock();
    }
  }

  async function handle(payload: unknown): Promise<FireworksRftEnvironmentResponse> {
    const parsed = initRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        status: 400,
        body: {
          error: "invalid_fireworks_init_request",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      };
    }
    const credential = await input.resolveCredential();
    if (!credential || !parsed.data.api_key) {
      return { status: 401, body: { error: "unauthenticated_fireworks_rollout" } };
    }
    if (!secureEqual(credential.value, parsed.data.api_key)) {
      const expectedAccountIds = await activeRftProviderAccountIds(input.store);
      const accountKey = expectedAccountIds.sort().join(",");
      const digest = createHash("sha256").update(parsed.data.api_key).digest("hex");
      const cached = validatedCallbackCredentials.get(digest);
      const valid = cached?.accountKey === accountKey && cached.expiresAt > Date.now()
        ? true
        : await input.validateCallbackCredential?.({
          apiKey: parsed.data.api_key,
          expectedAccountIds,
        }) ?? false;
      if (!valid) {
        return { status: 401, body: { error: "unauthenticated_fireworks_rollout" } };
      }
      validatedCallbackCredentials.set(digest, {
        accountKey,
        expiresAt: Date.now() + 5 * 60_000,
      });
    }
    const rolloutId = parsed.data.metadata.rollout_id;
    const existingFlight = inFlight.get(rolloutId);
    if (existingFlight) return existingFlight;
    const existing = await input.store.getRolloutTrajectoryReceiptByProviderId(rolloutId);
    if (existing?.status === "succeeded" || existing?.status === "failed") {
      return responseFromReceipt(existing, true);
    }
    const operation = execute(parsed.data, credential).finally(() => {
      inFlight.delete(rolloutId);
    });
    inFlight.set(rolloutId, operation);
    return operation;
  }

  async function execute(
    init: InitRequest,
    credential: FireworksProviderCredential,
  ): Promise<FireworksRftEnvironmentResponse> {
    let modelUrl: URL;
    try {
      modelUrl = validateModelBaseUrl(init.model_base_url, allowedModelOrigins);
    } catch (error) {
      return { status: 400, body: { error: message(error) } };
    }
    if (active >= maxConcurrency) {
      return {
        status: 429,
        body: {
          error: "rollout_concurrency_exhausted",
          retryable: true,
          maximumConcurrency: maxConcurrency,
        },
      };
    }
    active += 1;
    let releaseRollout: (() => void) | null = null;
    const rolloutLogger = loggerFactory(init.metadata.rollout_id, {
      gatewayBaseUrl: modelUrl.origin,
      apiKey: credential.value,
    });
    let receipt: RolloutTrajectoryReceipt | null = null;
    try {
      const { job, plan, recipe } = await resolveActiveRftJob(input.store, init);
      releaseRollout = await reserveRollout(
        job,
        recipe,
        init.metadata.rollout_id,
      );
      const payloadBytes = Buffer.byteLength(JSON.stringify(init), "utf8");
      if (payloadBytes > recipe.resourceLimits.maxPayloadBytes) {
        throw new Error(
          `RFT rollout payload exceeded its ${recipe.resourceLimits.maxPayloadBytes}-byte recipe limit.`,
        );
      }
      const taskset = await input.store.getTaskset(plan.tasksetId);
      if (!taskset || taskset.contentHash !== plan.tasksetHash) {
        throw new Error("The active RFT job no longer matches its immutable Taskset.");
      }
      const prompt = policyPrompt(init.messages);
      const crossSystem =
        recipe.reward.environmentId === "cross-system-operations";
      const context = crossSystem
        ? resolveCrossSystemTrainTask(taskset, {
            rowId: init.metadata.row_id,
            prompt,
          })
        : null;
      const exactTask = crossSystem
        ? null
        : await resolveExactAnswerTask({
            taskset,
            taskId: init.metadata.row_id,
            prompt,
            resolveTask: input.resolveTask,
          });
      assertPolicyRequest(init, recipe, job);
      const taskId = context?.authoredTask.id ?? exactTask!.id;
      const environmentWorld = context
        ? {
            worldId: context.world.id,
            worldHash: contentHash(context.world),
          }
        : {
            worldId: `exact_${contentHash([
              taskset.contentHash,
              taskId,
            ]).slice(0, 24)}`,
            worldHash: contentHash({
              tasksetHash: taskset.contentHash,
              taskId,
              graderHash: recipe.reward.graderHash,
            }),
          };
      const now = timestamp();
      const receiptId = `rollout_receipt_${contentHash([
        job.id,
        init.metadata.rollout_id,
      ]).slice(0, 24)}`;
      receipt = RolloutTrajectoryReceiptSchema.parse({
        schemaVersion: "openpond.rolloutTrajectoryReceipt.v1",
        id: receiptId,
        jobId: job.id,
        planId: plan.id,
        tasksetId: taskset.id,
        tasksetHash: taskset.contentHash,
        taskId,
        split: "train",
        correlationId: `fireworks:${init.metadata.experiment_id}:${init.metadata.rollout_id}`,
        provider: "fireworks",
        providerTrace: providerTrace(init),
        environment: {
          id: recipe.reward.environmentId,
          version: recipe.reward.environmentVersion,
          ...environmentWorld,
          toolContractHash: recipe.reward.toolContractHash,
        },
        policy: {
          modelId: canonicalFireworksPolicyModel(init.completion_params.model),
          checkpointId: optionalString(init.completion_params.checkpoint_id),
          completionParametersHash: contentHash(
            effectiveCompletionParameters(init.completion_params),
          ),
        },
        status: "received",
        failureClass: null,
        reward: { eligible: false, raw: null, normalized: null, components: {} },
        trajectory: null,
        verifier: null,
        providerStatus: { code: Status.rolloutRunning().code },
        receivedAt: now,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      });
      await input.store.saveRolloutTrajectoryReceipt(receipt);
      receipt = await input.store.saveRolloutTrajectoryReceipt({
        ...receipt,
        status: "running",
        startedAt: timestamp(),
        updatedAt: timestamp(),
      });
      rolloutLogger.info("OpenPond RFT rollout started", {
        status: Status.rolloutRunning(),
        extras: {
          correlation_id: receipt.correlationId,
          environment_version: receipt.environment.version,
        },
      });
      let outcome: {
        trajectory: NonNullable<RolloutTrajectoryReceipt["trajectory"]>;
        verifier: NonNullable<RolloutTrajectoryReceipt["verifier"]>;
        reward: RolloutTrajectoryReceipt["reward"];
        failureClass: RolloutTrajectoryReceipt["failureClass"];
      };
      if (context) {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new Error("RFT rollout exceeded its bounded wall time.")),
          recipe.resourceLimits.wallTimeMs,
        );
        timer.unref?.();
        let trajectory;
        try {
          trajectory = await runCrossSystemRollout({
            world: context.world,
            task: context.generatedTask,
            model: {
              providerId: "fireworks",
              modelId: receipt.policy.modelId,
            },
            reasoningEffort: null,
            stream: tracedFireworksStream({
              request,
              modelUrl,
              apiKey: credential.value,
              completionParameters: init.completion_params,
              recipe,
            }),
            signal: controller.signal,
            maxTurns: recipe.rollout.maxTurns,
            trajectoryId: `cso_rft_${contentHash([
              job.id,
              init.metadata.rollout_id,
            ]).slice(0, 24)}`,
            metadata: {
              execution: "fireworks_remote_environment",
              correlationId: receipt.correlationId,
              providerTrace: providerTrace(init),
              policyCheckpointId: receipt.policy.checkpointId,
            },
            maxFormatRepairs: 2,
          });
        } finally {
          clearTimeout(timer);
        }
        const verifier = verifyCrossSystemTrajectory({
          task: context.generatedTask,
          trajectory,
        });
        outcome = {
          trajectory,
          verifier,
          reward: rftTrainingReward({
            task: context.generatedTask,
            trajectory,
            verifier,
          }),
          failureClass: failureClass(verifier.outcome),
        };
      } else {
        outcome = await runExactAnswerRollout({
          init,
          recipe,
          job,
          tasksetId: taskset.id,
          task: exactTask!,
          correlationId: receipt.correlationId,
          policyModelId: receipt.policy.modelId,
          streamPolicy: ({ messages, signal }) =>
            tracedFireworksStream({
              request,
              modelUrl,
              apiKey: credential.value,
              completionParameters: init.completion_params,
              recipe,
            })({
              messages,
              tools: [],
              signal,
            }),
          resolveGrade: input.gradeAttempt,
          timestamp,
          providerTrace: providerTrace(init),
        });
      }
      const completed = timestamp();
      receipt = await input.store.saveRolloutTrajectoryReceipt({
        ...receipt,
        status: "succeeded",
        failureClass: outcome.failureClass,
        reward: outcome.reward,
        trajectory: outcome.trajectory,
        verifier: outcome.verifier,
        providerStatus: { code: Status.rolloutFinished().code },
        completedAt: completed,
        updatedAt: completed,
      });
      rolloutLogger.info("OpenPond RFT rollout completed", {
        status: Status.rolloutFinished(),
        extras: {
          correlation_id: receipt.correlationId,
          reward: receipt.reward.raw,
          reward_eligible: receipt.reward.eligible,
          normalized_reward: receipt.reward.normalized,
          receipt_id: receipt.id,
          outcome: receipt.verifier?.outcome ?? null,
        },
      });
      return responseFromReceipt(receipt, false);
    } catch (error) {
      const failedAt = timestamp();
      const errorMessage = message(error);
      if (receipt) {
        receipt = await input.store.saveRolloutTrajectoryReceipt({
          ...receipt,
          status: "failed",
          failureClass: "infrastructure_failure",
          reward: { eligible: false, raw: null, normalized: null, components: {} },
          providerStatus: {
            code: Status.rolloutError(errorMessage).code,
            error: boundedError(errorMessage),
          },
          completedAt: failedAt,
          updatedAt: failedAt,
        });
      }
      rolloutLogger.error("OpenPond RFT rollout failed", {
        status: Status.rolloutError(boundedError(errorMessage)),
        extras: {
          correlation_id: receipt?.correlationId,
          reward: null,
          reward_eligible: false,
          receipt_id: receipt?.id,
        },
      });
      return {
        status: receipt ? 500 : statusForSetupError(errorMessage),
        body: {
          error: boundedError(errorMessage),
          rollout_id: init.metadata.rollout_id,
          reward: null,
          reward_eligible: false,
        },
      };
    } finally {
      releaseRollout?.();
      active -= 1;
    }
  }

  return {
    handle,
    activeCount: () => active,
    maxConcurrency,
  };
}

export async function validateFireworksRftCallbackCredential(input: {
  apiKey: string;
  expectedAccountIds: string[];
  request?: typeof fetch;
}): Promise<boolean> {
  if (!input.expectedAccountIds.length) return false;
  const response = await (input.request ?? fetch)("https://api.fireworks.ai/v1/accounts", {
    headers: { Authorization: `Bearer ${input.apiKey}` },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok || bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) return false;
  let payload: Record<string, unknown>;
  try {
    payload = record(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    return false;
  }
  const expected = new Set(input.expectedAccountIds.map((id) => `accounts/${id}`));
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  return accounts.some((account) =>
    expected.has(optionalString(record(account).name) ?? ""));
}

async function activeRftProviderAccountIds(store: SqliteStore): Promise<string[]> {
  const accountIds = new Set<string>();
  for (const job of await store.listTrainingJobs()) {
    if (
      job.destinationId === "fireworks" &&
      job.metadata.trainingMethod === "grpo" &&
      ACTIVE_JOB_STATUSES.has(job.status)
    ) {
      const accountId = optionalString(job.metadata.providerAccountId);
      if (accountId) accountIds.add(accountId);
    }
  }
  return [...accountIds];
}

async function resolveActiveRftJob(
  store: SqliteStore,
  init: InitRequest,
): Promise<{ job: TrainingJob; plan: TrainingPlan; recipe: RftRecipe }> {
  const jobs = (await store.listTrainingJobs()).filter((job) =>
    job.destinationId === "fireworks" &&
    job.metadata.trainingMethod === "grpo" &&
    ACTIVE_JOB_STATUSES.has(job.status));
  const candidates: Array<{ job: TrainingJob; plan: TrainingPlan; recipe: RftRecipe }> = [];
  for (const job of jobs) {
    const plan = await store.getTrainingPlan(job.planId);
    if (!plan || plan.recipe.method !== "grpo") continue;
    candidates.push({ job, plan, recipe: plan.recipe });
  }
  const deployment = fireworksPolicyDeployment(init.completion_params.model);
  if (deployment) {
    const deploymentMatch = candidates.find(({ job }) => {
      const accountId = optionalString(job.metadata.providerAccountId);
      const providerJobId = optionalString(job.metadata.providerJobId);
      return Boolean(
        accountId
        && providerJobId
        && deployment ===
          `accounts/${accountId}/deployments/rft-hotreload-${providerJobId}`,
      );
    });
    if (deploymentMatch) return deploymentMatch;
  }
  const policyModel = canonicalFireworksPolicyModel(
    init.completion_params.model,
  );
  const checkpointMatch = candidates.find(({ job }) => {
    const accountId = optionalString(job.metadata.providerAccountId);
    const providerJobId = optionalString(job.metadata.providerJobId);
    return Boolean(
      accountId
      && providerJobId
      && isExpectedRftCheckpointModel(
        policyModel,
        accountId,
        providerJobId,
      ),
    );
  });
  if (checkpointMatch) return checkpointMatch;
  for (const candidate of candidates) {
    const { job } = candidate;
    const refs = new Set([
      job.id,
      optionalString(job.metadata.providerJobId),
      optionalString(job.metadata.providerJobName),
      optionalString(job.metadata.providerExperimentId),
      optionalString(job.metadata.providerRunId),
    ].filter((value): value is string => Boolean(value)));
    if (
      refs.has(init.metadata.run_id) ||
      refs.has(init.metadata.experiment_id)
    ) {
      return candidate;
    }
  }
  if (candidates.length === 1) return candidates[0]!;
  throw new Error("No active Fireworks GRPO job matches this rollout.");
}

function tracedFireworksStream(input: {
  request: typeof fetch;
  modelUrl: URL;
  apiKey: string;
  completionParameters: Record<string, unknown>;
  recipe: RftRecipe;
}) {
  return async function* (turn: {
    messages: HostedChatMessage[];
    tools: HostedChatTool[];
    signal: AbortSignal;
  }) {
    const endpoint = chatCompletionsUrl(input.modelUrl);
    const response = await input.request(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...effectiveCompletionParameters(input.completionParameters),
        model: fireworksInferenceModel(input.completionParameters.model),
        messages: turn.messages.map(openAiMessage),
        ...(turn.tools.length
          ? { tools: turn.tools, tool_choice: "auto" }
          : {}),
        stream: false,
        max_tokens: Math.min(
          input.recipe.rollout.maxOutputTokens,
          numeric(input.completionParameters.max_tokens) ??
            input.recipe.rollout.maxOutputTokens,
        ),
        temperature: input.recipe.rollout.temperature,
        top_p: input.recipe.rollout.topP,
      }),
      signal: turn.signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new Error("Fireworks traced inference response exceeded 2 MiB.");
    }
    const text = bytes.toString("utf8");
    if (!response.ok) {
      throw new Error(`Fireworks traced inference failed (${response.status}): ${boundedError(text)}`);
    }
    const payload = JSON.parse(text) as Record<string, unknown>;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const first = record(choices[0]);
    const message = record(first.message);
    const content = typeof message.content === "string" ? message.content : "";
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.flatMap(parseToolCall)
      : [];
    yield { text: content, toolCalls };
  };
}

function validateModelBaseUrl(value: string | null | undefined, testOrigins: Set<string>): URL {
  if (!value) throw new Error("Fireworks model_base_url is required.");
  const url = new URL(value);
  if (url.protocol !== "https:" && !testOrigins.has(url.origin)) {
    throw new Error("Fireworks model_base_url must use HTTPS.");
  }
  const fireworksHost = url.hostname === "fireworks.ai" || url.hostname.endsWith(".fireworks.ai");
  if (!fireworksHost && !testOrigins.has(url.origin)) {
    throw new Error("Fireworks model_base_url must use a Fireworks-controlled origin.");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("Fireworks model_base_url contains disallowed URL credentials or fragment.");
  }
  return url;
}

function chatCompletionsUrl(base: URL): URL {
  const url = new URL(base);
  if (!url.pathname.endsWith("/chat/completions")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  }
  return url;
}

function assertPolicyRequest(init: InitRequest, recipe: RftRecipe, job: TrainingJob): void {
  const model = canonicalFireworksPolicyModel(init.completion_params.model);
  const expected = optionalString(job.metadata.providerPolicyModel) ?? recipe.baseModel.id;
  const accountId = requiredString(job.metadata.providerAccountId, "providerAccountId");
  const providerJobId = requiredString(job.metadata.providerJobId, "providerJobId");
  if (
    model !== expected
    && !isExpectedRftCheckpointModel(model, accountId, providerJobId)
  ) {
    throw new Error(`Rollout policy ${model} does not match the job policy ${expected}.`);
  }
  const deployment = fireworksPolicyDeployment(init.completion_params.model);
  if (deployment) {
    const expectedDeployment =
      `accounts/${accountId}/deployments/rft-hotreload-${providerJobId}`;
    if (deployment !== expectedDeployment) {
      throw new Error(
        `Rollout deployment ${deployment} does not match the job deployment ${expectedDeployment}.`,
      );
    }
  }
  if (recipe.reward.environmentId === "cross-system-operations") {
    if (recipe.reward.toolContractHash !== CROSS_SYSTEM_TOOL_CONTRACT_HASH) {
      throw new Error("The RFT recipe tool contract is stale.");
    }
    if (recipe.reward.environmentVersion !== CROSS_SYSTEM_OPERATIONS_GENERATOR_VERSION) {
      throw new Error("The RFT recipe environment version is stale.");
    }
    return;
  }
  if (
    recipe.reward.environmentId !== DATASET_EXACT_ANSWER_ENVIRONMENT_ID
    || recipe.reward.environmentVersion
      !== DATASET_EXACT_ANSWER_ENVIRONMENT_VERSION
    || recipe.reward.toolContractHash !== DATASET_NO_TOOLS_CONTRACT_HASH
  ) {
    throw new Error("The Dataset exact-answer RFT environment contract is stale.");
  }
}

function isExpectedRftCheckpointModel(
  model: string,
  accountId: string,
  providerJobId: string,
): boolean {
  const checkpointPattern = new RegExp(
    `^accounts/${escapeRegExp(accountId)}/models/`
    + `${escapeRegExp(providerJobId)}-epoch-\\d+-chunk-\\d+$`,
  );
  return checkpointPattern.test(model);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalFireworksPolicyModel(value: unknown): string {
  const model = fireworksInferenceModel(value).split("#", 1)[0]!;
  return model.startsWith("fireworks_ai/")
    ? model.slice("fireworks_ai/".length)
    : model;
}

function fireworksInferenceModel(value: unknown): string {
  return requiredString(value, "completion_params.model");
}

function fireworksPolicyDeployment(value: unknown): string | null {
  const separator = fireworksInferenceModel(value).indexOf("#");
  return separator >= 0
    ? fireworksInferenceModel(value).slice(separator + 1)
    : null;
}

function responseFromReceipt(
  receipt: RolloutTrajectoryReceipt,
  replayed: boolean,
): FireworksRftEnvironmentResponse {
  return {
    status: receipt.status === "succeeded" ? 200 : 500,
    body: {
      status: receipt.status === "succeeded" ? "completed" : "failed",
      terminated: true,
      rollout_id: receipt.providerTrace.rolloutId,
      correlation_id: receipt.correlationId,
      reward: receipt.reward.normalized,
      reward_eligible: receipt.reward.eligible,
      replayed,
      info: {
        receipt_id: receipt.id,
        outcome: receipt.verifier?.outcome ?? null,
        normalized_reward: receipt.reward.normalized,
      },
    },
  };
}

function policyPrompt(messages: InitRequest["messages"]): string | null {
  const userMessages = (messages ?? []).filter((message) => message.role === "user");
  const content = userMessages.at(-1)?.content;
  return typeof content === "string" ? content : null;
}

function providerTrace(init: InitRequest) {
  return {
    invocationId: init.metadata.invocation_id,
    experimentId: init.metadata.experiment_id,
    rolloutId: init.metadata.rollout_id,
    runId: init.metadata.run_id,
    rowId: init.metadata.row_id,
  };
}

function failureClass(
  outcome: NonNullable<RolloutTrajectoryReceipt["verifier"]>["outcome"],
): RolloutTrajectoryReceipt["failureClass"] {
  if (outcome === "correct") return null;
  if (outcome === "incorrect") return "policy_failure";
  if (outcome === "parse_failure") return "parse_failure";
  if (outcome === "tool_schema_violation") return "tool_schema_violation";
  if (outcome === "budget_exhausted") return "budget_exhausted";
  if (outcome === "cancelled") return "cancelled";
  return "infrastructure_failure";
}

function safeCompletionParameters(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set([
    "model",
    "checkpoint_id",
    "temperature",
    "top_p",
    "max_tokens",
    "frequency_penalty",
    "presence_penalty",
    "reasoning_effort",
    "stop",
    "seed",
  ]);
  return Object.fromEntries(
    Object.entries(value).filter(([key, item]) => allowed.has(key) && item !== undefined),
  );
}

function effectiveCompletionParameters(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...safeCompletionParameters(value),
    reasoning_effort: "none",
  };
}

function openAiMessage(message: HostedChatMessage): Record<string, unknown> {
  return {
    role: message.role,
    ...(message.content !== undefined ? { content: message.content } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  };
}

function parseToolCall(value: unknown): HostedChatToolCall[] {
  const item = record(value);
  const fn = record(item.function);
  const name = optionalString(fn.name);
  if (!name) return [];
  return [{
    id: optionalString(item.id) ?? `call_${contentHash(item).slice(0, 16)}`,
    type: "function",
    function: {
      name,
      arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
    },
  }];
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedError(value: string): string {
  return value.replace(/(?:fw|sk)[_-][A-Za-z0-9_-]{8,}/g, "[REDACTED]").slice(0, 2_000);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusForSetupError(value: string): number {
  if (value.includes("active Fireworks GRPO job")) return 404;
  if (value.includes("payload exceeded")) return 413;
  if (value.includes("rollout budget exhausted")) return 429;
  if (value.includes("does not match") || value.includes("does not resolve")) return 409;
  return 400;
}
