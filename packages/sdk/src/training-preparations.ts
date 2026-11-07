import { TrainingUsageFundingRequestSchema, TrainingUsageQuoteSchema, TrainingUsageQualificationRefSchema, verifyTrainingUsageQuote } from "./training-usage-funding.js";
import { TrainingHandoffOriginSchema } from "./post-training.js";
import { z } from "zod";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import { TrainingJobSourceSchema, TrainingJobSubmissionSchema, parseAndVerifyTrainingJobSubmission } from "./training-job-contracts.js";
import { TrainingPhysicalPlacementSchema } from "./training-physical-placement.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";
import { TrainingEstimateReviewSchema, TrainingGpuSelectionSchema } from "./training-compute-selection.js";

const Id = z.string().trim().min(1).max(191);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

/** An exact retained GRPO checkpoint, never an inference alias or Model label.
 * Preparation verifies ownership and durability; execution rechecks runtime compatibility. */
export const TrainingPreparationParentSchema = z.object({
  jobId: Id,
  artifact: z.object({ id: Id, contentHash: Hash }).strict(),
  checkpointId: Id,
  adapterMode: z.enum(["residual_append", "shared", "sequential_merge"]),
}).strict();
export type TrainingPreparationParent = z.infer<typeof TrainingPreparationParentSchema>;

/** Manual training compiles an already reviewed batch. It creates no recurring policy. */
export const TrainingPreparationRequestSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingPreparationRequest.v1"),
    teamId: Id,
    operationId: Id,
    projectId: Id.nullable(),
    configuration: z
      .object({ id: Id, expectedRevision: z.number().int().positive(), expectedEtag: Hash })
      .strict(),
    origin: TrainingHandoffOriginSchema.optional(),
    parent: TrainingPreparationParentSchema.optional(),
    batch: ModelProjectVersionedRefSchema,
    name: z.string().trim().min(1).max(191),
    // Compiler resource safety budget; actual-usage customer cap is separate.
    maximumSpendUsd: z.number().finite().positive().max(1_000_000),
    usageFunding: TrainingUsageFundingRequestSchema.optional(),
    gpuSelection: TrainingGpuSelectionSchema.optional(),
    physicalPlacement: TrainingPhysicalPlacementSchema.optional(),
  })
  .strict();
export const TrainingPreparationPlanContentSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingPreparationPlan.v1"),
    id: Id,
    creatorUserId: Id,
    request: TrainingPreparationRequestSchema,
    requestHash: Hash,
    source: z.lazy(() => TrainingJobSourceSchema),
    submissionHash: Hash,
    usageQuote: TrainingUsageQuoteSchema.optional(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const TrainingPreparationPlanSchema = TrainingPreparationPlanContentSchema.extend({
  contentHash: Hash,
}).strict();
export const TrainingPreparationReceiptSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingPreparationReceipt.v1"),
    plan: TrainingPreparationPlanSchema,
    revision: z.number().int().positive(),
    state: z.enum(["prepared", "submitted", "cancelled"]),
    jobId: Id.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.state === "submitted") !== Boolean(value.jobId))
      context.addIssue({
        code: "custom",
        path: ["jobId"],
        message: "Only submitted preparations identify a job.",
      });
  });
export const TrainingPreparationControlSchema = z
  .object({
    teamId: Id,
    planHash: Hash,
    expectedRevision: z.number().int().positive(),
    estimateReview: TrainingEstimateReviewSchema.optional(),
    usageQuoteHash: Hash.optional(),
  })
  .strict();
export const TrainingPreparationListQuerySchema = z
  .object({
    projectId: Id.optional(),
    state: z.enum(["prepared", "submitted", "cancelled"]).optional(),
    afterId: Id.optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export const TrainingPreparationPageSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingPreparationPage.v1"),
    teamId: Id,
    items: z.array(TrainingPreparationReceiptSchema).max(100),
    nextCursor: Id.nullable(),
  })
  .strict();
export type TrainingPreparationRequest = z.infer<typeof TrainingPreparationRequestSchema>;
export type TrainingPreparationPlan = z.infer<typeof TrainingPreparationPlanSchema>;
export type TrainingPreparationReceipt = z.infer<typeof TrainingPreparationReceiptSchema>;
export type TrainingPreparationControl = z.infer<typeof TrainingPreparationControlSchema>;
export type TrainingPreparationListQuery = z.input<typeof TrainingPreparationListQuerySchema>;
export type TrainingPreparationPage = z.infer<typeof TrainingPreparationPageSchema>;

