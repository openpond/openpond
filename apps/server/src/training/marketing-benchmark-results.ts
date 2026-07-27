import {
  CorrelatedTelemetryReceiptSchema,
  MarketingBenchmarkReceiptSchema,
  MarketingBenchmarkTrajectoryReceiptSchema,
  type ChatModelRef,
  type MarketingBenchmarkArm,
  type MarketingBenchmarkReceipt,
  type MarketingBenchmarkSpecification,
  type MarketingBenchmarkTrajectoryReceipt,
  type ModelVersion,
  type TaskAttemptResult,
} from "@openpond/contracts";
import {
  canonicalJson,
  contentHash,
} from "@openpond/taskset-sdk";

import {
  resolvePrimeGrpoBaseProfile,
} from "./prime-grpo-base-profiles.js";

export function successfulMarketingBenchmarkTrajectory(input: {
  arm: MarketingBenchmarkArm;
  schedule: MarketingBenchmarkSpecification["attemptSchedule"][number];
  attempt: TaskAttemptResult;
  specification: MarketingBenchmarkSpecification;
  candidate: ModelVersion;
  adapterContentHash: string;
  provider: string;
  providerResourceIds: string[];
  providerGpuType?: string | null;
}): MarketingBenchmarkTrajectoryReceipt {
  const output = input.attempt.output;
  const metadata = input.attempt.metadata;
  const grade = record(output.harnessGrade);
  const toolSequence = stringArray(output.toolSequence);
  const terminalDecision = output.terminalDecision === true;
  const validToolLoop =
    toolSequence[0] === "get_portfolio_snapshot"
    && toolSequence.includes("submit_budget_decision");
  const responseIdentity = stringValue(
    metadata.providerResponseIdentity,
  );
  const constraintViolations = [
    ...(!validToolLoop ? ["valid_two_action_completion"] : []),
    ...(
      record(grade.components).constraints === 1
        ? []
        : ["decision_constraints"]
    ),
    ...(!responseIdentity ? ["identity_alignment"] : []),
  ];
  const policyFailure =
    stringValue(metadata.policyFailure)
    ?? (!validToolLoop
      ? "invalid_two_action_tool_loop"
      : !terminalDecision
        ? "missing_terminal_decision"
        : null);
  const failureClass =
    stringValue(input.attempt.infrastructureError)
    ?? policyFailure
    ?? (!responseIdentity ? "provider_identity_missing" : null);
  const reward = unitNumber(grade.reward);
  const telemetry = telemetryReceipt({
    arm: input.arm,
    attempt: input.attempt,
    candidate: input.candidate,
    modelVersionId:
      input.arm === "candidate"
        ? input.candidate.id
        : input.specification.arms.find(
            (arm) => arm.arm === input.arm,
          )?.modelVersionId ?? null,
    adapterContentHash: input.adapterContentHash,
    provider: input.provider,
    providerResourceIds: input.providerResourceIds,
    providerGpuType: input.providerGpuType,
    outcome: failureClass ? "failed" : "succeeded",
  });
  return MarketingBenchmarkTrajectoryReceiptSchema.parse({
    arm: input.arm,
    taskId: input.schedule.taskId,
    attempt: input.schedule.attempt,
    seed: input.schedule.seed,
    attemptRef: input.attempt.id,
    gradeRef:
      `grade_${contentHash(grade).slice(0, 24)}`,
    reward: failureClass ? 0 : reward,
    passed:
      failureClass === null
      && terminalDecision
      && validToolLoop
      && grade.decisionAccepted === true,
    toolSequence,
    terminalDecision,
    constraintViolations,
    failureClass,
    providerSamplingSupport:
      samplingSupport(metadata.providerSamplingSupport),
    providerResponseIdentity:
      responseIdentity
      ?? canonicalJson({
        provider: input.provider,
        requestedModel: input.attempt.modelRef,
        status: "missing",
      }),
    telemetry,
  });
}

