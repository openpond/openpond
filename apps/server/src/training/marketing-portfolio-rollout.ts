import {
  MarketingPortfolioHarnessGradeSchema,
  ModelActionSchema,
  PrimeRolloutAssignmentSchema,
  PrimeRolloutResultSchema,
  type HarnessActionBinding,
  type HarnessExecutionBundleManifest,
  type MarketingPortfolioHarnessGrade,
  type OptimizerTrainingSample,
  type PrimeRolloutAssignment,
  type PrimeRolloutResult,
  type RolloutSamplingTrace,
  type TaskDataRecord,
  type Taskset,
} from "@openpond/contracts";
import {
  executeHarnessActionBinding,
  studentHarnessActionTools,
  type HarnessActionExecutionResult,
} from "@openpond/training-sdk";
import { contentHash } from "@openpond/taskset-sdk";

import {
  MARKETING_PORTFOLIO_POLICY_SYSTEM_PROMPT,
  projectPubliclyFeasibleAllocation,
} from "./marketing-portfolio-constraint-repair.js";

type PolicyMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCallId?: string;
  toolCalls?: PolicyToolCall[];
};

type PolicyToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type MarketingPortfolioPolicy = {
  complete(input: {
    messages: PolicyMessage[];
    tools: Array<{
      type: "function";
      function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        strict: true;
      };
    }>;
    requiredToolName:
      | "get_portfolio_snapshot"
      | "submit_budget_decision";
    signal: AbortSignal;
  }): Promise<{
    content: string | null;
    toolCalls: PolicyToolCall[];
    samplingTrace?: RolloutSamplingTrace;
  }>;
};

