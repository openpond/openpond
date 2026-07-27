import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
  CROSS_SYSTEM_TOOL_CONTRACT_HASH,
  HarnessExecutionBundleManifestSchema,
  PrimeRolloutAssignmentSchema,
  TaskAttemptArtifactSchema,
  TaskAttemptResultSchema,
  type ChatModelRef,
  type CodexReasoningEffort,
  type CrossSystemTrajectory,
  type CrossSystemVerifierResult,
  type HarnessBundleProjection,
  type HarnessExecutionBundleManifest,
  type OpenPondProfileState,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";
import { contentHash, sha256, type BaselineAttemptRunner } from "@openpond/taskset-sdk";
import type { HostedChatMessage } from "@openpond/cloud";
import type { SqliteStore } from "../store/store.js";
import { NativeToolCallAccumulator } from "../openpond/native-tool-calls.js";
import {
  resolveCrossSystemTask,
  runCrossSystemRollout,
  verifyCrossSystemTrajectory,
  type CrossSystemFrontierModelDelta,
  type CrossSystemFrontierModelStream,
} from "./cross-system-operations/index.js";
import {
  runMarketingPortfolioRollout,
  type MarketingPortfolioPolicy,
} from "./marketing-portfolio-rollout.js";
import { createProfileAgentHarnessRuntime } from "./profile-agent-harness-runtime.js";
import { verifyMarketingAgentRuntime } from "./task-creator-agent-benchmark.js";

type ModelTextRunner = (input: {
  model: ChatModelRef;
  reasoningEffort?: CodexReasoningEffort | "none" | null;
  messages: Array<{ role: "system" | "user"; content: string }>;
  signal: AbortSignal;
  requestId: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
}) => Promise<string>;

type TrainingBaselineAttemptInput = {
  tasksetId: string;
  task: TaskDataRecord;
  model: ChatModelRef;
  seed: number;
  attempt: number;
  sampling?: {
    maxOutputTokens: number;
    temperature: number;
    topP: number;
  };
  signal?: AbortSignal;
};

export function createTrainingBaselineAttemptRunner(input: {
  store: SqliteStore;
  storeDir: string;
  modelText: ModelTextRunner;
  crossSystemStream: CrossSystemFrontierModelStream;
  resolveProfile?: () => Promise<OpenPondProfileState>;
  createMarketingRuntime?: (
    taskset: Taskset,
  ) => Promise<ReturnType<typeof createProfileAgentHarnessRuntime>>;
  timestamp?: () => string;
}): BaselineAttemptRunner {
  const timestamp = input.timestamp ?? (() => new Date().toISOString());

  return (attemptInput) => runTrainingTasksetAttempt({
    ...input,
    timestamp,
    attemptInput,
  });
}

export async function runTrainingTasksetAttempt(input: {
  store: SqliteStore;
  storeDir: string;
  modelText: ModelTextRunner;
  crossSystemStream: CrossSystemFrontierModelStream;
  resolveProfile?: () => Promise<OpenPondProfileState>;
  createMarketingRuntime?: (
    taskset: Taskset,
  ) => Promise<ReturnType<typeof createProfileAgentHarnessRuntime>>;
  timestamp?: () => string;
  resultId?: string;
  attemptInput: TrainingBaselineAttemptInput;
}) {
  const timestamp = input.timestamp ?? (() => new Date().toISOString());
  const taskset = await input.store.getTaskset(input.attemptInput.tasksetId);
  if (!taskset) {
    throw new Error(`Taskset ${input.attemptInput.tasksetId} was not found.`);
  }
  return isMarketingPortfolioTaskset(taskset)
    ? runMarketingPortfolioAttempt({
        ...input,
        timestamp,
        taskset,
      })
    : isCrossSystemTaskset(taskset)
    ? runCrossSystemAttempt({
        ...input,
        timestamp,
        taskset,
      })
    : runTextAttempt({
        ...input,
        timestamp,
      });
}