export function failedMarketingBenchmarkTrajectory(input: {
  arm: MarketingBenchmarkArm;
  schedule: MarketingBenchmarkSpecification["attemptSchedule"][number];
  model: ChatModelRef;
  candidate: ModelVersion;
  specification: MarketingBenchmarkSpecification;
  adapterContentHash: string;
  provider: string;
  providerResourceIds: string[];
  providerGpuType?: string | null;
  error: unknown;
  startedAt: string;
  completedAt: string;
}): MarketingBenchmarkTrajectoryReceipt {
  const message = safeMessage(input.error);
  const attemptRef =
    `attempt_${contentHash([
      input.arm,
      input.schedule,
      message,
    ]).slice(0, 24)}`;
  const attempt: TaskAttemptResult = {
    schemaVersion: "openpond.taskAttempt.v1",
    id: attemptRef,
    tasksetId: input.candidate.taskset.id,
    taskId: input.schedule.taskId,
    split: "frozen_eval",
    attempt: input.schedule.attempt,
    seed: input.schedule.seed,
    modelRef: input.model,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    output: {},
    runtimeEventRefs: [],
    artifactRefs: [],
    privilegedOutcomeRef: null,
    infrastructureError: message,
    costUsd: null,
    latencyMs: elapsed(input.startedAt, input.completedAt),
    userInterventions: 0,
    metadata: {},
  };
  return MarketingBenchmarkTrajectoryReceiptSchema.parse({
    arm: input.arm,
    taskId: input.schedule.taskId,
    attempt: input.schedule.attempt,
    seed: input.schedule.seed,
    attemptRef,
    gradeRef: `grade_${contentHash([
      attemptRef,
      "infrastructure_failure",
    ]).slice(0, 24)}`,
    reward: null,
    passed: false,
    toolSequence: [],
    terminalDecision: false,
    constraintViolations: [
      "valid_two_action_completion",
      "identity_alignment",
    ],
    failureClass: "infrastructure_failure",
    providerSamplingSupport: {
      seed: false,
      temperature: false,
      topP: false,
    },
    providerResponseIdentity: canonicalJson({
      provider: input.provider,
      requestedModel: input.model,
      status: "failed_before_response",
    }),
    telemetry: telemetryReceipt({
      arm: input.arm,
      attempt,
      candidate: input.candidate,
      modelVersionId:
        input.arm === "candidate"
          ? input.candidate.id
          : input.specification.arms.find(
              (arm) => arm.arm === input.arm,
            )?.modelVersionId ?? null,
      adapterContentHash: input.adapterContentHash,
      provider: input.provider,
      providerResourceIds: input.providerResourceIds,
      providerGpuType: input.providerGpuType,
      outcome: "failed",
    }),
  });
}

export function allocatePrimeEvaluationCost(
  trajectories: MarketingBenchmarkTrajectoryReceipt[],
  estimatedCostUsd: number | null,
): MarketingBenchmarkTrajectoryReceipt[] {
  if (estimatedCostUsd === null) return trajectories;
  const primeTrajectories = trajectories.filter(
    (trajectory) =>
      trajectory.arm === "base"
      || trajectory.arm === "candidate",
  );
  const totalRequests = primeTrajectories.reduce(
    (sum, trajectory) =>
      sum
      + (
        trajectory.telemetry.cost.pricingInputs.requestCount
        ?? 0
      ),
    0,
  );
  return trajectories.map((trajectory) => {
    if (
      trajectory.arm === "frontier_reference"
      || totalRequests === 0
    ) {
      return trajectory;
    }
    const requestCount =
      trajectory.telemetry.cost.pricingInputs.requestCount
      ?? 0;
    const allocated = roundUsd(
      estimatedCostUsd * requestCount / totalRequests,
    );
    const telemetryCore = {
      ...trajectory.telemetry,
      cost: {
        ...trajectory.telemetry.cost,
        estimatedUsd: allocated,
        methodologyVersion:
          "prime_session_cost_by_inference_request.v1",
        pricingInputs: {
          ...trajectory.telemetry.cost.pricingInputs,
          sessionEstimatedUsd: estimatedCostUsd,
          sessionRequestCount: totalRequests,
        },
      },
      contentHash: undefined,
    };
    delete (telemetryCore as { contentHash?: unknown }).contentHash;
    const telemetry = CorrelatedTelemetryReceiptSchema.parse({
      ...telemetryCore,
      contentHash: contentHash(telemetryCore),
    });
    return MarketingBenchmarkTrajectoryReceiptSchema.parse({
      ...trajectory,
      telemetry,
    });
  });
}