export type MarketingPortfolioActionRunner = (input: {
  binding: HarnessActionBinding;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<HarnessActionExecutionResult>;

type DecisionScore = {
  reward: number;
  components: {
    constraints: number;
    portfolioValue: number;
    riskControls: number;
    rationale: number;
  };
  validation: {
    accepted: boolean;
  };
};

export async function runMarketingPortfolioRollout(input: {
  assignment: PrimeRolloutAssignment;
  taskset: Taskset;
  task: TaskDataRecord;
  studentManifest: HarnessExecutionBundleManifest;
  environmentManifest: HarnessExecutionBundleManifest;
  policy: MarketingPortfolioPolicy;
  executeAction: MarketingPortfolioActionRunner;
  scoreDecision(input: Record<string, unknown>): Promise<DecisionScore>;
  timestamp?: () => string;
  maxTurns?: number;
  allowedSplits?: Array<"train" | "validation" | "frozen_eval">;
  signal?: AbortSignal;
}): Promise<PrimeRolloutResult> {
  const assignment = PrimeRolloutAssignmentSchema.parse(input.assignment);
  assertAssignment(
    input.taskset,
    input.task,
    assignment,
    input.allowedSplits ?? ["train"],
  );
  const timestamp = input.timestamp ?? (() => new Date().toISOString());
  const maxTurns = input.maxTurns ?? 8;
  const tools = studentHarnessActionTools(input.studentManifest).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: true as const,
    },
  }));
  if (
    tools.length !== 2
    || tools[0]?.function.name !== "get_portfolio_snapshot"
    || tools[1]?.function.name !== "submit_budget_decision"
  ) {
    throw new Error(
      "Marketing rollout requires the exact ordered snapshot and decision tools.",
    );
  }
  const messages: PolicyMessage[] = [
    {
      role: "system",
      content: MARKETING_PORTFOLIO_POLICY_SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: taskPrompt(input.task),
    },
  ];
  const toolSequence: PrimeRolloutResult["toolSequence"] = [];
  const actions: unknown[] = [];
  const observations: unknown[] = [];
  const samplingTraces: RolloutSamplingTrace[] = [];
  const executionSpans: PrimeRolloutResult["executionSpans"] = [];
  const toolTrace: PrimeRolloutResult["toolTrace"] = [];
  let loadedSnapshot = false;
  let portfolioSnapshot: Record<string, unknown> | null = null;
  let acceptedDecision: Record<string, unknown> | null = null;
  let pendingProjection: ReturnType<
    typeof projectPubliclyFeasibleAllocation
  > = null;

  const controller = new AbortController();
  const forwardAbort = () =>
    controller.abort(input.signal?.reason ?? new Error("Rollout cancelled."));
  input.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    for (let turn = 0; turn < maxTurns && !acceptedDecision; turn += 1) {
      const completion = await input.policy.complete({
        messages: structuredClone(messages),
        tools,
        requiredToolName: loadedSnapshot
          ? "submit_budget_decision"
          : "get_portfolio_snapshot",
        signal: controller.signal,
      });
      if (completion.samplingTrace) {
        if (completion.samplingTrace.servedModel !== assignment.model.id) {
          throw new Error(
            `Policy response model ${completion.samplingTrace.servedModel} does not match assigned model ${assignment.model.id}.`,
          );
        }
        samplingTraces.push(completion.samplingTrace);
      }
      messages.push({
        role: "assistant",
        content: completion.content,
        toolCalls: completion.toolCalls,
      });
      if (!completion.toolCalls.length) {
        messages.push({
          role: "user",
          content:
            loadedSnapshot
              ? "Submit the final decision through submit_budget_decision now."
              : "Use get_portfolio_snapshot before answering.",
        });
        continue;
      }
      for (const toolCall of completion.toolCalls) {
        if (
          toolCall.name !== "get_portfolio_snapshot"
          && toolCall.name !== "submit_budget_decision"
        ) {
          throw new Error(`Policy called unbound tool ${toolCall.name}.`);
        }
        if (toolCall.name === "submit_budget_decision" && !loadedSnapshot) {
          throw new Error("Policy submitted a decision before loading the snapshot.");
        }
        const policyArguments = parseToolArguments(toolCall);
        const projectionToApply =
          toolCall.name === "submit_budget_decision"
            ? pendingProjection
            : null;
        const publicProjectionApplied: boolean = projectionToApply !== null;
        const argumentsValue: Record<string, unknown> = projectionToApply
          ? {
              ...policyArguments,
              allocations: structuredClone(projectionToApply.allocations),
            }
          : policyArguments;
        const actionContent = {
          id: `action_${contentHash([
            assignment.assignmentHash,
            turn,
            toolCall.id,
          ]).slice(0, 24)}`,
          turn,
          kind: "tool_call" as const,
          name: toolCall.name,
          arguments: argumentsValue,
          content: completion.content,
        };
        const action = ModelActionSchema.parse({
          ...actionContent,
          contentHash: contentHash(actionContent),
        });
        const actionStartedAt = new Date().toISOString();
        const actionMonotonicStartedAt = performance.now();
        const observation = await executeHarnessActionBinding({
          manifest: input.environmentManifest,
          action,
          episode: {
            caseId: privateCaseId(input.task),
          },
          execute: async ({ binding, arguments: resolved, signal }) =>
            input.executeAction({
              binding,
              arguments: resolved,
              signal,
            }),
        });
        const studentOutput = sanitizeStudentObservation(observation.output);
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: JSON.stringify(studentOutput),
        });
        toolSequence.push(toolCall.name);
        actions.push(action);
        observations.push({
          ...observation,
          output: studentOutput,
          contentHash: contentHash({
            actionId: observation.actionId,
            turn: observation.turn,
            terminal: observation.terminal,
            output: studentOutput,
            artifactRefs: observation.artifactRefs,
          }),
        });
        toolTrace.push({
          turn,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          policyArguments,
          executedArguments: argumentsValue,
          publicProjectionApplied,
          observation: studentOutput,
          terminal: observation.terminal,
        });
        executionSpans.push({
          name: `agent_action:${toolCall.name}`,
          startedAt: actionStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: Math.max(
            0,
            performance.now() - actionMonotonicStartedAt,
          ),
          clock: "monotonic",
          outcome: "succeeded",
        });
        if (toolCall.name === "get_portfolio_snapshot") {
          loadedSnapshot = true;
          portfolioSnapshot = studentOutput;
        } else if (observation.terminal) {
          acceptedDecision = argumentsValue;
          pendingProjection = null;
          break;
        } else {
          pendingProjection = portfolioSnapshot
            ? projectPubliclyFeasibleAllocation({
                snapshot: portfolioSnapshot,
                decision: argumentsValue,
              })
            : null;
          messages.push({
            role: "user",
            content: publicDecisionRepairPrompt({
              observation: studentOutput,
              snapshot: portfolioSnapshot,
              decision: argumentsValue,
              projection: pendingProjection,
            }),
          });
        }
      }
    }
  } finally {
    input.signal?.removeEventListener("abort", forwardAbort);
  }
  const benchmark = benchmarkMetadata(input.taskset);
  const traceHash = contentHash({
    assignmentHash: assignment.assignmentHash,
    messages,
    actions,
    observations,
  });
  const gradingStartedAt = new Date().toISOString();
  const gradingMonotonicStartedAt = performance.now();
  const score = acceptedDecision
    ? await input.scoreDecision({
      ...acceptedDecision,
      scenarioId: privateCaseId(input.task),
    })
    : {
        reward: 0,
        components: {
          constraints: 0,
          portfolioValue: 0,
          riskControls: 0,
          rationale: 0,
        },
        validation: { accepted: false },
      };
  executionSpans.push({
    name: "grading",
    startedAt: gradingStartedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.max(0, performance.now() - gradingMonotonicStartedAt),
    clock: "monotonic",
    outcome: "succeeded",
  });
  executionSpans.unshift(...samplingTraces.map((trace) => ({
    name: "generation",
    startedAt: trace.startedAt,
    completedAt: trace.completedAt,
    durationMs: trace.durationMs,
    clock: "monotonic" as const,
    outcome: "succeeded" as const,
  })));
  const grade: MarketingPortfolioHarnessGrade =
    MarketingPortfolioHarnessGradeSchema.parse({
      schemaVersion: "openpond.marketingPortfolioGrade.v1",
      benchmarkId: "marketing-portfolio-v1",
      agentReleaseHash: assignment.agentRelease.contentHash,
      scorerImplementationHash: benchmark.scorerImplementationHash,
      terminalActionId: "submit-budget-decision",
      decisionAccepted: score.validation.accepted,
      caseRef: contentHash(privateCaseId(input.task)),
      traceHash,
      reward: score.reward,
      components: score.components,
    });
  const optimizerSample = optimizerSampleFromTrace({
    assignment,
    trace: samplingTraces.at(-1) ?? null,
  });
  const resultContent = {
    schemaVersion: "openpond.primeRolloutResult.v1" as const,
    runId: assignment.runId,
    assignmentHash: assignment.assignmentHash,
    status: "succeeded" as const,
    taskId: input.task.id,
    policyVersion: assignment.policyVersion,
    model: assignment.model,
    samplingTraces,
    optimizerSample,
    executionSpans,
    toolSequence,
    toolTrace,
    transcriptHash: contentHash(messages),
    grade,
    terminal: acceptedDecision !== null,
    failure: null,
    completedAt: timestamp(),
  };
  return PrimeRolloutResultSchema.parse({
    ...resultContent,
    resultHash: contentHash(resultContent),
  });
}

