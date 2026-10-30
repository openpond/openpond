import { z } from "zod";
import type { TrainingJob } from "openpond-sdk/training";

const CleanupAttestation = z.object({
  attestedAt: z.string().datetime(),
  receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  activeClaims: z.number().int().nonnegative(),
  liveSandboxes: z.number().int().nonnegative(),
  activeCapabilities: z.number().int().nonnegative(),
  activeReservations: z.number().int().nonnegative(),
  liveProviderStorage: z.number().int().nonnegative(),
  liveProviderWorkers: z.number().int().nonnegative(),
});
const Inspection = z.object({ job: z.object({
  job: z.object({
    id: z.string(), teamId: z.string(), version: z.number().int(),
    targetGroups: z.literal(0), completedGroups: z.literal(0),
    optimizerUpdatesApplied: z.literal(0), optimizerUpdatesSkipped: z.literal(0),
    currentPolicyVersion: z.number().int().nonnegative(),
    canonicalPublishState: z.literal("skipped"), publicSubmission: z.null(),
    cleanupAttestation: CleanupAttestation.nullable(),
  }),
  resources: z.array(z.object({ kind: z.string(), externalId: z.string(), metadata: z.unknown() })),
  trainingSteps: z.array(z.unknown()).length(0),
  rolloutGroups: z.array(z.unknown()).length(0),
  checkpoints: z.array(z.unknown()).length(0),
  artifacts: z.array(z.unknown()).length(0),
}) });
const ServingSource = z.object({
  mode: z.enum(["load_test", "frozen_evaluation"]),
  target: z.enum(["base_model", "checkpoint"]),
  sourceJobId: z.string().min(1), checkpointId: z.string().min(1),
  policyVersion: z.number().int().nonnegative(),
  adapterSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  artifact: z.object({ id: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  retainedCheckpoint: z.object({
    schemaVersion: z.literal("openpond.retainedSupervisedCheckpoint.v1"),
    sourceJobId: z.string().min(1), sourceJobVersion: z.number().int().positive(),
    sourceInputManifestSha256: z.string().regex(/^[a-f0-9]{64}$/), checkpointId: z.string().min(1), policyVersion: z.literal(1),
    checkpointReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/), optimizerEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    inventorySha256: z.string().regex(/^[a-f0-9]{64}$/), adapterSha256: z.string().regex(/^[a-f0-9]{64}$/), resumeSha256: z.string().regex(/^[a-f0-9]{64}$/), receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  evaluationPanel: z.object({
    schemaVersion: z.literal("openpond.frozenEvaluationPanel.v1"),
    sourceManifest: z.object({ id: z.string(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }),
    sourceTaskset: z.object({ id: z.string(), revision: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }),
    populationSha256: z.string().regex(/^[a-f0-9]{64}$/), populationCount: z.number().int().positive(),
    shardIndex: z.number().int().nonnegative(), shardSize: z.number().int().positive(), shardCount: z.number().int().positive(),
    selectedTasksSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  derivedBackbone: z.object({
    planSha256: z.string().regex(/^[a-f0-9]{64}$/),
    plan: z.object({ deltas: z.array(z.object({
      sourceJobId: z.string().min(1), checkpointId: z.string().min(1),
      artifact: z.object({ id: z.string().min(1), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }),
    })).min(1).max(16) }),
  }).optional(),
});

/** Project only serving identity and custody from the authenticated owner read.
 * Never copy native inputs, prompts, artifact contents, or provider metadata. */
export function parseHostedServingReportEvidence(value: unknown, expected: Pick<TrainingJob, "id" | "teamId">) {
  const { job, resources } = Inspection.parse(value).job;
  if (job.id !== expected.id || job.teamId !== expected.teamId) {
    throw new Error("Hosted serving report evidence belongs to a different job or workspace.");
  }
  const resource = resources.find(row => row.kind === "worker_command" && row.externalId === "serving-soak-source");
  const source = ServingSource.parse(resource?.metadata);
  const lastDelta = source.derivedBackbone?.plan.deltas.at(-1);
  const mergedIdentityMatches = source.mode === "frozen_evaluation" && source.target === "checkpoint" &&
    source.policyVersion > 0 && source.adapterSha256 === null && lastDelta !== undefined &&
    lastDelta.sourceJobId === source.sourceJobId && lastDelta.checkpointId === source.checkpointId &&
    lastDelta.artifact.id === source.artifact?.id && lastDelta.artifact.contentHash === source.artifact?.contentHash;
  const retained = source.retainedCheckpoint;
  if (retained && (source.mode !== "frozen_evaluation" || source.artifact || source.derivedBackbone ||
      retained.sourceJobId !== source.sourceJobId || retained.checkpointId !== source.checkpointId ||
      (source.target === "checkpoint" && (retained.policyVersion !== source.policyVersion || retained.adapterSha256 !== source.adapterSha256)))) {
    throw new Error("Hosted serving report retained checkpoint identity mismatch.");
  }
  if (source.policyVersion !== job.currentPolicyVersion ||
      (source.derivedBackbone ? !mergedIdentityMatches :
        source.mode === "frozen_evaluation" && (source.target === "base_model"
          ? source.policyVersion !== 0 || source.adapterSha256 !== null
          : !source.adapterSha256))) {
    throw new Error("Hosted serving report checkpoint identity mismatch.");
  }
  const custody = job.cleanupAttestation;
  const cleanupComplete = custody === null ? null : [
    custody.activeClaims, custody.liveSandboxes, custody.activeCapabilities,
    custody.activeReservations, custody.liveProviderStorage, custody.liveProviderWorkers,
  ].every(count => count === 0);
  // The owner read validates the complete ordered plan. Report its identity only;
  // storage references and adapter inventories stay out of this projection.
  const { derivedBackbone, ...identity } = source;
  const servingIdentity = { ...identity,
    representation: derivedBackbone ? "merged_backbone" as const : source.target === "base_model" ? "base_model" as const : "adapter" as const,
    ...(derivedBackbone ? { backbonePlanSha256: derivedBackbone.planSha256 } : {}),
  };
  return { jobId: job.id, teamId: job.teamId, executionMode: source.mode, source: servingIdentity, nativeJobVersion: job.version,
    cleanupAttestation: custody, cleanupComplete };
}

export type HostedServingReportEvidence = ReturnType<typeof parseHostedServingReportEvidence>;
