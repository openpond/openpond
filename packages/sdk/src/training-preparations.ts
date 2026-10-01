import { TrainingHandoffOriginSchema } from "./post-training.js";
import { z } from "zod";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import { TrainingJobSourceSchema } from "./training.js";
import { canonicalSha256, OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(191);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

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
    batch: ModelProjectVersionedRefSchema,
    name: z.string().trim().min(1).max(191),
    maximumSpendUsd: z.number().finite().positive().max(1_000_000),
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

export async function parseAndVerifyTrainingPreparationReceipt(value: unknown) {
  const receipt = TrainingPreparationReceiptSchema.parse(value);
  const { contentHash, ...plan } = receipt.plan;
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
      if (receipt.plan.contentHash !== parsed.planHash || receipt.state !== "submitted")
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
