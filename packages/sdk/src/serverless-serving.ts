import { z } from "zod";
import { ComputeAppliedPriceSchema } from "./managed-compute-price.js";
import { canonicalComputeSpendCap } from "./managed-compute-price.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Money = z.string().regex(/^(0|[1-9]\d*)\.\d{6}$/).max(24);
const Timestamp = z.iso.datetime();

export const SERVERLESS_SERVING_IDLE_SECONDS = 5;
export const SERVERLESS_SERVING_REQUEST_MILLIS = 540_000;
export const SERVERLESS_SERVING_QUEUE_MILLIS = 60_000;
export const SERVERLESS_SERVING_METER_LEASE_MILLIS = 15_000;

/** Portable commercial terms. Supplier resources and account custody stay private. */
const ServerlessServingReviewIdentitySchema = z.object({
  teamId: Id,
  modelProjectId: Id,
  versionHash: Hash,
  artifact: z.object({ id: Id, contentHash: Hash }).strict(),
  baseProfileId: Id,
  workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  providerConfigurationHash: Hash,
  price: ComputeAppliedPriceSchema.extend({ service: z.literal("model_serving") }),
  workerIdleTimeoutSeconds: z.literal(SERVERLESS_SERVING_IDLE_SECONDS),
  maximumRequestMillis: z.literal(SERVERLESS_SERVING_REQUEST_MILLIS),
  expiresAt: Timestamp,
  contentHash: Hash,
}).strict();
/** Historical engine-only terms retain their original signed meaning. */
export const ServerlessServingReviewV1Schema = ServerlessServingReviewIdentitySchema.extend({
  schemaVersion: z.literal("openpond.serverlessServingReview.v1"),
  rules: z.object({
    quantity: z.literal("allocated_engine_milliseconds"),
    allocation: z.literal("equal_billing_principal_then_request"),
    startupBillable: z.literal(false),
    idleBillable: z.literal(false),
    queueBillable: z.literal(false),
    failure: z.literal("observed_engine_work"),
    cancellation: z.literal("until_engine_release"),
    tokenRetailUsd: z.literal("0.000000"),
    minimumBillableMillis: z.literal(0),
  }).strict(),
}).strict();

export const ServerlessServingReviewV2Schema = ServerlessServingReviewIdentitySchema.extend({
  schemaVersion: z.literal("openpond.serverlessServingReview.v2"),
  rules: z.object({
    quantity: z.literal("allocated_worker_milliseconds"),
    allocation: z.literal("equal_billing_principal_then_request"),
    startupBillable: z.literal(true),
    idleBillable: z.literal(true),
    cleanupBillable: z.literal(true),
    queueBillable: z.literal(false),
    failure: z.literal("observed_worker_runtime"),
    cancellation: z.literal("until_worker_stop"),
    tokenRetailUsd: z.literal("0.000000"),
    minimumBillableMillis: z.literal(0),
    supplierRounding: z.literal("ceil_worker_lifetime_second_once"),
  }).strict(),
}).strict();
/** Current serving review. */
export const ServerlessServingReviewV3Schema = ServerlessServingReviewV2Schema.extend({
  schemaVersion: z.literal("openpond.serverlessServingReview.v3"),
  /** Newly issued reviews expose the approved hardware set. Historical signed
   * reviews remain valid with their original content hash. */
  hardware: z.object({
    selection: z.literal("automatic"),
    gpuTypeIds: z.array(Id).min(1).max(8).refine(ids => new Set(ids).size === ids.length),
  }).strict().optional(),
}).strict();
export const ServerlessServingReviewSchema = z.discriminatedUnion("schemaVersion", [
  ServerlessServingReviewV1Schema, ServerlessServingReviewV2Schema, ServerlessServingReviewV3Schema,
]);
export type ServerlessServingReview = z.infer<typeof ServerlessServingReviewSchema>;

export const ServerlessServingApprovalSchema = z.object({
  schemaVersion: z.literal("openpond.serverlessServingApproval.v1"),
  reviewHash: Hash,
  customerCapUsd: Money.refine(value => Number(value) > 0).nullable(),
  gpuTypeId: Id.optional(),
}).strict();
export type ServerlessServingApproval = z.infer<typeof ServerlessServingApprovalSchema>;

export const ServerlessServingUsageSchema = z.object({
  mode: z.literal("periodic_actual_usage"),
  phase: z.enum(["starting", "running", "stopping", "closed", "waiting_capacity", "waiting_funding", "waiting_platform"]),
  ratedUsd: Money,
  chargedUsd: Money,
  prepaidDebitedUsd: Money,
  includedUsageUsd: Money,
  pendingEvidence: z.boolean(),
  lastEvidenceAt: Timestamp.nullable(),
  lastDebitAt: Timestamp.nullable(),
  nextDebitAt: Timestamp.nullable(),
  retryAt: Timestamp.nullable().optional(),
  stopReason: z.string().nullable(),
}).strict();
export type ServerlessServingUsage = z.infer<typeof ServerlessServingUsageSchema>;

export const ServerlessServingSnapshotSchema = z.object({
  schemaVersion: z.literal("openpond.serverlessServing.v1"),
  ownerKey: Id,
  review: ServerlessServingReviewSchema,
  customerCapUsd: Money.nullable(),
  state: z.enum(["active", "stopping", "closed"]),
  quantityMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  chargedUsd: Money,
  reservedUsd: Money,
  supplierCostStatus: z.enum(["pending", "reconciled"]),
    usage: ServerlessServingUsageSchema.optional(),
}).strict();
export type ServerlessServingSnapshot = z.infer<typeof ServerlessServingSnapshotSchema>;

/** Accepted reviews remain verifiable after expiry, including Stop receipts. */
export async function verifyServerlessServingReview(raw: ServerlessServingReview, expected: {
  teamId: string; modelProjectId: string; versionHash: string;
  artifact?: {id: string; contentHash: string};
}) {
  const review = ServerlessServingReviewSchema.parse(raw), {contentHash, ...content} = review;
  if (contentHash !== await canonicalSha256(content) || review.teamId !== expected.teamId ||
    review.modelProjectId !== expected.modelProjectId || review.versionHash !== expected.versionHash ||
    review.artifact.id !== expected.artifact?.id || review.artifact.contentHash !== expected.artifact?.contentHash)
    throw new OpenPondProtocolError("serverless_serving_review_mismatch", "Serving terms differ from this accepted saved Model.");
  return review;
}

export async function createServerlessServingApproval(raw: ServerlessServingReview, spendingLimit?: string | null, gpuTypeId?: string) {
  const review = ServerlessServingReviewSchema.parse(raw), {contentHash, ...content} = review;
  if (review.schemaVersion !== "openpond.serverlessServingReview.v3" ||
    contentHash !== await canonicalSha256(content) || Date.parse(review.expiresAt) <= Date.now())
    throw new OpenPondProtocolError("serverless_serving_review_expired", "Refresh this saved Model's serving price.");
  if (gpuTypeId && !review.hardware?.gpuTypeIds.includes(gpuTypeId))
    throw new OpenPondProtocolError("serverless_serving_gpu_unavailable", "Choose a GPU from this Model's current serving offering.");
  return ServerlessServingApprovalSchema.parse({schemaVersion: "openpond.serverlessServingApproval.v1",
    reviewHash: contentHash, customerCapUsd: canonicalComputeSpendCap(spendingLimit), ...(gpuTypeId ? { gpuTypeId } : {})});
}
