import type {
  BaseModelPreference,
  RewardModelRun,
  RewardModelVersion,
} from "@openpond/contracts";
import {
  RewardModelRunReceiptSchema,
  RewardModelVersionSchema,
} from "@openpond/contracts";
import {
  createRewardModelQualificationReport,
  type RewardModelQualificationReport,
} from "@openpond/evals";
import { contentHash } from "@openpond/harness";

type InventoryFile = { path: string; sha256: string; sizeBytes: number };

export function projectRewardModelRelease(input: {
  run: RewardModelRun;
  baseModel: BaseModelPreference;
  runtime: NonNullable<RewardModelVersion["runtime"]>;
  resolvedBundleHash: string;
  profileRelease: { id: string; revision: number; contentHash: string };
  harnessRelease: { id: string; contentHash: string };
  grader: { id: string; contentHash: string };
  providerRunId: string;
  versionNumber: number;
  checkpointPrefix: string;
  artifactSha256: string;
  inventory: InventoryFile[];
  evidence: Record<string, unknown>;
  cleanup: { computeReleased: boolean; providerTerminalObserved: boolean };
  managedExecutionReceipt: { id: string; contentHash: string };
  createdAt: string;
}): {
  version: RewardModelVersion;
  receipt: NonNullable<RewardModelRun["receipt"]>;
  report: RewardModelQualificationReport | null;
} {
  if (input.run.status !== "running" || !input.cleanup.computeReleased || !input.cleanup.providerTerminalObserved) {
    throw new Error("Reward Model release requires a running Run with terminal managed cleanup.");
  }
  const files = new Map(input.inventory.map((file) => [file.path, file]));
  const adapter = requiredFile(files, "adapter/adapter_config.json");
  const scalarHead = requiredFile(files, "scalar-head.pt");
  const bucketHead = requiredFile(files, "bucket-head.pt");
  const processor = requiredFile(files, "processor/tokenizer_config.json");
  const optimizer = requiredFile(files, "optimizer.pt");
  const ref = (file: InventoryFile) => ({
    id: `${input.providerRunId}:${file.path}`.replaceAll("/", ":"),
    contentHash: file.sha256,
  });
  const checkpoint = {
    id: `${input.providerRunId}:checkpoint`,
    contentHash: input.artifactSha256,
    objectRef: input.checkpointPrefix,
    files: input.inventory,
  };
  const versionCore = {
    schemaVersion: "openpond.rewardModelVersion.v1" as const,
    id: `reward-model-version:${input.providerRunId}`,
    modelId: input.run.rewardModelId,
    profileId: input.run.profileId,
    version: input.versionNumber,
    role: "reward" as const,
    status: "available" as const,
    scope: input.run.scope,
    baseModel: input.baseModel,
    runtime: input.runtime,
    taskset: input.run.taskset,
    preferenceDatasetRelease: input.run.preferenceDatasetRelease,
    releaseGraph: {
      resolvedBundleHash: input.resolvedBundleHash,
      profileRelease: input.profileRelease,
      harnessRelease: input.harnessRelease,
      grader: input.grader,
    },
    artifacts: {
      checkpoint,
      adapter: ref(adapter),
      scalarHead: ref(scalarHead),
      bucketHead: ref(bucketHead),
      processorRelease: ref(processor),
    },
    qualificationReport: null,
    createdAt: input.createdAt,
  };
  const provisional = RewardModelVersionSchema.parse({
    ...versionCore,
    contentHash: contentHash(versionCore),
  });
  // The report pins the immutable version. Keeping the optional reverse ref
  // null avoids a self-referential content-hash cycle.
  const version = provisional;
  const report = projectOptionalQualificationReport({
    run: input.run,
    version,
    providerRunId: input.providerRunId,
    checkpointPrefix: input.checkpointPrefix,
    artifactSha256: input.artifactSha256,
    evidence: input.evidence,
    createdAt: input.createdAt,
  });
  const receiptCore = {
    schemaVersion: "openpond.rewardModelRunReceipt.v1" as const,
    provider: "sandbox-managed-rl",
    providerRunId: input.providerRunId,
    resolvedBundleHash: input.resolvedBundleHash,
    finalCheckpoint: {
      id: checkpoint.id,
      contentHash: checkpoint.contentHash,
      objectRef: checkpoint.objectRef,
    },
    adapter: version.artifacts.adapter,
    scalarHead: version.artifacts.scalarHead,
    bucketHead: version.artifacts.bucketHead,
    processorRelease: version.artifacts.processorRelease,
    optimizerEvidence: ref(optimizer),
    managedExecutionReceipt: input.managedExecutionReceipt,
    parameterDeltaHash: contentHash({ before: input.evidence.parameterHashBefore, after: input.evidence.parameterHashAfter }),
    cleanup: input.cleanup,
  };
  return {
    version,
    report,
    receipt: RewardModelRunReceiptSchema.parse({ ...receiptCore, contentHash: contentHash(receiptCore) }),
  };
}

function projectOptionalQualificationReport(input: {
  run: RewardModelRun;
  version: RewardModelVersion;
  providerRunId: string;
  checkpointPrefix: string;
  artifactSha256: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}): RewardModelQualificationReport | null {
  const qualification = recordOrNull(input.evidence.qualification);
  if (!qualification) return null;
  const scoreVariance = finiteNumber(qualification.scoreVariance);
  const finiteScoreRate = finiteNumber(qualification.finiteScoreRate);
  const sampleCount = positiveInteger(qualification.sampleCount);
  if (
    scoreVariance === null
    || scoreVariance <= 0
    || finiteScoreRate !== 1
    || sampleCount === null
    || qualification.checkpointReloadPassed !== true
    || qualification.processorCompatibilityPassed !== true
    || qualification.invalidAttemptExclusionPassed !== true
  ) {
    return null;
  }
  return createRewardModelQualificationReport({
    schemaVersion: "openpond.rewardModelQualificationReport.v1",
    id: `reward-model-qualification:${input.providerRunId}`,
    kind: input.run.scope === "synthetic_smoke" ? "synthetic_smoke" : "human_heldout",
    rewardModelVersion: { id: input.version.id, contentHash: input.version.contentHash },
    preferenceDatasetRelease: input.run.preferenceDatasetRelease,
    tasksetRelease: input.run.tasksetRelease,
    processorRelease: input.version.artifacts.processorRelease,
    metrics: {
      sampleCount,
      finiteScoreRate,
      scoreVariance,
      checkpointReloadPassed: true,
      processorCompatibilityPassed: true,
      invalidAttemptExclusionPassed: true,
      orderedPairAccuracy: null,
      bucketAccuracy: null,
      tieAgreement: null,
    },
    passed: true,
    productionRewardEligible: input.run.scope !== "synthetic_smoke",
    createdAt: input.createdAt,
    metadata: {
      checkpointPrefix: input.checkpointPrefix,
      artifactSha256: input.artifactSha256,
    },
  });
}

function requiredFile(files: Map<string, InventoryFile>, path: string): InventoryFile {
  const file = files.get(path);
  if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || file.sizeBytes < 1) {
    throw new Error(`Reward Model checkpoint inventory is missing ${path}.`);
  }
  return file;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null;
}
