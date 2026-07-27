import type {
  ModelArtifactLineage,
  TrainingArtifact,
} from "@openpond/contracts";
import { contentHash } from "@openpond/taskset-sdk";

import type { SqliteStore } from "../store/store.js";
import type { OpenPondTrainingProvenancePayload } from "./managed-adapter-training-provenance.js";
import { resolvePrimeGrpoBaseProfile } from "./prime-grpo-base-profiles.js";

export async function openPondTrainingProvenance(input: {
  store: SqliteStore;
  lineage: ModelArtifactLineage;
  job: NonNullable<Awaited<ReturnType<SqliteStore["getTrainingJob"]>>>;
  plan: NonNullable<Awaited<ReturnType<SqliteStore["getTrainingPlan"]>>>;
  sourceArtifact: TrainingArtifact;
  evaluation: TrainingArtifact | null;
  files: Array<{
    artifact: TrainingArtifact;
    path: string;
  }>;
}): Promise<OpenPondTrainingProvenancePayload> {
  const modelRun = (
    await input.store.listModelRuns({
      modelId: input.lineage.modelId,
    })
  ).find(
    (candidate) => candidate.adapterArtifactLineageId === input.lineage.id
  );
  if (!modelRun || modelRun.status !== "succeeded" || !modelRun.receipt) {
    throw new Error(
      "OpenPond training publication requires a successful canonical Model Run receipt."
    );
  }
  const modelVersion = await input.store.getModelVersion(
    modelRun.modelVersionId
  );
  if (
    !modelVersion ||
    modelVersion.artifactLineageId !== input.lineage.id ||
    modelVersion.kind !== "lora_adapter"
  ) {
    throw new Error(
      "OpenPond training publication requires its immutable LoRA Model Version."
    );
  }
  const baseProfile = resolvePrimeGrpoBaseProfile(modelVersion.baseModel);
  if (!baseProfile) {
    throw new Error(
      "OpenPond training publication requires a qualified exact base profile."
    );
  }
  if (!modelVersion.releaseGraph.agentRelease) {
    throw new Error(
      "OpenPond training publication requires Agent release evidence."
    );
  }
  const groupedReceiptHash = metadataHash(
    input.sourceArtifact,
    "groupedGrpoReceiptHash"
  );
  if (!groupedReceiptHash) {
    throw new Error(
      "OpenPond training publication requires the grouped GRPO optimizer receipt hash."
    );
  }
  const manifestHash =
    metadataHash(input.sourceArtifact, "manifestHash") ??
    input.plan.contentHash;
  const evaluationEvidence = input.evaluation
    ? {
        evaluationArtifactId: input.evaluation.id,
        evaluationArtifactSha256: input.evaluation.sha256,
        frozenEvaluatorHash:
          metadataHash(input.evaluation, "benchmarkSpecificationHash") ??
          input.lineage.graderHash,
      }
    : {};
  const inventory = input.files.map(({ artifact, path }) => ({
    path,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
  }));
  return {
    schemaVersion: "openpond.modelAdapterSourceProvenance.v1",
    sourceSystem: "openpond_training",
    trainingJobId: input.job.id,
    trainingPlanId: input.plan.id,
    sourceArtifactId: input.sourceArtifact.id,
    sourceArtifactSha256: input.sourceArtifact.sha256,
    sourceManifestSha256: manifestHash,
    sourceInventorySha256: contentHash(inventory),
    sourceBaseModelSha256: contentHash({
      repository: baseProfile.modelId,
      revision: baseProfile.revision,
      tokenizerRevision: baseProfile.tokenizerRevision,
      chatTemplateHash: baseProfile.chatTemplateHash,
    }),
    candidateBundleSha256: input.lineage.bundleHash,
    tasksetId: input.lineage.tasksetId,
    tasksetHash: input.lineage.tasksetHash,
    ...evaluationEvidence,
    spendAttestationSha256: contentHash({
      modelRunId: modelRun.id,
      quote: modelRun.quote,
      provider: modelRun.receipt.provider,
      providerRunId: modelRun.receipt.providerRunId,
    }),
    cleanupAttestationSha256: contentHash({
      modelRunId: modelRun.id,
      cleanup: modelRun.receipt.cleanup,
    }),
    providerRunId: modelRun.receipt.providerRunId,
    trainingMethod: "grpo",
    sourcePolicyOrCheckpoint: `${modelVersion.id}:policy-${String(
      input.job.metadata.finalPolicyVersion ?? "final"
    )}`,
    optimizerProofSha256: groupedReceiptHash,
    modelProjectId: modelVersion.modelId,
    modelRunId: modelRun.id,
    modelVersionId: modelVersion.id,
    primeRlRevision: portableEngineRevision(input.job),
    rawPrimeComputeReceiptSha256:
      modelRun.receipt.traceHash ?? modelRun.receipt.resultHash,
    harnessReleaseSha256: modelVersion.releaseGraph.harnessRelease.contentHash,
    profileReleaseSha256: modelVersion.releaseGraph.profileRelease.contentHash,
    agentReleaseSha256: modelVersion.releaseGraph.agentRelease.contentHash,
    graderSha256: modelVersion.releaseGraph.grader.contentHash,
    trainingTelemetrySha256:
      modelRun.receipt.telemetry?.contentHash ?? groupedReceiptHash,
  };
}

function metadataHash(artifact: TrainingArtifact, key: string): string | null {
  const value = artifact.metadata[key];
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : null;
}

function portableEngineRevision(
  job: NonNullable<Awaited<ReturnType<SqliteStore["getTrainingJob"]>>>
): string {
  const bindings = objectValue(job.metadata.portableAdapterBindings);
  const engine = objectValue(bindings.engine);
  const revision = engine.upstreamRevision;
  if (typeof revision !== "string" || !revision.trim()) {
    throw new Error(
      "OpenPond training publication requires its portable engine revision."
    );
  }
  return revision;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