export function isCrossSystemTaskset(taskset: Taskset): boolean {
  const tasksetFlagship = taskset.metadata.flagship === "cross-system-operations";
  const environmentFlagship =
    taskset.environment.metadata.flagship === "cross-system-operations";
  return (
    (tasksetFlagship || environmentFlagship)
    && taskset.environment.stateful
    && taskset.environment.metadata.toolContractHash === CROSS_SYSTEM_TOOL_CONTRACT_HASH
  );
}

export function isMarketingPortfolioTaskset(taskset: Taskset): boolean {
  const benchmark = taskset.environment.metadata.benchmark;
  return Boolean(
    benchmark
    && typeof benchmark === "object"
    && !Array.isArray(benchmark)
    && (benchmark as Record<string, unknown>).id === "marketing-portfolio-v1"
    && taskset.environment.stateful
    && taskset.environment.actionBindings?.length === 2,
  );
}

async function runMarketingPortfolioAttempt(input: {
  store: SqliteStore;
  storeDir: string;
  crossSystemStream: CrossSystemFrontierModelStream;
  resolveProfile?: () => Promise<OpenPondProfileState>;
  createMarketingRuntime?: (
    taskset: Taskset,
  ) => Promise<ReturnType<typeof createProfileAgentHarnessRuntime>>;
  timestamp: () => string;
  resultId?: string;
  taskset: Taskset;
  attemptInput: TrainingBaselineAttemptInput;
}) {
  const { attemptInput, taskset } = input;
  if (!taskset.profileRelease) {
    throw new Error("Marketing benchmark Taskset has no pinned Profile release.");
  }
  const actionBindings = taskset.environment.actionBindings ?? [];
  const agentRelease = actionBindings[0]?.agentRelease;
  if (!agentRelease) {
    throw new Error("Marketing benchmark Taskset has no pinned Agent release.");
  }
  const startedAt = input.timestamp();
  const requestId = baselineRequestId(attemptInput, startedAt);
  const runtime = input.createMarketingRuntime
    ? await input.createMarketingRuntime(taskset)
    : await createVerifiedMarketingRuntime({
        taskset,
        resolveProfile:
          input.resolveProfile
          ?? (() => {
            throw new Error(
              "Marketing benchmark Profile resolution is unavailable.",
            );
          }),
        storeDir: input.storeDir,
        requestId,
      });
  const harnessRelease = {
    id: `harness_${contentHash([
      taskset.id,
      taskset.contentHash,
      actionBindings,
    ]).slice(0, 24)}`,
    contentHash: contentHash({
      taskset: taskset.contentHash,
      profileRelease: taskset.profileRelease,
      actionBindings,
      graders: taskset.graders,
    }),
  };
  const assignmentContent = {
    schemaVersion: "openpond.primeRolloutAssignment.v1" as const,
    runId: `benchmark_${contentHash([requestId]).slice(0, 24)}`,
    resolvedBundleHash: contentHash({
      taskset: taskset.contentHash,
      harnessRelease,
    }),
    taskset: {
      id: taskset.id,
      revision: taskset.revision,
      contentHash: taskset.contentHash,
    },
    harnessRelease,
    profileRelease: taskset.profileRelease,
    agentRelease,
    taskId: attemptInput.task.id,
    split: attemptInput.task.split,
    policyVersion: "base" as const,
    model: {
      id: `${attemptInput.model.providerId}/${attemptInput.model.modelId}`,
      revision: contentHash(attemptInput.model),
    },
    inferencePort: 1,
    createdAt: startedAt,
  };
  const assignment = PrimeRolloutAssignmentSchema.parse({
    ...assignmentContent,
    assignmentHash: contentHash(assignmentContent),
  });
  const controller = new AbortController();
  const abortFromParent = () =>
    controller.abort(
      attemptInput.signal?.reason
      ?? new Error("The marketing benchmark was cancelled."),
    );
  attemptInput.signal?.addEventListener("abort", abortFromParent, {
    once: true,
  });
  const timeoutMs = Math.max(
    1,
    Math.min(taskset.environment.defaultTimeoutMs, 10 * 60_000),
  );
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`Marketing benchmark exceeded ${timeoutMs} ms.`),
      ),
    timeoutMs,
  );
  timer.unref?.();
  try {
    const streamedPolicy = marketingPolicyFromStream({
      model: attemptInput.model,
      seed: attemptInput.seed + attemptInput.attempt,
      stream: input.crossSystemStream,
      requestId,
      sampling: attemptInput.sampling,
    });
    const result = await runMarketingPortfolioRollout({
      assignment,
      taskset,
      task: attemptInput.task,
      studentManifest: marketingHarnessManifest({
        projection: "student",
        harnessRelease,
        taskset,
      }),
      environmentManifest: marketingHarnessManifest({
        projection: "environment",
        harnessRelease,
        taskset,
      }),
      policy: streamedPolicy.policy,
      executeAction: runtime.executeAction,
      scoreDecision: runtime.scoreDecision,
      timestamp: input.timestamp,
      maxTurns: 8,
      allowedSplits: ["train", "validation", "frozen_eval"],
      signal: controller.signal,
    });
    const completedAt = result.completedAt;
    const attemptId =
      input.resultId
      ?? `attempt_${contentHash([requestId, result.resultHash]).slice(0, 24)}`;
    const validToolTrace =
      result.toolSequence[0] === "get_portfolio_snapshot"
      && result.toolSequence.includes("submit_budget_decision");
    const artifact = await persistBaselineArtifact({
      store: input.store,
      storeDir: input.storeDir,
      tasksetId: taskset.id,
      taskId: attemptInput.task.id,
      attemptId,
      requestId,
      kind: "runtime_trace",
      payload: {
        schemaVersion: "openpond.marketingPortfolioBaselineTrace.v1",
        model: attemptInput.model,
        seed: attemptInput.seed,
        attempt: attemptInput.attempt,
        assignment,
        result,
        validToolTrace,
      },
      timestamp: input.timestamp,
    });
    return TaskAttemptResultSchema.parse({
      schemaVersion: "openpond.taskAttempt.v1",
      id: attemptId,
      tasksetId: taskset.id,
      taskId: attemptInput.task.id,
      split: attemptInput.task.split,
      attempt: attemptInput.attempt,
      seed: attemptInput.seed,
      modelRef: attemptInput.model,
      startedAt,
      completedAt,
      output: {
        harnessGrade: result.grade,
        toolSequence: result.toolSequence,
        terminalDecision: result.grade?.decisionAccepted === true,
        traceHash: result.grade?.traceHash ?? null,
      },
      runtimeEventRefs: [],
      artifactRefs: [artifact.id],
      privilegedOutcomeRef: attemptInput.task.privilegedContextRef,
      infrastructureError: null,
      costUsd: null,
      latencyMs: elapsedMilliseconds(startedAt, completedAt),
      userInterventions: 0,
      metadata: {
        requestId,
        execution: "marketing_portfolio_tool_loop",
        validToolTrace,
        policyFailure: validToolTrace
          ? null
          : "missing_required_tool_trace",
        providerSamplingSupport: {
          seed:
            streamedPolicy.responseFacts.length > 0
            && streamedPolicy.responseFacts.every(
              (fact) => fact.samplingSupport.seed,
            ),
          temperature:
            streamedPolicy.responseFacts.length > 0
            && streamedPolicy.responseFacts.every(
              (fact) => fact.samplingSupport.temperature,
            ),
          topP:
            streamedPolicy.responseFacts.length > 0
            && streamedPolicy.responseFacts.every(
              (fact) => fact.samplingSupport.topP,
            ),
        },
        providerResponseIdentity:
          streamedPolicy.responseFacts.at(-1)
            ?.providerResponseIdentity ?? null,
        providerResponseFacts: streamedPolicy.responseFacts,
        executionSpans: result.executionSpans,
        promptTokens: sumResponseFactTokens(
          streamedPolicy.responseFacts,
          "promptTokens",
        ),
        generatedTokens: sumResponseFactTokens(
          streamedPolicy.responseFacts,
          "generatedTokens",
        ),
      },
    });
  } finally {
    clearTimeout(timer);
    attemptInput.signal?.removeEventListener("abort", abortFromParent);
  }
}

