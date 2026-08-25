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

export function projectQualifiedRewardModel(input: {
  run: RewardModelRun;
  baseModel: BaseModelPreference;
  runtime: NonNullable<RewardModelVersion["runtime"]>;
  resolvedBundleHash: string;
  profileRelease: { id: string; revision: number; contentHash: string };
  harnessRelease: { id: string; contentHash: string };
  grader: { id: string; contentHash: string };
  providerRunId: string;
  checkpointPrefix: string;
  artifactSha256: string;
  inventory: InventoryFile[];
  evidence: Record<string, unknown>;
  cleanup: { computeReleased: boolean; providerTerminalObserved: boolean };
  createdAt: string;
}): {
  version: RewardModelVersion;
  receipt: NonNullable<RewardModelRun["receipt"]>;
  report: RewardModelQualificationReport;
} {
  if (input.run.status !== "running" || !input.cleanup.computeReleased || !input.cleanup.providerTerminalObserved) {
    throw new Error("Reward Model qualification requires a running Run with terminal managed cleanup.");
  }
  const qualification = record(input.evidence.qualification);
  const scoreVariance = number(qualification.scoreVariance, "qualification score variance");
  const finiteScoreRate = number(qualification.finiteScoreRate, "qualification finite score rate");
  const sampleCount = integer(qualification.sampleCount, "qualification sample count");
  if (
    scoreVariance <= 0
    || finiteScoreRate !== 1
    || qualification.checkpointReloadPassed !== true
    || qualification.processorCompatibilityPassed !== true
    || qualification.invalidAttemptExclusionPassed !== true
  ) {
    throw new Error("Reward Model qualification evidence did not prove reload, processor, invalid-exclusion, finite, and varying-score gates.");
  }
  const files = new Map(input.inventory.map((file) => [file.path, file]));
  const adapter = requiredFile(files, "adapter/adapter_config.json");
  const scalarHead = requiredFile(files, "scalar-head.pt");
  const bucketHead = requiredFile(files, "bucket-head.pt");
  const processor = requiredFile(files, "processor/preprocessor_config.json");
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
    version: 1,
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
  const reportCore = {
    schemaVersion: "openpond.rewardModelQualificationReport.v1" as const,
    id: `reward-model-qualification:${input.providerRunId}`,
    kind: input.run.scope === "synthetic_smoke" ? "synthetic_smoke" as const : "human_heldout" as const,
    rewardModelVersion: { id: provisional.id, contentHash: provisional.contentHash },
    preferenceDatasetRelease: input.run.preferenceDatasetRelease,
    tasksetRelease: { id: input.run.taskset.id, contentHash: input.run.taskset.contentHash },
    processorRelease: provisional.artifacts.processorRelease,
    metrics: {
      sampleCount,
      finiteScoreRate,
      scoreVariance,
      checkpointReloadPassed: true,
      processorCompatibilityPassed: qualification.processorCompatibilityPassed === true,
      invalidAttemptExclusionPassed: qualification.invalidAttemptExclusionPassed === true,
      orderedPairAccuracy: null,
      bucketAccuracy: null,
      tieAgreement: null,
    },
    passed: true,
    productionRewardEligible: input.run.scope !== "synthetic_smoke",
    createdAt: input.createdAt,
    metadata: { checkpointPrefix: input.checkpointPrefix, artifactSha256: input.artifactSha256 },
  };
  const report = createRewardModelQualificationReport(reportCore);
  // The report pins the immutable version. Keeping the optional reverse ref
  // null avoids a self-referential content-hash cycle.
  const version = provisional;
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
    parameterDeltaHash: contentHash({ before: input.evidence.parameterHashBefore, after: input.evidence.parameterHashAfter }),
    cleanup: input.cleanup,
  };
  return {
    version,
    report,
    receipt: RewardModelRunReceiptSchema.parse({ ...receiptCore, contentHash: contentHash(receiptCore) }),
  };
}

function requiredFile(files: Map<string, InventoryFile>, path: string): InventoryFile {
  const file = files.get(path);
  if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || file.sizeBytes < 1) {
    throw new Error(`Reward Model checkpoint inventory is missing ${path}.`);
  }
  return file;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reward Model qualification evidence is invalid.");
  return value as Record<string, unknown>;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function integer(value: unknown, label: string): number {
  const parsed = number(value, label);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} is invalid.`);
  return parsed;
}