export function buildMarketingBenchmarkReceipt(input: {
  id: string;
  specification: MarketingBenchmarkSpecification;
  candidate: ModelVersion;
  trajectories: MarketingBenchmarkTrajectoryReceipt[];
  createdAt: string;
}): MarketingBenchmarkReceipt {
  const aggregate = {
    base: armAggregate(input.trajectories, "base"),
    candidate: armAggregate(
      input.trajectories,
      "candidate",
    ),
    frontier_reference: armAggregate(
      input.trajectories,
      "frontier_reference",
    ),
  };
  const taskDeltas =
    input.specification.frozenTaskIds.map((taskId) =>
      taskMean(input.trajectories, "candidate", taskId)
      - taskMean(input.trajectories, "base", taskId)
    );
  const candidateMinusBase = roundMetric(
    aggregate.candidate.meanReward
    - aggregate.base.meanReward,
  );
  const candidateMinusFrontier = roundMetric(
    aggregate.candidate.meanReward
    - aggregate.frontier_reference.meanReward,
  );
  const hardGatesPassed = criticalGatesPass({
    trajectories: input.trajectories,
    left: "candidate",
    right: "base",
  });
  const candidatePromotionPassed =
    aggregate.candidate.meanReward
      >= input.specification.promotionGate
        .minimumCandidateScore
    && candidateMinusBase
      >= input.specification.promotionGate
        .minimumImprovement
    && hardGatesPassed;
  const frontierWinnerClaimPassed =
    candidateMinusFrontier > 0
    && criticalGatesPass({
      trajectories: input.trajectories,
      left: "candidate",
      right: "frontier_reference",
    });
  const disclosure = disclosureText({
    specification: input.specification,
    aggregate,
    candidateMinusBase,
    candidateMinusFrontier,
    candidatePromotionPassed,
    frontierWinnerClaimPassed,
    createdAt: input.createdAt,
  });
  const core = {
    schemaVersion:
      "openpond.marketingBenchmarkReceipt.v1" as const,
    id: input.id,
    specificationId: input.specification.id,
    specificationHash: input.specification.contentHash,
    candidateModelVersionId: input.candidate.id,
    trajectories: input.trajectories,
    aggregate,
    pairedComparison: {
      candidateMinusBase,
      candidateMinusFrontier,
      taskLevelStandardError:
        roundMetric(standardError(taskDeltas)),
      candidatePromotionPassed,
      frontierWinnerClaimPassed,
    },
    disclosure,
    createdAt: input.createdAt,
  };
  return MarketingBenchmarkReceiptSchema.parse({
    ...core,
    contentHash: contentHash(core),
  });
}

function telemetryReceipt(input: {
  arm: MarketingBenchmarkArm;
  attempt: TaskAttemptResult;
  candidate: ModelVersion;
  modelVersionId: string | null;
  adapterContentHash: string;
  provider: string;
  providerResourceIds: string[];
  providerGpuType?: string | null;
  outcome: "succeeded" | "failed" | "cancelled";
}) {
  const baseProfile = resolvePrimeGrpoBaseProfile(
    input.candidate.baseModel,
  );
  const metadata = input.attempt.metadata;
  const metadataSpans = Array.isArray(metadata.executionSpans)
    ? metadata.executionSpans
    : [];
  const spans = metadataSpans.length > 0
    ? metadataSpans
    : [{
        name: "benchmark_trajectory",
        startedAt: input.attempt.startedAt,
        completedAt: input.attempt.completedAt,
        durationMs: input.attempt.latencyMs,
        clock: "wall",
        outcome: input.outcome,
      }];
  const responseFacts = Array.isArray(
    metadata.providerResponseFacts,
  )
    ? metadata.providerResponseFacts
    : [];
  const core = {
    schemaVersion:
      "openpond.correlatedTelemetryReceipt.v1" as const,
    stage: "evaluation" as const,
    correlation: {
      modelRunId: null,
      modelVersionId: input.modelVersionId,
      policyVersion:
        input.arm === "candidate"
          ? 1
          : input.arm === "base"
            ? 0
            : null,
      taskId: input.attempt.taskId,
      rolloutGroupId: null,
      providerResourceId:
        input.providerResourceIds[0] ?? null,
      deploymentId: null,
      inferenceRequestId:
        stringValue(metadata.requestId),
    },
    spans,
    usage: {
      promptTokens: integerOrNull(metadata.promptTokens),
      generatedTokens:
        integerOrNull(metadata.generatedTokens),
      gpuSeconds: null,
      workerActiveSeconds: null,
      optimizerSteps: null,
      rolloutGroups: null,
      successfulTrajectories:
        input.outcome === "succeeded" ? 1 : 0,
      failedTrajectories:
        input.outcome === "succeeded" ? 0 : 1,
      peakGpuMemoryBytes: null,
      peakGpuUtilizationPercent: null,
    },
    resource: {
      provider: input.provider,
      resourceIds: input.providerResourceIds,
      gpuType:
        input.provider === "prime"
          ? input.providerGpuType ?? null
          : null,
      gpuCount: input.provider === "prime" ? 1 : null,
      baseProfileId:
        input.provider === "prime"
          ? baseProfile?.baseProfileId ?? null
          : null,
      baseRepository:
        input.provider === "prime"
          ? input.candidate.baseModel.modelId
          : null,
      baseRevision:
        input.provider === "prime"
          ? input.candidate.baseModel.revision
          : null,
      adapterContentHash:
        input.arm === "candidate"
          ? input.adapterContentHash
          : null,
    },
    cost: {
      currency: "USD" as const,
      providerReportedUsd: input.attempt.costUsd,
      quotedHourlyUsd: null,
      estimatedUsd: null,
      methodologyVersion: "raw_request_facts.v1",
      pricingInputs: {
        requestCount: responseFacts.length,
      },
      unitEstimates: {},
    },
    recordedAt: input.attempt.completedAt,
  };
  return CorrelatedTelemetryReceiptSchema.parse({
    ...core,
    contentHash: contentHash(core),
  });
}