/** Imports an unchanged authored SFT artifact into the existing preparation
 * owner. The reference is a lookup/binding, never permission to run an
 * unqualified image. Only an exact live server-owned staging grant may admit it. */
export const TrainingSftQualificationPreparationImportSchema = z.object({
  schemaVersion: z.literal("openpond.trainingSftQualificationPreparationImport.v1"),
  preparationId: Id,
  qualification: TrainingUsageQualificationRefSchema,
  request: TrainingPreparationRequestSchema,
  submission: TrainingJobSubmissionSchema,
}).strict().superRefine((value, context) => {
  const {request, submission} = value;
  if (submission.job.kind !== "policy_optimize" || submission.job.recipe.method !== "sft" ||
    submission.job.executionMode !== undefined || submission.job.resumeFrom ||
    request.parent || request.physicalPlacement || submission.physicalPlacement ||
    (request.gpuSelection?.gpuCount ?? 1) !== 1 || (submission.gpuSelection?.gpuCount ?? 1) !== 1 ||
    !request.usageFunding || request.usageFunding.customerCapUsd === null ||
    submission.idempotencyKey !== `manual:${value.preparationId}` ||
    submission.source.modelProject.id !== request.configuration.id ||
    submission.name !== request.name || submission.budget.maximumSpendUsd !== request.maximumSpendUsd)
    context.addIssue({code: "custom", message: "Qualification import requires an exact fresh single-GPU SFT preparation with finite whole-job pricing."});
});
export type TrainingSftQualificationPreparationImport = z.infer<typeof TrainingSftQualificationPreparationImportSchema>;

export async function parseAndVerifyTrainingPreparationReceipt(value: unknown) {
  const receipt = TrainingPreparationReceiptSchema.parse(value);
  const { contentHash, ...plan } = receipt.plan;
  const usageFunding = plan.request.usageFunding;
  if (Boolean(usageFunding) !== Boolean(plan.usageQuote))
    throw new OpenPondProtocolError("training_usage_quote_mismatch", "Retain the reviewed complete Job price before starting.");
  if (plan.usageQuote && usageFunding)
    await verifyTrainingUsageQuote(plan.usageQuote, { teamId: plan.request.teamId, actorUserId: plan.creatorUserId,
      preparationId: plan.id, submissionHash: plan.submissionHash, customerCapUsd: usageFunding.customerCapUsd });
  if (
    (await canonicalSha256(plan)) !== contentHash ||
    (await canonicalSha256(plan.request)) !== plan.requestHash ||
    plan.source.modelProject.id !== plan.request.configuration.id ||
    (await canonicalSha256(plan.source.origin ?? null)) !==
      (await canonicalSha256(plan.request.origin ?? null))
  ) {
    throw new OpenPondProtocolError(
      "training_preparation_mismatch",
      "The prepared training inputs changed.",
    );
  }
  return receipt;
}