async function createVerifiedMarketingRuntime(input: {
  taskset: Taskset;
  resolveProfile: () => Promise<OpenPondProfileState>;
  storeDir: string;
  requestId: string;
}): Promise<ReturnType<typeof createProfileAgentHarnessRuntime>> {
  const profile = await input.resolveProfile();
  const verifiedAgent = await verifyMarketingAgentRuntime({
    taskset: input.taskset,
    profile,
  });
  return createProfileAgentHarnessRuntime({
    agentRoot: verifiedAgent.agentRoot,
    scorerModulePath: verifiedAgent.scorerModulePath,
    artifactRoot: path.join(
      input.storeDir,
      "training",
      "baseline-runtime",
      input.taskset.id,
      input.requestId,
    ),
  });
}

function marketingHarnessManifest(input: {
  projection: HarnessBundleProjection;
  harnessRelease: { id: string; contentHash: string };
  taskset: Taskset;
}): HarnessExecutionBundleManifest {
  const content = {
    schemaVersion: "openpond.harnessExecutionBundle.v1" as const,
    harnessRelease: input.harnessRelease,
    resolvedGraphHash: contentHash({
      taskset: input.taskset.contentHash,
      harnessRelease: input.harnessRelease,
    }),
    target: {
      adapterId: "local-marketing-benchmark",
      projection: input.projection,
      runtimeVersion: "openpond.marketingPortfolioBaseline.v1",
    },
    files: [],
    actionBindings: input.taskset.environment.actionBindings ?? [],
    secretDeclarations: [],
  };
  return HarnessExecutionBundleManifestSchema.parse({
    ...content,
    contentHash: contentHash(content),
  });
}

