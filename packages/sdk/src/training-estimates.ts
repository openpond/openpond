import { z } from "zod";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import { TrainingJobSubmissionSchema, parseAndVerifyTrainingJobSubmission } from "./training.js";
import { TrainingGpuSelectionSchema, TrainingEstimateReviewSchema } from "./training-compute-selection.js";
export { TrainingGpuSelectionSchema, TrainingEstimateReviewSchema,
  type TrainingGpuSelection, type TrainingEstimateReview } from "./training-compute-selection.js";

const Id = z.string().trim().min(1).max(191);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.string().datetime({ offset: true });
const NonNegative = z.number().finite().nonnegative();

/** Hardware choice and allocation sharing are independent decisions. An exact
 * offering is never silently replaced with a different GPU when stock changes. */
export const TrainingEstimateSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preparation"), id: Id, planHash: Hash, expectedRevision: z.number().int().positive() }).strict(),
  z.object({
    kind: z.literal("configuration"), id: Id,
    expectedRevision: z.number().int().positive(), expectedEtag: Hash,
    batch: ModelProjectVersionedRefSchema.nullable().default(null),
  }).strict(),
  z.object({ kind: z.literal("submission"), submission: z.lazy(() => TrainingJobSubmissionSchema) }).strict(),
]);

/** An estimate has no approval flag or required spend cap. Existing prepared
 * submissions may carry their original cap, which this operation cannot raise. */
export const TrainingEstimateRequestSchema = z.object({
  schemaVersion: z.literal("openpond.trainingEstimateRequest.v1"),
  teamId: Id,
  source: TrainingEstimateSourceSchema,
  gpuSelection: TrainingGpuSelectionSchema.optional(),
}).strict();

const PlanningRange = z.object({ low: NonNegative, high: NonNegative }).strict()
  .refine(value => value.high >= value.low, "Planning range must be ordered");

export const TrainingEstimateComponentSchema = z.object({
  phase: z.enum([
    "startup", "baseline_evaluation", "rollouts", "optimization", "checkpointing",
    "backbone_materialization", "final_evaluation", "publication", "cleanup", "retention",
  ]),
  resource: z.enum(["gpu", "cpu", "judge", "storage", "network"]),
  expectedUsd: NonNegative.nullable(),
  expectedSeconds: NonNegative.nullable(),
  planningRangeUsd: PlanningRange.nullable(),
  evidence: z.enum(["measured", "configured_rate", "unavailable"]),
  reason: z.string().trim().min(1).max(1000).nullable(),
}).strict();

/** A signed review binds the exact workload/price identity. It reserves neither
 * capacity nor money, and submission still checks funding and current pricing. */
export function trainingEstimateSourceIdentity(source: z.infer<typeof TrainingEstimateSourceSchema>) {
  if (source.kind === "submission") return {
    kind: source.kind, id: source.submission.idempotencyKey, contentHash: source.submission.contentHash, revision: null,
  };
  if (source.kind === "preparation") return {
    kind: source.kind, id: source.id, contentHash: source.planHash, revision: source.expectedRevision,
  };
  return { kind: source.kind, id: source.id, contentHash: source.expectedEtag, revision: source.expectedRevision };
}