export function createTrainingPreparationClient(
  request: (path: string, init?: RequestInit) => Promise<unknown>,
) {
  async function read(value: unknown, teamId: string, id?: string) {
    const receipt = await parseAndVerifyTrainingPreparationReceipt(value);
    if (receipt.plan.request.teamId !== teamId || (id && receipt.plan.id !== id))
      throw new OpenPondProtocolError(
        "training_preparation_scope_mismatch",
        "The training preparation belongs to a different workspace or request.",
      );
    return receipt;
  }
  return {
    /** Preparation only: retains the original source and accepted usage quote;
     * starting paid compute still requires startPreparation separately. */
    async importSftQualificationPreparation(input: TrainingSftQualificationPreparationImport) {
      const parsed = TrainingSftQualificationPreparationImportSchema.parse(input);
      await parseAndVerifyTrainingJobSubmission(parsed.submission);
      const receipt = await read(await request("/v1/training/preparations/import-sft-qualification", {
        method: "POST", body: JSON.stringify(parsed),
      }), parsed.request.teamId, parsed.preparationId);
      if (receipt.plan.requestHash !== await canonicalSha256(parsed.request) ||
        receipt.plan.submissionHash !== parsed.submission.contentHash ||
        await canonicalSha256(receipt.plan.source) !== await canonicalSha256(parsed.submission.source) ||
        receipt.plan.usageQuote?.maximumWallSeconds !== parsed.submission.budget.maximumWallSeconds ||
        receipt.plan.usageQuote?.retentionDays !== parsed.submission.approval.retentionDays ||
        await canonicalSha256(receipt.plan.usageQuote?.qualification ?? null) !== await canonicalSha256(parsed.qualification))
        throw new OpenPondProtocolError("training_qualification_preparation_mismatch",
          "The imported preparation differs from the reviewed source or qualification authority.");
      return receipt;
    },
    /** Discover the authenticated user's retained preparations without creating jobs. */
    async listPreparations(teamId: string, input: TrainingPreparationListQuery = {}) {
      const scope = Id.parse(teamId);
      const query = TrainingPreparationListQuerySchema.parse(input);
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) params.set(key, String(value));
      const page = TrainingPreparationPageSchema.parse(
        await request(`/v1/training/preparations?${params}`),
      );
      if (
        page.teamId !== scope ||
        page.items.length > query.limit ||
        new Set(page.items.map((item) => item.plan.id)).size !== page.items.length ||
        (page.nextCursor !== null &&
          (page.nextCursor !== page.items.at(-1)?.plan.id || page.nextCursor === query.afterId))
      ) {
        throw new OpenPondProtocolError(
          "training_preparation_page_mismatch",
          "The preparation page does not match its workspace or cursor.",
        );
      }
      const items = await Promise.all(
        page.items.map(async (item) => {
          const receipt = await read(item, scope);
          if (
            (query.projectId && receipt.plan.request.projectId !== query.projectId) ||
            (query.state && receipt.state !== query.state)
          ) {
            throw new OpenPondProtocolError(
              "training_preparation_page_mismatch",
              "A preparation does not match the requested Project or state.",
            );
          }
          return receipt;
        }),
      );
      return { ...page, items };
    },
    async prepareRun(input: TrainingPreparationRequest) {
      const parsed = TrainingPreparationRequestSchema.parse(input);
      const receipt = await read(
        await request("/v1/training/preparations", {
          method: "POST",
          body: JSON.stringify(parsed),
        }),
        parsed.teamId,
      );
      if (receipt.plan.requestHash !== (await canonicalSha256(parsed)))
        throw new OpenPondProtocolError(
          "training_preparation_request_mismatch",
          "The preparation does not match the requested run.",
        );
      return receipt;
    },
    async getPreparation(teamId: string, id: string) {
      return read(
        await request(`/v1/training/preparations/${encodeURIComponent(Id.parse(id))}`),
        Id.parse(teamId),
        id,
      );
    },
    async startPreparation(id: string, input: TrainingPreparationControl) {
      const parsed = TrainingPreparationControlSchema.parse(input);
      const receipt = await read(
        await request(`/v1/training/preparations/${encodeURIComponent(Id.parse(id))}/start`, {
          method: "POST",
          body: JSON.stringify(parsed),
        }),
        parsed.teamId,
        id,
      );
      if (receipt.plan.contentHash !== parsed.planHash || receipt.state !== "submitted" ||
        receipt.plan.usageQuote?.contentHash !== parsed.usageQuoteHash)
        throw new OpenPondProtocolError(
          "training_preparation_start_mismatch",
          "The submitted run does not match the approved preparation.",
        );
      return receipt;
    },
    async cancelPreparation(id: string, input: TrainingPreparationControl) {
      const parsed = TrainingPreparationControlSchema.parse(input);
      const receipt = await read(
        await request(`/v1/training/preparations/${encodeURIComponent(Id.parse(id))}/cancel`, {
          method: "POST",
          body: JSON.stringify(parsed),
        }),
        parsed.teamId,
        id,
      );
      if (receipt.plan.contentHash !== parsed.planHash || receipt.state !== "cancelled")
        throw new OpenPondProtocolError(
          "training_preparation_cancel_mismatch",
          "The preparation cancellation could not be verified.",
        );
      return receipt;
    },
  };
}