function publicDecisionRepairPrompt(input: {
  observation: Record<string, unknown>;
  snapshot: Record<string, unknown> | null;
  decision: Record<string, unknown>;
  projection?: ReturnType<typeof projectPubliclyFeasibleAllocation>;
}): string {
  const projection = input.projection ?? (input.snapshot
    ? projectPubliclyFeasibleAllocation({
        snapshot: input.snapshot,
        decision: input.decision,
      })
    : null);
  const errors = Array.isArray(input.observation.errors)
    ? input.observation.errors.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const projectionText = projection
    ? [
        "A deterministic projection of your submitted amounts onto the public constraints is:",
        JSON.stringify({ allocations: projection.allocations }),
        `Verified public total: ${projection.allocationTotalUsd} USD; required total: `
          + `${projection.incrementalBudgetUsd} USD; increment: `
          + `${projection.allocationIncrementUsd} USD.`,
        "This is only a feasibility repair derived from the visible budget, limits, increment, "
          + "and your submitted amounts. It does not use or reveal the hidden reward or optimal allocation.",
        "Call submit_budget_decision now with those exact four channelId/amountUsd pairs. "
          + "Keep or improve your rationale and applicable riskControls, but do not alter the projected "
          + "amounts and do not call get_portfolio_snapshot again. On this resubmission the Harness "
          + "will normalize allocations to this disclosed projection before public validation; your "
          + "raw and executed arguments are both retained in the trajectory receipt.",
      ]
    : [
        "Recalculate the four different channel amounts so their combined total equals the one "
          + "incremental budget, every amount stays within its channel limits and uses the declared "
          + "increment. Do not resubmit the same arguments.",
      ];
  return [
    "The public decision validator rejected that submission.",
    ...errors.map((error) => `- ${error}`),
    ...projectionText,
  ].join("\n");
}

