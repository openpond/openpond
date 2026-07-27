import {
  LearningSignalEnvelopeSchema,
  type LearningSignalEnvelope,
  type LearningSignalLineage,
  type PrimeRolloutResult,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

export function createMarketingRolloutLearningSignals(input: {
  result: PrimeRolloutResult;
  lineage: LearningSignalLineage;
  traceRef: string;
  traceHash: string;
  graderEvidenceRefs?: string[];
  createdAt?: string;
}): [LearningSignalEnvelope, LearningSignalEnvelope] {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const policyVersion =
    input.result.policyVersion === "base"
      ? 0
      : input.result.policyVersion;
  const episodeId = input.result.resultHash;
  const eligible =
    input.result.status === "succeeded"
    && input.result.grade !== null;
  const trajectoryBase = {
    schemaVersion: "openpond.learningSignal.v1" as const,
    id: `trajectory_${input.result.resultHash.slice(0, 24)}`,
    taskId: input.result.taskId,
    episodeId,
    policyVersion,
    lineage: input.lineage,
    approved: eligible,
    verifier: "deterministic" as const,
    createdAt,
    metadata: {
      source: "marketing-portfolio-v1",
      servedModel: input.result.model.id,
      servedRevision: input.result.model.revision,
      requestIds: input.result.samplingTraces.map((trace) => trace.requestId),
      toolSequence: input.result.toolSequence,
    },
    kind: "trajectory" as const,
    payload: {
      traceRef: input.traceRef,
      traceHash: input.traceHash,
      terminal: input.result.terminal,
      failureClass: eligible && input.result.terminal
        ? null
        : "policy_failure" as const,
      optimizerSample: input.result.optimizerSample,
    },
  };
  const trajectory = LearningSignalEnvelopeSchema.parse({
    ...trajectoryBase,
    contentHash: contentHash(trajectoryBase),
  });
  const rewardBase = {
    schemaVersion: "openpond.learningSignal.v1" as const,
    id: `reward_${input.result.resultHash.slice(0, 24)}`,
    taskId: input.result.taskId,
    episodeId,
    policyVersion,
    lineage: input.lineage,
    approved: eligible,
    verifier: "deterministic" as const,
    createdAt,
    metadata: {
      source: "marketing-portfolio-v1",
      terminal: input.result.terminal,
    },
    kind: "reward" as const,
    payload: {
      reward: input.result.grade?.reward ?? 0,
      components: input.result.grade?.components ?? {
        constraints: 0,
        portfolioValue: 0,
        riskControls: 0,
        rationale: 0,
      },
      eligible,
      graderEvidenceRefs: input.graderEvidenceRefs ?? [],
    },
  };
  const reward = LearningSignalEnvelopeSchema.parse({
    ...rewardBase,
    contentHash: contentHash(rewardBase),
  });
  return [trajectory, reward];
}
