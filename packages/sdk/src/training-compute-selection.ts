import { z } from "zod";
import { canonicalJson, canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(191);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const OpaqueProvider = z.string().min(1).max(191).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const TrainingGpuSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic"), objective: z.enum(["balanced", "fast", "economical"]), gpuCount: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
  z.object({ mode: z.literal("manual"), availabilityId: Id, gpuType: z.string().trim().min(1).max(256), gpuCount: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
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

/** A live catalog query is an eligibility read, never a training approval. */
export const TrainingGpuCatalogQuerySchema = z.object({
  teamId: Id,
  modelId: z.string().trim().min(1).max(256),
  modelRevision: z.string().trim().min(1).max(256),
  tokenizerRevision: z.string().trim().min(1).max(256),
  chatTemplateHash: Hash,
  method: z.enum(["sft", "grpo"]),
  loraRank: z.number().int().min(1).max(256),
  gpuCount: z.union([z.literal(1), z.literal(2)]),
}).strict();
export type TrainingGpuCatalogQuery = z.infer<typeof TrainingGpuCatalogQuerySchema>;

export const TrainingGpuCatalogScopeSchema = z.object({
  query: TrainingGpuCatalogQuerySchema,
  requestHash: Hash,
  qualification: z.enum(["requires_preparation", "unsupported"]),
  reason: z.enum(["model_not_supported", "lora_rank_not_supported", "gpu_count_not_qualified", "provider_not_supported"]).nullable(),
  provider: z.object({
    accountScopeId: Id,
    product: z.literal("POD"), cloud: z.literal("SECURE"),
    countryCodes: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(300),
    cudaVersions: z.array(z.string().regex(/^\d+\.\d+$/)).min(1).max(100),
    dataCenterId: Id.nullable(),
    minimumDiskGb: z.number().int().positive(),
    priceBasis: z.literal("provider_catalog_per_gpu_rate_times_count"),
  }).strict().nullable(),
}).strict();
export type TrainingGpuCatalogScope = z.infer<typeof TrainingGpuCatalogScopeSchema>;

export const TrainingGpuCatalogSchema = z.object({
  schemaVersion: z.literal("openpond.trainingGpuCatalog.v1"),
  observedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  supportedLoraRanks: z.array(z.number().int().positive()),
  pricingBasis: z.enum(["accepted_compute_and_disk_hourly_before_credits", "provider_catalog_compute_and_disk_before_credits"]),
  scope: TrainingGpuCatalogScopeSchema.optional(),
  offerings: z.array(z.object({
    availabilityId: Id, gpuType: z.string().min(1).max(256), provider: OpaqueProvider,
    region: z.string().min(1), dataCenterId: z.string().nullable(),
    gpuCount: z.number().int().positive(), gpuMemoryGb: z.number().positive(),
    stockStatus: z.enum(["High", "Medium", "Low"]),
    /** Whole-allocation retail rate, including attached disk. Null means unpriced.
     * The catalog breakdown below describes provider selection costs only. */
    hourlyUsd: z.number().finite().nonnegative().nullable(),
    computeHourlyUsd: z.number().nonnegative(), diskHourlyUsd: z.number().nonnegative(), totalHourlyUsd: z.number().nonnegative(),
  }).strict()).max(1000),
}).strict();
export type TrainingGpuCatalog = z.infer<typeof TrainingGpuCatalogSchema>;

export async function parseAndVerifyTrainingGpuCatalog(raw: unknown, query?: TrainingGpuCatalogQuery) {
  const catalog = TrainingGpuCatalogSchema.parse(raw);
  if (Date.parse(catalog.expiresAt) <= Date.parse(catalog.observedAt) ||
      Date.parse(catalog.expiresAt) <= Date.now())
    throw new OpenPondProtocolError("training_gpu_catalog_expired", "Refresh GPU availability before reviewing this run.");
  if (!query) {
    if (catalog.scope) throw new OpenPondProtocolError("training_gpu_catalog_scope_mismatch", "An overview read returned an unrequested workload.");
    return catalog;
  }
  const scope = catalog.scope;
  if (!scope || catalog.pricingBasis !== "provider_catalog_compute_and_disk_before_credits" ||
      canonicalJson(scope.query) !== canonicalJson(query) ||
      scope.requestHash !== await canonicalSha256(query) ||
      (scope.qualification === "unsupported") !== (scope.reason !== null) ||
      (scope.qualification === "unsupported" ? scope.provider !== null || catalog.offerings.length > 0 : !scope.provider) ||
      new Set(catalog.offerings.map(item => item.provider)).size > 1 ||
      catalog.offerings.some(item => item.gpuCount !== query.gpuCount ||
        item.dataCenterId !== scope.provider?.dataCenterId) ||
      new Set(catalog.offerings.map(item => item.availabilityId)).size !== catalog.offerings.length)
    throw new OpenPondProtocolError("training_gpu_catalog_scope_mismatch", "The GPU offers do not match this workspace and workload.");
  return catalog;
}

export function createTrainingGpuCatalogClient(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async gpuCatalog(raw?: TrainingGpuCatalogQuery) {
      const query = raw === undefined ? undefined : TrainingGpuCatalogQuerySchema.parse(raw);
      const params = query ? new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])) : null;
      const response = await request(`/v1/training/gpu-catalog${params ? `?${params}` : ""}`);
      const value = response && typeof response === "object" && "catalog" in response ? response.catalog : response;
      return parseAndVerifyTrainingGpuCatalog(value, query);
    },
  };
}