function armAggregate(
  trajectories: MarketingBenchmarkTrajectoryReceipt[],
  arm: MarketingBenchmarkArm,
) {
  const selected = trajectories.filter(
    (trajectory) => trajectory.arm === arm,
  );
  const taskIds = [...new Set(
    selected.map((trajectory) => trajectory.taskId),
  )];
  const meanReward = mean(
    taskIds.map((taskId) =>
      taskMean(trajectories, arm, taskId)
    ),
  );
  const costs = selected.map(
    (trajectory) =>
      trajectory.telemetry.cost.providerReportedUsd
      ?? trajectory.telemetry.cost.estimatedUsd,
  );
  return {
    uniqueTaskCount: 8 as const,
    trajectoryCount: 32 as const,
    meanReward: roundMetric(meanReward),
    passRate: roundMetric(
      mean(selected.map((trajectory) =>
        trajectory.passed ? 1 : 0
      )),
    ),
    validToolCompletionRate: roundMetric(
      mean(selected.map((trajectory) =>
        validToolCompletion(trajectory) ? 1 : 0
      )),
    ),
    terminalDecisionRate: roundMetric(
      mean(selected.map((trajectory) =>
        trajectory.terminalDecision ? 1 : 0
      )),
    ),
    latencyMs: selected.reduce(
      (sum, trajectory) =>
        sum + spanDuration(trajectory),
      0,
    ),
    promptTokens: selected.reduce(
      (sum, trajectory) =>
        sum
        + (
          trajectory.telemetry.usage.promptTokens
          ?? 0
        ),
      0,
    ),
    generatedTokens: selected.reduce(
      (sum, trajectory) =>
        sum
        + (
          trajectory.telemetry.usage.generatedTokens
          ?? 0
        ),
      0,
    ),
    costUsd: costs.some((cost) => cost === null)
      ? null
      : roundUsd(
          costs.reduce<number>(
            (sum, cost) => sum + (cost ?? 0),
            0,
          ),
        ),
  };
}

function taskMean(
  trajectories: MarketingBenchmarkTrajectoryReceipt[],
  arm: MarketingBenchmarkArm,
  taskId: string,
): number {
  return mean(
    trajectories
      .filter(
        (trajectory) =>
          trajectory.arm === arm
          && trajectory.taskId === taskId,
      )
      .map((trajectory) => trajectory.reward ?? 0),
  );
}

function criticalGatesPass(input: {
  trajectories: MarketingBenchmarkTrajectoryReceipt[];
  left: MarketingBenchmarkArm;
  right: MarketingBenchmarkArm;
}): boolean {
  const left = gateRates(input.trajectories, input.left);
  const right = gateRates(input.trajectories, input.right);
  return left.identityAlignment === 1
    && left.validToolCompletion >= right.validToolCompletion
    && left.constraintValidity >= right.constraintValidity;
}

