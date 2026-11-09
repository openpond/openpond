import { z } from "zod";
import { ComputeAppliedPriceSchema, canonicalComputeSpendCap } from "./managed-compute-price.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

function computeUsdMicros(value: string): number {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value) || value.length > 24)
    throw new Error("invalid_compute_amount");
  const [whole, fraction = ""] = value.split(".");
  const micros = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid_compute_amount");
  return Number(micros);
}
function normalizedComputeUsd(value: string): string {
  const micros = BigInt(computeUsdMicros(value));
  return `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0")}`;
}

const Id = z.string().trim().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Image = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Timestamp = z.iso
  .datetime()
  .refine((value) => new Date(value).toISOString() === value);
const Money = z.string().regex(/^(0|[1-9]\d*)\.\d{6}$/).max(24).refine((value) => {
  try {
    return normalizedComputeUsd(value) === value;
  } catch {
    return false;
  }
});
export const ManagedServingUsageMethodSchema = z.enum([
  "training",
  "steering",
  "engram",
  "decision",
  "alphaedit",
  "selective_neuron_training",
  "weight_space_programming",
]);
export type ManagedServingUsageMethod = z.infer<
  typeof ManagedServingUsageMethodSchema
>;
export const ManagedServingUsagePriceSchema = ComputeAppliedPriceSchema.extend({
  service: z.literal("model_serving"),
});

/** Portable review. Provider account, Pod identity and allocation credentials
 * remain in the private physical owner, never in customer approval documents. */
export const ManagedServingUsageReviewSchema = z
  .object({
    schemaVersion: z.literal("openpond.managedServingUsageReview.v1"),
    teamId: Id,
    modelProjectId: Id,
    versionHash: Hash,
    method: ManagedServingUsageMethodSchema,
    price: ManagedServingUsagePriceSchema,
    runtimeHash: Hash,
    workerImageDigest: Image,
    providerConfigurationHash: Hash,
    idleTimeoutSeconds: z.literal(300),
    rules: z
      .object({
        billableStart: z.literal("provider_allocation"),
        startupBillable: z.literal(true),
        idleBillable: z.literal(true),
        explicitStop: z.literal("logical_admission_closed"),
        postTrainingReuseBillable: z.literal(false),
        minimumBillableMillis: z.literal(0),
        tokenRetailUsd: z.literal("0.000000"),
      })
      .strict(),
    nativeControl: z
      .object({
        protocol: z.literal("openpond.workerComputeControl.v1"),
        executionLeaseMillis: z.literal(30000),
        stopHeadroomMillis: z.literal(60000),
        qualificationHash: Hash,
      })
      .strict(),
    workDeadlineAt: Timestamp,
    expiresAt: Timestamp,
    contentHash: Hash,
  })
  .strict();
export type ManagedServingUsageReview = z.infer<
  typeof ManagedServingUsageReviewSchema
>;

/** Omitted usageApproval retains the original token-billed serving contract.
 * The field, when present, is an explicit price/context approval; null cap means
 * available shared credit, while a positive cap limits cumulative retail. */
export const ManagedServingUsageApprovalSchema = z
  .object({
    schemaVersion: z.literal("openpond.managedServingUsageApproval.v1"),
    reviewHash: Hash,
    customerCapUsd: Money.refine(
      (value) => computeUsdMicros(value) > 0,
    ).nullable(),
  })
  .strict();
export type ManagedServingUsageApproval = z.infer<
  typeof ManagedServingUsageApprovalSchema
>;

export const ManagedServingUsageSnapshotSchema = z
  .object({
    schemaVersion: z.literal("openpond.managedServingUsage.v1"),
    deploymentKey: Id,
    reviewHash: Hash,
    price: ManagedServingUsagePriceSchema,
    customerCapUsd: Money.nullable(),
    fundingState: z.enum(["pending", "active", "exhausted", "closed"]),
    stopReason: z
      .enum([
        "explicit_stop",
        "idle_timeout",
        "credit_exhausted",
        "cap_reached",
        "control_expired",
        "policy_changed",
        "member_cap_reached",
        "native_unavailable",
        "work_deadline",
      ])
      .nullable(),
    startedAt: Timestamp.nullable(),
    lastActivityAt: Timestamp.nullable(),
    idleExpiresAt: Timestamp.nullable(),
    billableStoppedAt: Timestamp.nullable(),
    quantityMillis: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    chargedUsd: Money,
    reservationId: Id.nullable(),
  })
  .strict();