function marketingPolicyFromStream(input: {
  model: ChatModelRef;
  seed: number;
  stream: CrossSystemFrontierModelStream;
  requestId: string;
  sampling?: {
    maxOutputTokens: number;
    temperature: number;
    topP: number;
  };
}): {
  policy: MarketingPortfolioPolicy;
  responseFacts: NonNullable<
    CrossSystemFrontierModelDelta["responseFacts"]
  >[];
} {
  let turn = 0;
  const responseFacts: NonNullable<
    CrossSystemFrontierModelDelta["responseFacts"]
  >[] = [];
  const policy: MarketingPortfolioPolicy = {
    async complete({ messages, tools, signal }) {
      const accumulator = new NativeToolCallAccumulator();
      let content = "";
      const hostedMessages: HostedChatMessage[] = messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.toolCallId
          ? { tool_call_id: message.toolCallId }
          : {}),
        ...(message.toolCalls
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments: call.arguments,
                },
              })),
            }
          : {}),
      }));
      for await (const delta of input.stream({
        model: input.model,
        reasoningEffort: null,
        messages: hostedMessages,
        tools,
        toolChoice: "auto",
        requestId: `${input.requestId}:marketing:${turn}`,
        signal,
        maxOutputTokens:
          input.sampling?.maxOutputTokens ?? 1_024,
        temperature:
          input.sampling?.temperature ?? 0.2,
        topP: input.sampling?.topP ?? 0.95,
        seed: input.seed + turn,
      })) {
        if (delta.text) content += delta.text;
        if (delta.toolCalls?.length) accumulator.append(delta.toolCalls);
        if (delta.responseFacts) {
          responseFacts.push(delta.responseFacts);
        }
      }
      turn += 1;
      return {
        content: content || null,
        toolCalls: accumulator.completed().map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.argumentsJson,
        })),
      };
    },
  };
  return { policy, responseFacts };
}

