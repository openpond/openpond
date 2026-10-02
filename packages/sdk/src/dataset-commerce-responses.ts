import { z } from "zod";
import {
  CommerceHash,
  CommerceId,
  CommerceReleaseRef,
  DatasetRequestContent,
  ListingTerms,
  UsdcAmount,
} from "./dataset-commerce-contracts.js";

const Timestamp = z.string().datetime({ offset: true });
const Address = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const TransactionHash = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
export const CommerceSampleSchema = z
  .array(z.object({ taskId: CommerceId, input: z.unknown() }).strict())
  .max(10);
export const CommerceCapturedReleaseSchema = z
  .object({
    id: CommerceId,
    release: CommerceReleaseRef,
    packageHash: CommerceHash,
    sample: CommerceSampleSchema,
    sampleHash: CommerceHash,
    taskCount: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export const CommerceListingSchema = CommerceCapturedReleaseSchema.extend({
  revision: z.number().int().positive(),
  teamId: CommerceId,
  sellerUserId: CommerceId,
  releaseId: CommerceId,
  state: z.enum(["draft", "listed", "paused", "retired"]),
  terms: ListingTerms,
  termsHash: CommerceHash,
  createdAt: Timestamp,
}).strict();
export const CommerceListingReceiptSchema = z
  .object({
    id: CommerceId,
    revision: z.number().int().positive(),
    releaseId: CommerceId,
    state: z.enum(["draft", "listed", "paused", "retired"]),
    terms: ListingTerms,
    termsHash: CommerceHash,
    payee: Address,
  })
  .strict();
export const CommerceListingsPageSchema = z
  .object({ items: z.array(CommerceListingSchema).max(50), cursor: CommerceId.nullable() })
  .strict();
export const CommerceInventorySchema = z
  .object({
    releases: z
      .array(
        CommerceCapturedReleaseSchema.omit({ sizeBytes: true, sample: true }).extend({
          tasksetId: CommerceId,
          title: z.string(),
        }),
      )
      .max(100),
    listings: z.array(CommerceListingSchema.omit({ sample: true })).max(100),
  })
  .strict();
export const CommerceOrderSchema = z
  .object({
    id: CommerceId,
    buyerUserId: CommerceId,
    buyerTeamId: CommerceId,
    sellerUserId: CommerceId,
    sellerTeamId: CommerceId,
    source: z.enum(["listing", "offer"]),
    sourceId: CommerceId,
    sourceRevision: z.number().int().positive(),
    releaseId: CommerceId,
    termsHash: CommerceHash,
    amountBaseUnits: UsdcAmount,
    sender: Address,
    payee: Address,
    chainId: z.literal(42161),
    tokenAddress: Address,
    authorizationNonce: TransactionHash,
    issuedBlock: z.string().regex(/^[0-9]+$/),
    scannedBlock: z
      .string()
      .regex(/^[0-9]+$/)
      .nullable(),
    validAfter: Timestamp,
    expiresAt: Timestamp,
    destinationProjectId: CommerceId.nullable(),
    state: z.enum([
      "awaiting_payment",
      "confirming",
      "paid",
      "delivery_failed",
      "delivered",
      "expired",
    ]),
    transactionHash: TransactionHash.nullable(),
    deliveryTasksetId: CommerceId.nullable(),
    errorCode: z.string().nullable(),
    deliveryKind: z.enum(["draft", "release"]).optional(),
    deliveredAt: Timestamp.nullable(),
    nextAttemptAt: Timestamp,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict();
export const CommercePaymentSubmissionSchema = z.union([
  z.object({ orderId: CommerceId, state: z.enum(["awaiting_payment", "confirming"]) }).strict(),
  CommerceOrderSchema,
]);
export type CommerceOrder = z.infer<typeof CommerceOrderSchema>;

export const CommerceRequestSchema = z
  .object({
    id: CommerceId,
    buyerUserId: CommerceId,
    revision: z.number().int().positive(),
    state: z.enum(["draft", "open", "paused", "closed", "cancelled", "fulfilled"]),
    content: DatasetRequestContent,
    createdAt: Timestamp,
  })
  .strict();
export const CommerceRequestsPageSchema = z
  .object({ items: z.array(CommerceRequestSchema).max(50), cursor: CommerceId.nullable() })
  .strict();
export const CommerceRequestReceiptSchema = CommerceRequestSchema.omit({
  buyerUserId: true,
  createdAt: true,
});
export const CommerceOwnedRequestSchema = CommerceRequestSchema.extend({
  teamId: CommerceId,
  selectedOrderId: CommerceId.nullable(),
  updatedAt: Timestamp,
}).strict();
export const CommerceOfferSchema = z
  .object({
    id: CommerceId,
    requestId: CommerceId,
    requestTitle: z.string(),
    requestRevision: z.number().int().positive(),
    buyerUserId: CommerceId,
    sellerUserId: CommerceId,
    state: z.enum([
      "submitted",
      "shortlisted",
      "changes_requested",
      "declined",
      "withdrawn",
      "selected",
      "purchased",
      "not_selected",
    ]),
    revision: z.number().int().positive(),
    updatedAt: Timestamp,
    proposal: z
      .object({
        offerId: CommerceId,
        revision: z.number().int().positive(),
        requestRevision: z.number().int().positive(),
        releaseId: CommerceId,
        priceBaseUnits: UsdcAmount,
        license: z.string(),
        explanation: z.string(),
        payee: Address,
        termsHash: CommerceHash,
        expiresAt: Timestamp,
        createdAt: Timestamp,
      })
      .strict(),
    release: CommerceReleaseRef,
    taskCount: z.number().int().nonnegative(),
    sample: CommerceSampleSchema,
    sampleHash: CommerceHash,
    notes: z
      .array(
        z
          .object({
            id: CommerceId,
            authorUserId: CommerceId,
            body: z.string(),
            createdAt: Timestamp,
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export const CommerceOfferSummarySchema = CommerceOfferSchema.omit({ sample: true, notes: true });
export const CommerceOfferDetailSchema = CommerceOfferSchema.extend({
  notes: CommerceOfferSchema.shape.notes.max(20),
  notesCursor: CommerceId.nullable(),
  history: z.array(CommerceOfferSchema.shape.proposal).max(20),
  historyBefore: z.number().int().positive().nullable(),
  canReview: z.boolean(),
}).strict();
export const CommerceOfferSubmissionSchema = z
  .object({
    id: CommerceId,
    revision: z.number().int().positive(),
    state: z.literal("submitted"),
    termsHash: CommerceHash,
  })
  .strict();
export const CommerceOfferReviewReceiptSchema = z
  .object({
    id: CommerceId,
    revision: z.number().int().positive(),
    state: z.enum(["submitted", "shortlisted", "changes_requested", "declined"]),
  })
  .strict();