function gateRates(
  trajectories: MarketingBenchmarkTrajectoryReceipt[],
  arm: MarketingBenchmarkArm,
) {
  const selected = trajectories.filter(
    (trajectory) => trajectory.arm === arm,
  );
  return {
    identityAlignment: mean(selected.map((trajectory) =>
      trajectory.constraintViolations.includes(
        "identity_alignment",
      )
        ? 0
        : 1
    )),
    validToolCompletion: mean(selected.map((trajectory) =>
      validToolCompletion(trajectory) ? 1 : 0
    )),
    constraintValidity: mean(selected.map((trajectory) =>
      trajectory.constraintViolations.includes(
        "decision_constraints",
      )
        ? 0
        : 1
    )),
  };
}

function validToolCompletion(
  trajectory: MarketingBenchmarkTrajectoryReceipt,
): boolean {
  return trajectory.failureClass === null
    && trajectory.toolSequence[0]
      === "get_portfolio_snapshot"
    && trajectory.toolSequence.includes(
      "submit_budget_decision",
    )
    && trajectory.terminalDecision;
}

function disclosureText(input: {
  specification: MarketingBenchmarkSpecification;
  aggregate: ReturnType<typeof buildAggregateForDisclosure>;
  candidateMinusBase: number;
  candidateMinusFrontier: number;
  candidatePromotionPassed: boolean;
  frontierWinnerClaimPassed: boolean;
  createdAt: string;
}): string {
  const frontier = input.specification.arms.find(
    (arm) => arm.arm === "frontier_reference",
  )!;
  return [
    "Marketing Portfolio v1 frozen benchmark.",
    `Measured ${input.specification.frozenTaskIds.length} unique frozen tasks with ${input.specification.attemptsPerTask} attempts per task (96 tool-using trajectories total) on ${input.createdAt.slice(0, 10)}.`,
    `Candidate mean deterministic reward ${input.aggregate.candidate.meanReward.toFixed(6)}; pinned base ${input.aggregate.base.meanReward.toFixed(6)} (delta ${signed(input.candidateMinusBase)}); ${frontier.model.modelId} ${input.aggregate.frontier_reference.meanReward.toFixed(6)} (delta ${signed(input.candidateMinusFrontier)}).`,
    `Grader ${input.specification.grader.id}@${input.specification.grader.contentHash}; specification ${input.specification.id}@${input.specification.contentHash}.`,
    input.candidatePromotionPassed
      ? "The preregistered candidate-versus-base promotion gate passed."
      : "The preregistered candidate-versus-base promotion gate did not pass.",
    input.frontierWinnerClaimPassed
      ? `The candidate beat ${frontier.model.modelId} under this bounded benchmark and its critical hard gates.`
      : `No winner claim over ${frontier.model.modelId} is made.`,
    "Uncertainty is computed across eight paired unique-task mean differences; repeated attempts are not treated as independent tasks.",
  ].join(" ");
}

function buildAggregateForDisclosure() {
  return {
    base: armAggregate([], "base"),
    candidate: armAggregate([], "candidate"),
    frontier_reference:
      armAggregate([], "frontier_reference"),
  };
}

function samplingSupport(value: unknown) {
  const support = record(value);
  return {
    seed: support.seed === true,
    temperature: support.temperature === true,
    topP: support.topP === true,
  };
}

function spanDuration(
  trajectory: MarketingBenchmarkTrajectoryReceipt,
): number {
  return trajectory.telemetry.spans.reduce(
    (sum, span) => sum + span.durationMs,
    0,
  );
}

function standardError(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce(
    (sum, value) => sum + (value - average) ** 2,
    0,
  ) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
      / values.length
    : 0;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    ? value
    : null;
}

function unitNumber(value: unknown): number | null {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= 1
    ? value
    : null;
}

function record(value: unknown): Record<string, unknown> {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function safeMessage(error: unknown): string {
  return (
    error instanceof Error ? error.message : String(error)
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 10_000);
}

function elapsed(startedAt: string, completedAt: string): number {
  return Math.max(
    0,
    Math.round(
      new Date(completedAt).getTime()
      - new Date(startedAt).getTime(),
    ),
  );
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(6)}`;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