function sumResponseFactTokens(
  facts: NonNullable<
    CrossSystemFrontierModelDelta["responseFacts"]
  >[],
  key: "promptTokens" | "generatedTokens",
): number | null {
  if (facts.some((fact) => fact[key] === null)) return null;
  return facts.reduce(
    (sum, fact) => sum + (fact[key] ?? 0),
    0,
  );
}

async function runCrossSystemAttempt(input: {
  store: SqliteStore;
  storeDir: string;
  crossSystemStream: CrossSystemFrontierModelStream;
  timestamp: () => string;
  resultId?: string;
  taskset: Taskset;
  attemptInput: TrainingBaselineAttemptInput;
}) {
  const { attemptInput, taskset } = input;
  const startedAt = input.timestamp();
  const requestId = baselineRequestId(attemptInput, startedAt);
  const context = resolveCrossSystemTask(taskset, {
    taskId: attemptInput.task.id,
    prompt: typeof attemptInput.task.input.prompt === "string"
      ? attemptInput.task.input.prompt
      : null,
  });
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(
    attemptInput.signal?.reason ?? new Error("The baseline was cancelled."),
  );
  attemptInput.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeoutMs = Math.max(
    1,
    Math.min(taskset.environment.defaultTimeoutMs, 10 * 60_000),
  );
  const timer = setTimeout(
    () => controller.abort(new Error(`Cross-System baseline exceeded ${timeoutMs} ms.`)),
    timeoutMs,
  );
  timer.unref?.();
  try {
    const priorInfrastructureTrajectories: CrossSystemTrajectory[] = [];
    let trajectory: CrossSystemTrajectory | null = null;
    let verifier: CrossSystemVerifierResult | null = null;
    for (let retry = 0; retry <= 1; retry += 1) {
      trajectory = await runCrossSystemRollout({
        world: context.world,
        task: context.generatedTask,
        model: attemptInput.model,
        reasoningEffort: null,
        stream: input.crossSystemStream,
        signal: controller.signal,
        trajectoryId: `cso_taskset_baseline_${contentHash([
          requestId,
          retry,
        ]).slice(0, 24)}`,
        metadata: {
          baseline: "taskset",
          execution: "taskset_baseline_tool_loop",
          tasksetId: taskset.id,
          tasksetHash: taskset.contentHash,
          samplingSeed: attemptInput.seed,
          attempt: attemptInput.attempt,
          infrastructureRetryAttempt: retry,
          priorInfrastructureErrors: priorInfrastructureTrajectories.map(
            (prior) => prior.infrastructureError ?? "Unknown infrastructure failure.",
          ),
        },
      });
      verifier = verifyCrossSystemTrajectory({
        task: context.generatedTask,
        trajectory,
      });
      if (verifier.outcome !== "infrastructure_failure" || retry === 1) break;
      priorInfrastructureTrajectories.push(trajectory);
    }
    if (!trajectory || !verifier) {
      throw new Error(`Cross-System task ${attemptInput.task.id} produced no trajectory.`);
    }
    const final = [...trajectory.steps]
      .reverse()
      .find((step) => step.kind === "final");
    const completedAt = trajectory.completedAt;
    const attemptId = input.resultId ?? `attempt_${contentHash([
      requestId,
      trajectory.id,
      verifier.outcome,
    ]).slice(0, 24)}`;
    const artifact = await persistBaselineArtifact({
      store: input.store,
      storeDir: input.storeDir,
      tasksetId: taskset.id,
      taskId: attemptInput.task.id,
      attemptId,
      requestId,
      kind: "runtime_trace",
      payload: {
        schemaVersion: CROSS_SYSTEM_OPERATIONS_SCHEMA_VERSION,
        model: attemptInput.model,
        seed: attemptInput.seed,
        attempt: attemptInput.attempt,
        trajectory,
        verifier,
        priorInfrastructureTrajectories,
      },
      timestamp: input.timestamp,
    });
    return TaskAttemptResultSchema.parse({
      schemaVersion: "openpond.taskAttempt.v1",
      id: attemptId,
      tasksetId: taskset.id,
      taskId: attemptInput.task.id,
      split: attemptInput.task.split,
      attempt: attemptInput.attempt,
      seed: attemptInput.seed,
      modelRef: attemptInput.model,
      startedAt: trajectory.startedAt,
      completedAt,
      output: {
        text: final?.content ?? "",
        trajectoryId: trajectory.id,
      },
      runtimeEventRefs: [],
      artifactRefs: [artifact.id],
      privilegedOutcomeRef: attemptInput.task.privilegedContextRef,
      infrastructureError: trajectory.infrastructureError,
      costUsd: null,
      latencyMs: elapsedMilliseconds(trajectory.startedAt, completedAt),
      userInterventions: 0,
      metadata: {
        requestId,
        execution: "taskset_baseline_tool_loop",
        trajectoryId: trajectory.id,
        worldId: trajectory.worldId,
        toolContractHash: trajectory.toolContractHash,
        verifierOutcome: verifier.outcome,
        verifierReward: verifier.reward,
        verifierRewardEligible: verifier.rewardEligible,
        infrastructureRetryAttempt:
          trajectory.metadata.infrastructureRetryAttempt,
        priorInfrastructureErrors:
          trajectory.metadata.priorInfrastructureErrors,
      },
    });
  } finally {
    clearTimeout(timer);
    attemptInput.signal?.removeEventListener("abort", abortFromParent);
  }
}