export function createOpenAiCompatibleMarketingPolicy(input: {
  baseUrl: string;
  modelId: string;
  request?: typeof fetch;
  maximumOutputTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  captureOptimizerSample?: boolean;
}): MarketingPortfolioPolicy {
  const request = input.request ?? fetch;
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  return {
    async complete({ messages, tools, requiredToolName, signal }) {
      const startedAt = new Date().toISOString();
      const monotonicStartedAt = performance.now();
      const temperature = input.temperature ?? 0.2;
      const topP = input.topP ?? 0.95;
      const maximumOutputTokens = input.maximumOutputTokens ?? 1_024;
      const captureOptimizerSample = input.captureOptimizerSample ?? false;
      const response = await request(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.modelId,
          messages: messages.map(toOpenAiMessage),
          tools,
          tool_choice: {
            type: "function",
            function: { name: requiredToolName },
          },
          parallel_tool_calls: false,
          temperature,
          top_p: topP,
          max_tokens: maximumOutputTokens,
          seed: input.seed,
          logprobs: captureOptimizerSample,
          top_logprobs: captureOptimizerSample ? 0 : undefined,
          return_token_ids: captureOptimizerSample,
        }),
        signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `Prime vLLM chat completion failed (${response.status}): ${text.slice(0, 1_000)}`,
        );
      }
      const payload = object(JSON.parse(text), "Prime vLLM response");
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const choice = object(choices[0], "Prime vLLM first choice");
      const message = object(choice.message, "Prime vLLM response message");
      const promptTokenIds = integerArray(
        payload.prompt_token_ids,
        "Prime vLLM prompt token IDs",
        captureOptimizerSample,
      );
      const generatedTokenIds = integerArray(
        choice.token_ids,
        "Prime vLLM generated token IDs",
        captureOptimizerSample,
      );
      const generatedLogprobs = completionLogprobs(
        choice.logprobs,
        captureOptimizerSample,
      );
      if (
        captureOptimizerSample
        && generatedTokenIds.length !== generatedLogprobs.length
      ) {
        throw new Error(
          "Prime vLLM generated token IDs and original logprobs are misaligned.",
        );
      }
      const usage = object(payload.usage ?? {}, "Prime vLLM usage");
      const requestId = requiredString(payload.id, "Prime vLLM request ID");
      const servedModel = requiredString(
        payload.model,
        "Prime vLLM served model",
      );
      const completedAt = new Date().toISOString();
      const calls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
      return {
        content: typeof message.content === "string" ? message.content : null,
        toolCalls: calls.map((value, index) => {
          const call = object(value, `Prime vLLM tool call ${index + 1}`);
          const fn = object(call.function, `Prime vLLM tool function ${index + 1}`);
          return {
            id:
              typeof call.id === "string" && call.id.trim()
                ? call.id
                : `tool_call_${index + 1}`,
            name: requiredString(fn.name, "Prime vLLM tool name"),
            arguments:
              typeof fn.arguments === "string"
                ? fn.arguments
                : JSON.stringify(fn.arguments ?? {}),
          };
        }),
        samplingTrace: {
          requestId,
          servedModel,
          startedAt,
          completedAt,
          durationMs: Math.max(0, performance.now() - monotonicStartedAt),
          requested: {
            temperature,
            topP,
            maxOutputTokens: maximumOutputTokens,
            logprobs: captureOptimizerSample,
            tokenIds: captureOptimizerSample,
          },
          support: {
            temperature: "applied",
            topP: "applied",
            logprobs: captureOptimizerSample ? "returned" : "unknown",
            tokenIds: captureOptimizerSample ? "returned" : "unknown",
          },
          promptTokenIds,
          generatedTokenIds,
          generatedLogprobs,
          usage: {
            promptTokens: captureOptimizerSample
              ? promptTokenIds.length
              : nonNegativeInteger(usage.prompt_tokens),
            generatedTokens: captureOptimizerSample
              ? generatedTokenIds.length
              : nonNegativeInteger(usage.completion_tokens),
          },
        },
      };
    },
  };
}

function optimizerSampleFromTrace(input: {
  assignment: PrimeRolloutAssignment;
  trace: RolloutSamplingTrace | null;
}): OptimizerTrainingSample | null {
  const trace = input.trace;
  if (
    !trace
    || trace.promptTokenIds.length === 0
    || trace.generatedTokenIds.length === 0
    || trace.generatedLogprobs.length !== trace.generatedTokenIds.length
  ) {
    return null;
  }
  const promptTokenCount = trace.promptTokenIds.length;
  const completionTokenCount = trace.generatedTokenIds.length;
  return {
    schemaVersion: "openpond.optimizerTrainingSample.v1",
    tokenIds: [...trace.promptTokenIds, ...trace.generatedTokenIds],
    mask: [
      ...Array.from({ length: promptTokenCount }, () => false),
      ...Array.from({ length: completionTokenCount }, () => true),
    ],
    logprobs: [
      ...Array.from({ length: promptTokenCount }, () => 0),
      ...trace.generatedLogprobs,
    ],
    temperatures: Array.from(
      { length: promptTokenCount + completionTokenCount },
      () => trace.requested.temperature,
    ),
    envName: "marketing-portfolio-v1",
    modelRequestId: trace.requestId,
    promptTokenCount,
    completionTokenCount,
    servedPolicyVersion:
      input.assignment.policyVersion === "base"
        ? 0
        : input.assignment.policyVersion,
  };
}