export const TrainingEstimateSchema = z.object({
  schemaVersion: z.literal("openpond.trainingEstimate.v1"),
  id: Id,
  teamId: Id,
  requestHash: Hash,
  inputHash: Hash,
  source: z.object({
    kind: z.enum(["preparation", "configuration", "submission"]), id: Id,
    contentHash: Hash, revision: z.number().int().positive().nullable(),
  }).strict(),
  status: z.enum(["available", "partial", "insufficient_evidence"]),
  currency: z.literal("USD"),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  estimatorVersion: Id,
  runtimeVersion: Id,
  pricing: z.object({ version: Id, quoteExpiresAt: Timestamp.nullable() }).strict(),
  gpu: z.object({
    requested: TrainingGpuSelectionSchema,
    resolved: z.object({ availabilityId: Id, gpuType: z.string().min(1).max(256), gpuCount: z.literal(1) }).strict().nullable(),
    customerHourlyUsd: NonNegative.nullable(),
    availability: z.enum(["available", "limited", "unavailable", "unknown"]),
  }).strict(),
  configuration: z.object({
    modelId: Id,
    modelRevision: z.string().min(1).max(256),
    method: Id,
    loraRank: z.number().int().positive().nullable(),
    adapterMode: z.enum(["residual_append", "shared", "sequential_merge"]).nullable(),
    groups: z.number().int().nonnegative().nullable(),
    rolloutConcurrency: z.number().int().positive().nullable(),
    maxOutputTokens: z.number().int().positive().nullable(),
    trainingRows: z.number().int().nonnegative().nullable(),
    evaluationRows: z.number().int().nonnegative().nullable(),
    retentionDays: z.number().int().positive().nullable(),
    approvedMaximumUsd: NonNegative.nullable(),
  }).strict(),
  cost: z.object({
    expectedUsd: NonNegative.nullable(),
    planningRangeUsd: PlanningRange.nullable(),
    knownMinimumUsd: NonNegative,
    recommendedMaximumUsd: NonNegative.nullable(),
    minimumCleanupReserveUsd: NonNegative.nullable(),
    components: z.array(TrainingEstimateComponentSchema).max(50),
  }).strict(),
  executionSeconds: z.object({ expected: NonNegative.nullable(), planningRange: PlanningRange.nullable() }).strict(),
  queueWaitSeconds: z.object({ expected: NonNegative, planningRange: PlanningRange.nullable() }).strict().nullable(),
  calibration: z.object({
    version: Id,
    cohortHash: Hash,
    completedSamples: z.number().int().nonnegative(),
    partialSamples: z.number().int().nonnegative(),
    scope: z.enum(["workspace", "authorized_aggregate"]),
  }).strict(),
  assumptions: z.array(z.string().trim().min(1).max(1000)).max(50),
  unknowns: z.array(z.string().trim().min(1).max(1000)).max(50),
  review: TrainingEstimateReviewSchema,
}).strict().superRefine((estimate, context) => {
  if (estimate.review.estimateId !== estimate.id || estimate.review.inputHash !== estimate.inputHash ||
      estimate.review.requestHash !== estimate.requestHash || estimate.review.pricingVersion !== estimate.pricing.version ||
      estimate.review.expiresAt !== estimate.expiresAt) {
    context.addIssue({ code: "custom", path: ["review"], message: "Estimate review identity differs from the estimate" });
  }
  if (Date.parse(estimate.expiresAt) <= Date.parse(estimate.createdAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Estimate must expire after its creation" });
  }
  if (estimate.status === "available" &&
      (estimate.cost.expectedUsd === null || estimate.executionSeconds.expected === null || estimate.unknowns.length > 0)) {
    context.addIssue({ code: "custom", path: ["status"], message: "An available estimate requires complete cost and duration coverage" });
  }
  if (estimate.gpu.requested.mode === "manual" && estimate.gpu.resolved &&
      (estimate.gpu.requested.availabilityId !== estimate.gpu.resolved.availabilityId ||
       estimate.gpu.requested.gpuType !== estimate.gpu.resolved.gpuType)) {
    context.addIssue({ code: "custom", path: ["gpu"], message: "An explicit GPU offering cannot be substituted" });
  }
});

export type TrainingEstimateRequest = z.infer<typeof TrainingEstimateRequestSchema>;
export type TrainingEstimate = z.infer<typeof TrainingEstimateSchema>;

export function createTrainingEstimateClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async estimate(input: TrainingEstimateRequest): Promise<TrainingEstimate> {
      const parsed = TrainingEstimateRequestSchema.parse(input);
      if (parsed.source.kind === "submission") await parseAndVerifyTrainingJobSubmission(parsed.source.submission);
      const result = TrainingEstimateSchema.parse(await request("/v1/training/estimates", {
        method: "POST", body: JSON.stringify(parsed),
      }));
      if (result.teamId !== parsed.teamId || result.requestHash !== await canonicalSha256(parsed) ||
          await canonicalSha256(result.source) !== await canonicalSha256(trainingEstimateSourceIdentity(parsed.source)) ||
          (parsed.gpuSelection && await canonicalSha256(result.gpu.requested) !== await canonicalSha256(parsed.gpuSelection))) {
        throw new OpenPondProtocolError("training_estimate_scope_mismatch", "The estimate does not match the requested workspace and exact configuration.");
      }
      return result;
    },
  };
}