async function runTextAttempt(input: {
  store: SqliteStore;
  storeDir: string;
  modelText: ModelTextRunner;
  timestamp: () => string;
  resultId?: string;
  attemptInput: TrainingBaselineAttemptInput;
}) {
  const { attemptInput } = input;
  const startedAt = input.timestamp();
  const requestId = baselineRequestId(attemptInput, startedAt);
  try {
    const text = await input.modelText({
      model: attemptInput.model,
      reasoningEffort:
        attemptInput.model.providerId === "fireworks" ? "none" : null,
      signal: attemptInput.signal ?? new AbortController().signal,
      requestId,
      messages: policyMessages(attemptInput.task),
      maxOutputTokens: attemptInput.sampling?.maxOutputTokens ?? 2_048,
      temperature: attemptInput.sampling?.temperature ?? 0.8,
      topP: attemptInput.sampling?.topP ?? 0.95,
      seed: attemptInput.seed + attemptInput.attempt,
    });
    const completedAt = input.timestamp();
    const attemptId =
      input.resultId ?? `attempt_${contentHash([requestId, text]).slice(0, 24)}`;
    const artifact = await persistBaselineArtifact({
      store: input.store,
      storeDir: input.storeDir,
      tasksetId: attemptInput.tasksetId,
      taskId: attemptInput.task.id,
      attemptId,
      requestId,
      kind: "raw_model_response",
      payload: {
        model: attemptInput.model,
        seed: attemptInput.seed,
        attempt: attemptInput.attempt,
        output: { text },
        startedAt,
        completedAt,
      },
      timestamp: input.timestamp,
    });
    return TaskAttemptResultSchema.parse({
      schemaVersion: "openpond.taskAttempt.v1",
      id: attemptId,
      tasksetId: attemptInput.tasksetId,
      taskId: attemptInput.task.id,
      split: attemptInput.task.split,
      attempt: attemptInput.attempt,
      seed: attemptInput.seed,
      modelRef: attemptInput.model,
      startedAt,
      completedAt,
      output: { text },
      runtimeEventRefs: [],
      artifactRefs: [artifact.id],
      privilegedOutcomeRef: attemptInput.task.privilegedContextRef,
      infrastructureError: null,
      costUsd: null,
      latencyMs: elapsedMilliseconds(startedAt, completedAt),
      userInterventions: 0,
      metadata: { requestId, execution: "text_completion" },
    });
  } catch (error) {
    if (attemptInput.signal?.aborted) {
      throw attemptInput.signal.reason instanceof Error
        ? attemptInput.signal.reason
        : new Error("The baseline was cancelled.");
    }
    const completedAt = input.timestamp();
    const message = error instanceof Error ? error.message : String(error);
    const attemptId =
      input.resultId ?? `attempt_${contentHash([requestId, "failure"]).slice(0, 24)}`;
    const artifact = await persistBaselineArtifact({
      store: input.store,
      storeDir: input.storeDir,
      tasksetId: attemptInput.tasksetId,
      taskId: attemptInput.task.id,
      attemptId,
      requestId,
      kind: "raw_model_response",
      payload: {
        model: attemptInput.model,
        seed: attemptInput.seed,
        attempt: attemptInput.attempt,
        error: message,
        startedAt,
        completedAt,
      },
      timestamp: input.timestamp,
    });
    return TaskAttemptResultSchema.parse({
      schemaVersion: "openpond.taskAttempt.v1",
      id: attemptId,
      tasksetId: attemptInput.tasksetId,
      taskId: attemptInput.task.id,
      split: attemptInput.task.split,
      attempt: attemptInput.attempt,
      seed: attemptInput.seed,
      modelRef: attemptInput.model,
      startedAt,
      completedAt,
      output: {},
      runtimeEventRefs: [],
      artifactRefs: [artifact.id],
      privilegedOutcomeRef: null,
      infrastructureError: message,
      costUsd: null,
      latencyMs: elapsedMilliseconds(startedAt, completedAt),
      userInterventions: 0,
      metadata: { requestId, execution: "text_completion" },
    });
  }
}

