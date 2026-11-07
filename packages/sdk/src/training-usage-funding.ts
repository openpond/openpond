import { z } from "zod";
import { ComputeAppliedPriceSchema } from "./managed-compute-price.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().min(1).max(500), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Price = ComputeAppliedPriceSchema.extend({ service: z.literal("managed_rl") });
const Cap = z.string().regex(/^(0|[1-9]\d*)\.\d{6}$/).max(24).refine(value => {
  if (!/^(0|[1-9]\d*)\.\d{6}$/.test(value) || value.length > 24) return false;
  const micros = BigInt(value.replace(".", ""));
  return micros > 0n && micros <= BigInt(Number.MAX_SAFE_INTEGER);
}).nullable();
const Guests = z.array(z.object({
  profileHash: Hash, price: Price,
  resources: z.object({ cpu: z.number().positive(), memoryGb: z.number().positive(), diskGb: z.number().nonnegative() }).strict(),
}).strict()).max(32);
const Rate = z.string().regex(/^(0|[1-9]\d*)\.\d{6}$/).max(24).refine(value =>
  /^(0|[1-9]\d*)\.\d{6}$/.test(value) && value.length <= 24 &&
  BigInt(value.replace(".", "")) <= BigInt(Number.MAX_SAFE_INTEGER));
const Judges = z.object({
  billing: z.literal("existing_retail_child_captures"), acceptedPricingHashes: z.array(Hash).max(64),
  prices: z.array(z.object({
    modelId: Id, displayName: Id, acceptedPricingHash: Hash,
    inputUsdPerMillionTokens: Rate, cachedInputUsdPerMillionTokens: Rate, outputUsdPerMillionTokens: Rate,
    cacheWriteUsdPerMillionTokens: Rate.nullable(), cacheWriteOneHourUsdPerMillionTokens: Rate.nullable(),
    longContextThresholdTokens: z.number().int().positive().nullable(),
    longContext: z.object({ inputUsdPerMillionTokens: Rate, cachedInputUsdPerMillionTokens: Rate,
      outputUsdPerMillionTokens: Rate, cacheWriteUsdPerMillionTokens: Rate.nullable() }).strict().nullable(),
  }).strict()).max(64),
}).strict();

export const TrainingBillingModesSchema = z.tuple([
  z.object({ mode: z.literal("prepaid_only"), availability: z.literal("available"), reason: z.null() }).strict(),
  z.object({ mode: z.literal("actual_usage"), availability: z.enum(["unavailable", "requires_preparation"]),
    reason: z.string().min(1).max(500).nullable() }).strict(),
]);
export type TrainingBillingModes = z.infer<typeof TrainingBillingModesSchema>;

/** The optional customer limit covers all priced components of this Job.
 * An omitted limit uses eligible credits; it never permits customer debt. */
export const TrainingUsageFundingRequestSchema = z.object({
  schemaVersion: z.literal("openpond.trainingUsageFundingRequest.v1"),
  billingMode: z.literal("actual_usage"), customerCapUsd: Cap,
}).strict();
export type TrainingUsageFundingRequest = z.infer<typeof TrainingUsageFundingRequestSchema>;

/** A server-signed reference to a bounded operator qualification. This pointer
 * confers no authority and does not advertise ordinary image support. */
export const TrainingUsageQualificationRefSchema = z.object({
  authorizationId: z.uuid(), operationId: Id, authorizationSha256: Hash,
}).strict();
export type TrainingUsageQualificationRef = z.infer<typeof TrainingUsageQualificationRefSchema>;

export const TrainingUsageQuoteContentSchema = z.object({
  schemaVersion: z.literal("openpond.trainingUsageQuote.v1"), teamId: Id, actorUserId: Id,
  preparationId: Id, submissionHash: Hash, workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  customerCapUsd: Cap, maximumWallSeconds: z.number().int().positive(), retentionDays: z.number().int().nonnegative(),
  qualification: TrainingUsageQualificationRefSchema.optional(),
  gpu: Price, guests: Guests, judges: Judges,
  storage: z.object({ price: Price, storageClass: z.literal("STANDARD"), quantityBasis: z.literal("gib_milliseconds"),
    onCreditExhaustion: z.literal("retain_objects_and_stop_new_storage") }).strict(),
  gpuBillingBoundary: z.literal("active_allocation_until_verified_cleanup"),
  storageBillingBoundary: z.literal("accepted_retention_window"),
  startupBillable: z.literal(true), postCompletionIdleBillable: z.literal(false), minimumBillableSeconds: z.literal(0),
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
}).strict();
export const TrainingUsageQuoteSchema = TrainingUsageQuoteContentSchema.extend({ contentHash: Hash, signature: Id }).strict();
export type TrainingUsageQuote = z.infer<typeof TrainingUsageQuoteSchema>;

/** The server verifies its private signature before dispatch. Clients verify
 * the quote's hash and exact reviewed preparation without possessing that key. */
export async function verifyTrainingUsageQuote(raw: TrainingUsageQuote, expected: {
  teamId: string; actorUserId: string; preparationId: string; submissionHash: string; customerCapUsd: string | null;
}) {
  const quote = TrainingUsageQuoteSchema.parse(raw), { contentHash, signature: _signature, ...content } = quote;
  if (contentHash !== await canonicalSha256(content) || quote.teamId !== expected.teamId ||
    quote.actorUserId !== expected.actorUserId || quote.preparationId !== expected.preparationId ||
    quote.submissionHash !== expected.submissionHash || quote.customerCapUsd !== expected.customerCapUsd ||
    Date.parse(quote.expiresAt) <= Date.parse(quote.issuedAt) ||
    new Set(quote.guests.map(guest => guest.profileHash)).size !== quote.guests.length ||
    quote.guests.some(guest => guest.profileHash !== guest.price.profileHash) ||
    new Set(quote.judges.acceptedPricingHashes).size !== quote.judges.acceptedPricingHashes.length ||
    new Set(quote.judges.prices.map(price => price.acceptedPricingHash)).size !== quote.judges.prices.length ||
    quote.judges.prices.length !== quote.judges.acceptedPricingHashes.length ||
    quote.judges.prices.some(price => !quote.judges.acceptedPricingHashes.includes(price.acceptedPricingHash)))
    throw new OpenPondProtocolError("training_usage_quote_mismatch", "Training prices differ from the reviewed preparation, actor or spending limit.");
  return quote;
}
