import { z } from "zod";

export const CommerceId = z.string().min(1).max(191);
export const CommerceHash = z.string().regex(/^[a-f0-9]{64}$/);
export const UsdcAmount = z.string().regex(/^[1-9][0-9]{0,11}$/);
export const CommerceOperation = z.object({ operationId: CommerceId });
export const CommerceReleaseRef = z
  .object({
    id: CommerceId,
    revision: z.number().int().positive(),
    contentHash: CommerceHash,
  })
  .strict();
export const ListingTerms = z
  .object({
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().min(10).max(8000),
    category: z.string().trim().min(1).max(80),
    tags: z.array(z.string().trim().min(1).max(40)).max(12),
    priceBaseUnits: UsdcAmount,
    license: z.string().trim().min(3).max(4000),
  })
  .strict();
export const CaptureCommerceRelease = CommerceOperation.extend({
  tasksetId: CommerceId,
  release: CommerceReleaseRef,
  packageHash: CommerceHash,
  sampleTaskIds: z.array(CommerceId).min(1).max(10),
  approvedSample: z.literal(true),
}).strict();
export const WriteCommerceListing = CommerceOperation.extend({
  id: CommerceId.optional(),
  expectedRevision: z.number().int().nonnegative(),
  releaseId: CommerceId,
  terms: ListingTerms,
  state: z.enum(["draft", "listed", "paused", "retired"]),
}).strict();
export const CommerceCursor = z.string().min(1).max(1024);
export const CommerceDatasetFormat = z.enum([
  "native",
  "csv",
  "jsonl",
  "parquet",
]);
/** Amount filters apply to listing price or the request's indicative budget. */
export const CommerceBrowse = z
  .object({
    search: z.string().max(120).optional(),
    category: z.string().max(80).optional(),
    format: CommerceDatasetFormat.optional(),
    license: z.string().max(120).optional(),
    minPriceBaseUnits: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,11})$/)
      .optional(),
    maxPriceBaseUnits: UsdcAmount.optional(),
    sort: z.enum(["newest", "price_low", "price_high"]).default("newest"),
    cursor: CommerceCursor.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine(
    (value) =>
      !value.minPriceBaseUnits ||
      !value.maxPriceBaseUnits ||
      BigInt(value.minPriceBaseUnits) <= BigInt(value.maxPriceBaseUnits),
    {
      message: "Minimum price must not exceed maximum price.",
      path: ["maxPriceBaseUnits"],
    },
  );
export const DatasetRequestContent = z
  .object({
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().min(10).max(8000),
    category: z.string().trim().min(1).max(80),
    budgetBaseUnits: UsdcAmount,
    requirements: z
      .object({
        schema: z.string().max(8000).default(""),
        formats: z.array(z.enum(["native", "csv", "jsonl", "parquet"])).min(1),
        minRecords: z.number().int().nonnegative().optional(),
        maxRecords: z.number().int().positive().optional(),
        languages: z.array(z.string().max(80)).max(20).default([]),
        provenance: z.string().max(4000).default(""),
        license: z.string().max(4000).default(""),
        privacy: z.string().max(4000).default(""),
        acceptance: z.string().max(4000).default(""),
      })
      .strict(),
    deadline: z.string().datetime().nullable(),
    projectId: CommerceId.nullable(),
  })
  .strict();
export const WriteDatasetRequest = CommerceOperation.extend({
  id: CommerceId.optional(),
  expectedRevision: z.number().int().nonnegative(),
  content: DatasetRequestContent,
  state: z.enum(["draft", "open", "paused", "closed", "cancelled"]),
}).strict();
export const SubmitDatasetOffer = CommerceOperation.extend({
  requestId: CommerceId,
  requestRevision: z.number().int().positive(),
  expectedRevision: z.number().int().nonnegative(),
  releaseId: CommerceId,
  priceBaseUnits: UsdcAmount,
  license: z.string().min(3).max(4000),
  explanation: z.string().min(10).max(8000),
  expiresAt: z.string().datetime(),
}).strict();
export const ReviewDatasetOffer = CommerceOperation.extend({
  id: CommerceId,
  expectedRevision: z.number().int().positive(),
  expectedUpdatedAt: z.string().datetime(),
  state: z.enum(["submitted", "shortlisted", "changes_requested", "declined"]),
  note: z.string().max(8000).optional(),
}).strict();
export const CommerceCheckout = CommerceOperation.extend({
  source: z.enum(["listing", "offer"]),
  sourceId: CommerceId,
  sourceRevision: z.number().int().positive(),
  destinationProjectId: CommerceId.nullable(),
  acceptedTermsHash: CommerceHash,
}).strict();
export const CommerceProfileContent = z
  .object({
    bio: z.string().max(2000),
    specialties: z.array(z.string().min(1).max(80)).max(12),
  })
  .strict();
export const WriteCommerceProfile = CommerceOperation.extend({
  expectedRevision: z.number().int().nonnegative(),
  content: CommerceProfileContent,
}).strict();

export type ListingTermsValue = z.infer<typeof ListingTerms>;
export type RequestContent = z.infer<typeof DatasetRequestContent>;
export type CommerceSample = { taskId: string; input: unknown }[];
export type CommerceListingView = {
  id: string;
  revision: number;
  teamId: string;
  sellerUserId: string;
  releaseId: string;
  state: string;
  terms: ListingTermsValue;
  termsHash: string;
  release: z.infer<typeof CommerceReleaseRef>;
  packageHash: string;
  taskCount: number;
  format: z.infer<typeof CommerceDatasetFormat>;
  sizeBytes: number;
  sample: CommerceSample;
  sampleHash: string;
  createdAt: string;
};
export type CommerceSummary = {
  tasksetId: string;
  release: z.infer<typeof CommerceReleaseRef>;
  listings: {
    id: string;
    revision: number;
    state: string;
    priceBaseUnits: string;
  }[];
  offers: { id: string; state: string }[];
  purchases: { id: string; state: string }[];
};