function policyMessages(
  task: TaskDataRecord,
): Array<{ role: "system" | "user"; content: string }> {
  const messages = Array.isArray(task.input.messages)
    ? task.input.messages.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const message = value as Record<string, unknown>;
        if (
          (message.role !== "system" && message.role !== "user")
          || typeof message.content !== "string"
          || !message.content.trim()
        ) {
          return [];
        }
        return [{
          role: message.role as "system" | "user",
          content: message.content,
        }];
      })
    : [];
  if (messages.length) return messages;
  if (typeof task.input.prompt === "string" && task.input.prompt.trim()) {
    return [{ role: "user", content: task.input.prompt }];
  }
  throw new Error(`Baseline task ${task.id} has no policy-visible prompt.`);
}

async function persistBaselineArtifact(input: {
  store: SqliteStore;
  storeDir: string;
  tasksetId: string;
  taskId: string;
  attemptId: string;
  requestId: string;
  kind: "raw_model_response" | "runtime_trace";
  payload: Record<string, unknown>;
  timestamp: () => string;
}) {
  const directory = path.join(
    input.storeDir,
    "training",
    "baseline-artifacts",
    input.tasksetId,
  );
  const file = path.join(directory, `${input.attemptId}.json`);
  const bytes = Buffer.from(`${JSON.stringify({
    schemaVersion: "openpond.rawBaselineArtifact.v1",
    requestId: input.requestId,
    ...input.payload,
  }, null, 2)}\n`, "utf8");
  await mkdir(directory, { recursive: true });
  await writeFile(file, bytes, { mode: 0o600 });
  const artifact = TaskAttemptArtifactSchema.parse({
    schemaVersion: "openpond.taskAttemptArtifact.v1",
    id: `attempt_artifact_${contentHash([
      input.attemptId,
      sha256(bytes),
    ]).slice(0, 24)}`,
    tasksetId: input.tasksetId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    kind: input.kind,
    path: file,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    createdAt: input.timestamp(),
    metadata: {
      requestId: input.requestId,
      localOnly: true,
      containsPrivilegedOutcome: false,
    },
  });
  return input.store.saveTaskAttemptArtifact(artifact);
}

function baselineRequestId(
  input: {
    task: TaskDataRecord;
    model: ChatModelRef;
    seed: number;
    attempt: number;
  },
  startedAt: string,
): string {
  return `training-baseline:${contentHash([
    input.task.id,
    input.model,
    input.seed,
    input.attempt,
    startedAt,
  ]).slice(0, 40)}`;
}

function elapsedMilliseconds(startedAt: string, completedAt: string): number {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}