function integerArray(
  value: unknown,
  label: string,
  required: boolean,
): number[] {
  if (!Array.isArray(value)) {
    if (required) throw new Error(`${label} were not returned.`);
    return [];
  }
  const values = value.filter(
    (item): item is number =>
      typeof item === "number"
      && Number.isInteger(item)
      && item >= 0,
  );
  if (values.length !== value.length) {
    throw new Error(`${label} contain an invalid value.`);
  }
  return values;
}

function completionLogprobs(value: unknown, required: boolean): number[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (required) {
      throw new Error("Prime vLLM completion logprobs were not returned.");
    }
    return [];
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    return record.content.map((entry, index) => {
      const candidate = object(
        entry,
        `Prime vLLM completion logprob ${index + 1}`,
      );
      const logprob = candidate.logprob;
      if (
        typeof logprob !== "number"
        || !Number.isFinite(logprob)
      ) {
        throw new Error("Prime vLLM returned an invalid completion logprob.");
      }
      return logprob;
    });
  }
  if (Array.isArray(record.token_logprobs)) {
    return record.token_logprobs.map((logprob) => {
      if (
        typeof logprob !== "number"
        || !Number.isFinite(logprob)
      ) {
        throw new Error("Prime vLLM returned an invalid completion logprob.");
      }
      return logprob;
    });
  }
  if (required) {
    throw new Error("Prime vLLM completion logprobs were not returned.");
  }
  return [];
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    ? value
    : 0;
}

function toOpenAiMessage(message: PolicyMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          })),
        }
      : {}),
  };
}

function assertAssignment(
  taskset: Taskset,
  task: TaskDataRecord,
  assignment: PrimeRolloutAssignment,
  allowedSplits: Array<"train" | "validation" | "frozen_eval">,
): void {
  if (
    assignment.taskset.id !== taskset.id
    || assignment.taskset.revision !== taskset.revision
    || assignment.taskset.contentHash !== taskset.contentHash
    || assignment.taskId !== task.id
    || assignment.split !== task.split
    || !allowedSplits.includes(task.split)
  ) {
    throw new Error("Prime rollout assignment does not match the immutable Dataset row.");
  }
  if (
    !taskset.profileRelease
    || assignment.profileRelease.id !== taskset.profileRelease.id
    || assignment.profileRelease.revision !== taskset.profileRelease.revision
    || assignment.profileRelease.contentHash !== taskset.profileRelease.contentHash
  ) {
    throw new Error("Prime rollout assignment does not match the pinned Profile release.");
  }
}

function benchmarkMetadata(taskset: Taskset): {
  scorerImplementationHash: string;
} {
  const benchmark = object(
    taskset.environment.metadata.benchmark,
    "marketing benchmark metadata",
  );
  const scorer = object(benchmark.scorer, "marketing benchmark scorer");
  return {
    scorerImplementationHash: requiredString(
      scorer.implementationHash,
      "marketing scorer implementation hash",
    ),
  };
}

function privateCaseId(task: TaskDataRecord): string {
  return requiredString(task.metadata.caseId, "private Dataset case ID");
}

function taskPrompt(task: TaskDataRecord): string {
  return requiredString(task.input.prompt, "Dataset prompt");
}

function parseToolArguments(call: PolicyToolCall): Record<string, unknown> {
  try {
    return object(JSON.parse(call.arguments), `Arguments for ${call.name}`);
  } catch (error) {
    throw new Error(
      `Policy returned invalid JSON arguments for ${call.name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function sanitizeStudentObservation(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const output = structuredClone(value);
  stripPrivateSelectors(output);
  return output;
}

function stripPrivateSelectors(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) stripPrivateSelectors(item);
    return;
  }
  const record = value as Record<string, unknown>;
  delete record.scenarioId;
  delete record.caseId;
  delete record.split;
  for (const child of Object.values(record)) stripPrivateSelectors(child);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}
