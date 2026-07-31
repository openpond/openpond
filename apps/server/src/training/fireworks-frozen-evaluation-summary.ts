import type {
  FireworksEvaluationDeploymentReceipt,
} from "./fireworks-evaluation-runtime.js";

export type FireworksFrozenEvaluationResult = {
  taskId: string;
  stage: "base" | "trained";
  attemptId: string;
  gradeId: string;
  passed: boolean;
  score: number | null;
  infrastructureError: string | null;
};

export function summarizeFireworksFrozenEvaluation(input: {
  results: FireworksFrozenEvaluationResult[];
  deployments: FireworksEvaluationDeploymentReceipt[];
  taskCount: number;
  minimumTrainedPassRate: number;
  minimumAbsolutePassRateGain: number;
  priorEvaluationCostUsd: number;
  providerTrainingCostUsd: number;
  unreceiptedEvaluationCostReserveUsd: number;
  nonBillableStartupCorrectionUsd: number;
  maximumDeploymentCostUsd: number;
  maximumRuntimeMs: number;
}) {
  const basePassed = input.results.filter(
    (result) => result.stage === "base" && result.passed,
  ).length;
  const trainedPassed = input.results.filter(
    (result) => result.stage === "trained" && result.passed,
  ).length;
  const baseInfrastructureFailures = input.results.filter(
    (result) =>
      result.stage === "base" && result.infrastructureError !== null,
  ).length;
  const trainedInfrastructureFailures = input.results.filter(
    (result) =>
      result.stage === "trained" && result.infrastructureError !== null,
  ).length;
  const infrastructureFailureCount =
    baseInfrastructureFailures + trainedInfrastructureFailures;
  const deploymentCleanupComplete = input.deployments.every(
    (deployment) =>
      (
        deployment.deletionStatus === "deleted" ||
        deployment.deletionStatus === "not_created"
      ) &&
      deployment.addonUnloadStatus !== "failed",
  );
  const estimatedDeploymentCostUsd = input.deployments.reduce(
    (total, deployment) => total + deployment.estimatedCostUsd,
    0,
  );
  const cumulativeEvaluationCostUsd =
    input.priorEvaluationCostUsd + estimatedDeploymentCostUsd;
  const receiptedProviderCostUsd =
    input.providerTrainingCostUsd + cumulativeEvaluationCostUsd;
  const cumulativeProviderCostUsd = Math.max(
    0,
    receiptedProviderCostUsd -
      input.nonBillableStartupCorrectionUsd +
      input.unreceiptedEvaluationCostReserveUsd,
  );
  const evaluationComplete =
    input.taskCount > 0 &&
    infrastructureFailureCount === 0 &&
    deploymentCleanupComplete;
  const basePassRate = input.taskCount
    ? basePassed / input.taskCount
    : 0;
  const trainedPassRate = input.taskCount
    ? trainedPassed / input.taskCount
    : 0;
  const absolutePassRateGain = trainedPassRate - basePassRate;
  const thresholdPassed =
    evaluationComplete &&
    trainedPassRate >= input.minimumTrainedPassRate &&
    absolutePassRateGain >= input.minimumAbsolutePassRateGain;

  return {
    basePassed,
    trainedPassed,
    totalPerSubject: input.taskCount,
    basePassRate,
    trainedPassRate,
    absolutePassRateGain,
    baseInfrastructureFailures,
    trainedInfrastructureFailures,
    infrastructureFailureCount,
    deploymentCleanupComplete,
    estimatedDeploymentCostUsd,
    priorEvaluationCostUsd: input.priorEvaluationCostUsd,
    unreceiptedEvaluationCostReserveUsd:
      input.unreceiptedEvaluationCostReserveUsd,
    nonBillableStartupCorrectionUsd: input.nonBillableStartupCorrectionUsd,
    cumulativeEvaluationCostUsd,
    receiptedProviderCostUsd,
    cumulativeProviderCostUsd,
    maximumDeploymentCostUsd: input.maximumDeploymentCostUsd,
    maximumRuntimeMs: input.maximumRuntimeMs,
    evaluationComplete,
    thresholdPassed,
  };
}