export type ManagedServingUsageSnapshot = z.infer<
  typeof ManagedServingUsageSnapshotSchema
>;

export const ManagedServingUsageReviewResultSchema = z
  .object({
    schemaVersion: z.literal("openpond.managedServingUsageReviewResult.v1"),
    availability: z.enum(["reviewable", "unavailable"]),
    reason: Id.nullable(),
    review: ManagedServingUsageReviewSchema.nullable(),
    usage: ManagedServingUsageSnapshotSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.availability === "reviewable") !== (value.review !== null) ||
      (value.availability === "reviewable") !== (value.reason === null)
    )
      ctx.addIssue({
        code: "custom",
        message: "Serving price review availability is inconsistent",
      });
  });

export type ManagedServingUsageReviewResult = z.infer<typeof ManagedServingUsageReviewResultSchema>;

/** Validate nested price context as well as the containing status receipt hash. */
export async function verifyManagedServingUsageBilling(
  value: ManagedServingUsageReviewResult | undefined,
  expected: { teamId: string; modelProjectId: string; versionHash: string; method: ManagedServingUsageMethod },
  control?: { usage?: ManagedServingUsageSnapshot } | null,
) {
  if (!value) return;
  const { review, usage } = ManagedServingUsageReviewResultSchema.parse(value);
  if (await canonicalSha256(usage) !== await canonicalSha256(control?.usage ?? null))
    throw new OpenPondProtocolError("managed_serving_usage_mismatch", "Serving usage differs from the retained deployment owner.");
  if (!review) return;
  const { contentHash, ...content } = review;
  if (contentHash !== await canonicalSha256(content) ||
    review.teamId !== expected.teamId || review.modelProjectId !== expected.modelProjectId ||
    review.versionHash !== expected.versionHash || review.method !== expected.method ||
    Date.parse(review.expiresAt) > Date.parse(review.workDeadlineAt) ||
    usage && (usage.reviewHash !== contentHash || await canonicalSha256(usage.price) !== await canonicalSha256(review.price)))
    throw new OpenPondProtocolError("managed_serving_usage_mismatch", "Serving pricing differs from the exact saved Model, runtime or accepted terms.");
}

/** A successful activation must retain the exact reviewed cap and price owner. */
export function managedServingUsageApprovalMatches(
  request: { action: "activate" | "stop"; usageApproval?: ManagedServingUsageApproval },
  control: { usage?: ManagedServingUsageSnapshot },
) {
  if (request.action === "stop") return true;
  const approved = request.usageApproval, usage = control.usage;
  if (!approved) return usage === undefined;
  return Boolean(usage && usage.reviewHash === approved.reviewHash && usage.customerCapUsd === approved.customerCapUsd);
}

/** Accept a fresh verified price without reserving credit or starting serving. */
export async function createManagedServingUsageApproval(
  rawReview: ManagedServingUsageReview,
  spendingLimit?: string | null,
): Promise<ManagedServingUsageApproval> {
  const review = ManagedServingUsageReviewSchema.parse(rawReview);
  const { contentHash, ...content } = review;
  if (contentHash !== await canonicalSha256(content) || Date.parse(review.expiresAt) <= Date.now() ||
    Date.parse(review.workDeadlineAt) <= Date.now())
    throw new OpenPondProtocolError("managed_serving_review_expired", "Refresh the exact Model's serving price before activation.");
  return ManagedServingUsageApprovalSchema.parse({
    schemaVersion: "openpond.managedServingUsageApproval.v1",
    reviewHash: contentHash,
    customerCapUsd: canonicalComputeSpendCap(spendingLimit),
  });
}
