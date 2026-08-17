import { z } from "zod";

import {
  ImmutableArtifactRefSchema,
  ImmutableAssetRefSchema,
  ImmutableReleaseRefSchema,
  MetadataSchema,
  ReleaseHashSchema,
  ReleaseIdSchema,
  ReleaseTimestampSchema,
} from "@openpond/harness";

import { EnvironmentContractSchema, GraderSpecSchema } from "./tasksets.js";

export const ScoringStatusSchema = z.enum(["scored", "unscorable"]);
export const FailureOwnerSchema = z.enum([
  "policy",
  "environment",
  "collector",
  "verifier",
  "provider",
  "host",
  "user",
  "scheduler",
]);
export const AttemptOutcomeClassSchema = z.enum([
  "completed",
  "policy_failure",
  "incomplete_output",
  "task_deadline",
  "environment_failure",
  "collector_failure",
  "verifier_failure",
  "provider_failure",
  "host_failure",
  "infrastructure_timeout",
  "cancelled",
]);

export const EnvironmentReleaseContentSchema = z.object({
  schemaVersion: z.literal("openpond.environmentRelease.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  contract: EnvironmentContractSchema,
  actionSchemaRef: ImmutableAssetRefSchema.nullable(),
  observationSchemaRef: ImmutableAssetRefSchema.nullable(),
  stateSchemaRef: ImmutableAssetRefSchema.nullable(),
  artifactCollection: z.object({
    maxArtifacts: z.number().int().positive().max(100_000),
    maxTotalBytes: z.number().int().positive().max(10_000_000_000),
  }).strict(),
  adapterConformanceHashes: z.record(ReleaseIdSchema, ReleaseHashSchema),
  metadata: MetadataSchema,
}).strict();
export const EnvironmentReleaseSchema = EnvironmentReleaseContentSchema
  .extend({ contentHash: ReleaseHashSchema })
  .strict();

export const ArtifactCollectionStatusSchema = z.enum([
  "collected",
  "missing",
  "skipped",
  "failed",
]);
export const ArtifactValidationStatusSchema = z.enum([
  "not_requested",
  "passed",
  "failed",
]);
export const ArtifactManifestEntrySchema = z.object({
  requiredOutputPath: z.string().trim().min(1).max(2_000).nullable(),
  collectedPath: z.string().trim().min(1).max(4_000).nullable(),
  declaredMediaType: z.string().trim().min(1).max(200).nullable(),
  detectedMediaType: z.string().trim().min(1).max(200).nullable(),
  artifact: ImmutableArtifactRefSchema.nullable(),
  status: ArtifactCollectionStatusSchema,
  parseStatus: ArtifactValidationStatusSchema,
  schemaStatus: ArtifactValidationStatusSchema,
  errorCode: ReleaseIdSchema.nullable(),
  failureOwner: FailureOwnerSchema.nullable(),
  evidenceRefs: z.array(ImmutableArtifactRefSchema).max(10_000),
  metadata: MetadataSchema,
}).strict();
export const ArtifactManifestContentSchema = z.object({
  schemaVersion: z.literal("openpond.artifactManifest.v1"),
  id: ReleaseIdSchema,
  attemptRef: ImmutableReleaseRefSchema,
  entries: z.array(ArtifactManifestEntrySchema).max(100_000),
  createdAt: ReleaseTimestampSchema,
  metadata: MetadataSchema,
}).strict();
export const ArtifactManifestSchema = ArtifactManifestContentSchema
  .extend({ contentHash: ReleaseHashSchema })
  .strict();

export const VerifierSetReleaseContentSchema = z.object({
  schemaVersion: z.literal("openpond.verifierSetRelease.v1"),
  id: ReleaseIdSchema,
  revision: z.number().int().positive(),
  graders: z.array(GraderSpecSchema).min(1).max(1_000),
  isolation: z.object({
    processBoundary: z.enum(["same_process", "isolated_process", "container"]),
    networkPolicy: z.literal("none"),
    defaultTimeoutMs: z.number().int().positive().max(300_000),
  }).strict(),
  calibrationReceiptRefs: z.array(ImmutableReleaseRefSchema).max(10_000),
  metadata: MetadataSchema,
}).strict();
export const VerifierSetReleaseSchema = VerifierSetReleaseContentSchema
  .extend({ contentHash: ReleaseHashSchema })
  .strict();

export const RewardComponentReceiptSchema = z.object({
  verifierId: ReleaseIdSchema,
  verifierVersion: z.string().trim().min(1).max(100),
  status: ScoringStatusSchema,
  rawScore: z.number().finite().nullable(),
  normalizedScore: z.number().min(0).max(1).nullable(),
  weight: z.number().nonnegative().max(1_000),
  passed: z.boolean(),
  hardGate: z.boolean(),
  rewardEligible: z.boolean(),
  rewardContribution: z.number().min(0).max(1).nullable(),
  failureOwner: FailureOwnerSchema.nullable(),
  feedback: z.array(z.string().max(20_000)).max(1_000),
  visibleEvidenceRefs: z.array(ImmutableArtifactRefSchema).max(10_000),
  privilegedEvidenceRefs: z.array(ImmutableArtifactRefSchema).max(10_000),
  metadata: MetadataSchema,
}).strict().superRefine((component, context) => {
  if (component.status === "scored" && component.normalizedScore === null) {
    context.addIssue({ code: "custom", message: "A scored component requires a normalized score.", path: ["normalizedScore"] });
  }
  if (component.status === "unscorable" && (component.normalizedScore !== null || component.rewardEligible)) {
    context.addIssue({ code: "custom", message: "An unscorable component cannot contribute reward.", path: ["status"] });
  }
});

const RewardReceiptBaseSchema = z.object({
  schemaVersion: z.literal("openpond.rewardReceipt.v1"),
  id: ReleaseIdSchema,
  attemptRef: ImmutableReleaseRefSchema,
  verifierSetRef: ImmutableReleaseRefSchema,
  artifactManifestRef: ImmutableReleaseRefSchema,
  status: ScoringStatusSchema,
  reward: z.number().min(0).max(1).nullable(),
  learningEligible: z.boolean(),
  passed: z.boolean(),
  outcomeClass: AttemptOutcomeClassSchema,
  failureOwner: FailureOwnerSchema.nullable(),
  components: z.array(RewardComponentReceiptSchema).min(1).max(10_000),
  visibleEvidenceRefs: z.array(ImmutableArtifactRefSchema).max(100_000),
  privilegedEvidenceRefs: z.array(ImmutableArtifactRefSchema).max(100_000),
  supersedes: ImmutableReleaseRefSchema.nullable(),
  createdAt: ReleaseTimestampSchema,
  metadata: MetadataSchema,
}).strict();

function validateRewardReceipt(
  receipt: z.infer<typeof RewardReceiptBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (receipt.status === "scored" && (receipt.reward === null || !receipt.learningEligible)) {
    context.addIssue({ code: "custom", message: "A scored receipt requires a reward and is learning-eligible.", path: ["status"] });
  }
  if (receipt.status === "unscorable" && (receipt.reward !== null || receipt.learningEligible)) {
    context.addIssue({ code: "custom", message: "An unscorable receipt has null reward and is not learning-eligible.", path: ["status"] });
  }
}

export const RewardReceiptContentSchema = RewardReceiptBaseSchema.superRefine(validateRewardReceipt);
export const RewardReceiptSchema = RewardReceiptBaseSchema
  .extend({ contentHash: ReleaseHashSchema })
  .strict()
  .superRefine(validateRewardReceipt);

export type ScoringStatus = z.infer<typeof ScoringStatusSchema>;
export type FailureOwner = z.infer<typeof FailureOwnerSchema>;
export type AttemptOutcomeClass = z.infer<typeof AttemptOutcomeClassSchema>;
export type EnvironmentRelease = z.infer<typeof EnvironmentReleaseSchema>;
export type ArtifactManifestEntry = z.infer<typeof ArtifactManifestEntrySchema>;
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
export type VerifierSetRelease = z.infer<typeof VerifierSetReleaseSchema>;
export type RewardComponentReceipt = z.infer<typeof RewardComponentReceiptSchema>;
export type RewardReceipt = z.infer<typeof RewardReceiptSchema>;
