import { z } from "zod";

const Id = z.string().trim().min(1).max(191);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const TrainingGpuSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic"), objective: z.enum(["balanced", "fast", "economical"]) }).strict(),
  z.object({ mode: z.literal("manual"), availabilityId: Id, gpuType: z.string().trim().min(1).max(256) }).strict(),
]);

/** This token binds a reviewed workload and price, without reserving resources
 * or approving the estimate's recommended budget. */
export const TrainingEstimateReviewSchema = z.object({
  estimateId: Id,
  inputHash: Hash,
  requestHash: Hash,
  pricingVersion: Id,
  expiresAt: z.string().datetime({ offset: true }),
  token: z.string().min(1).max(8192),
}).strict();

export type TrainingGpuSelection = z.infer<typeof TrainingGpuSelectionSchema>;
export type TrainingEstimateReview = z.infer<typeof TrainingEstimateReviewSchema>;

export const TrainingGpuCatalogSchema = z.object({
  schemaVersion: z.literal("openpond.trainingGpuCatalog.v1"),
  observedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  supportedLoraRanks: z.array(z.number().int().positive()),
  pricingBasis: z.literal("accepted_compute_and_disk_hourly_before_credits"),
  offerings: z.array(z.object({
    availabilityId: Id, gpuType: z.string().min(1).max(256), provider: Id,
    region: z.string().min(1), dataCenterId: z.string().nullable(),
    gpuCount: z.number().int().positive(), gpuMemoryGb: z.number().positive(),
    stockStatus: z.enum(["High", "Medium", "Low"]),
    computeHourlyUsd: z.number().nonnegative(), diskHourlyUsd: z.number().nonnegative(), totalHourlyUsd: z.number().nonnegative(),
  }).strict()).max(1000),
}).strict();
export type TrainingGpuCatalog = z.infer<typeof TrainingGpuCatalogSchema>;
