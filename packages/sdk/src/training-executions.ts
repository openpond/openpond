import { z } from "zod";
import { TrainingJobSchema } from "./training-job-contracts.js";
import { ModelProjectVersionedRefSchema } from "./model-projects.js";
import { OpenPondProtocolError } from "./protocol.js";

const Id = z.string().trim().min(1).max(500);
/** Read-only collection metadata. Job identity/state remain owned by training;
 * this projection contains no training examples, input bundles or artifacts. */
export const TrainingExecutionSummarySchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingExecutionSummary.v1"),
    job: z.lazy(() => TrainingJobSchema),
    name: z.string().min(1).max(500),
    method: z.enum(["sft", "grpo", "reward_model_train"]).nullable(),
    model: z.object({ modelId: Id, revision: Id.nullable() }).strict().nullable(),
    dataset: ModelProjectVersionedRefSchema.nullable(),
    startedAt: z.iso.datetime().nullable(),
  })
  .strict();
export const TrainingExecutionListQuerySchema = z
  .object({
    projectId: Id.optional(),
    datasetHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    search: z.string().trim().max(1_000).optional(),
    cursor: z.string().trim().min(1).max(2_000).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
export const TrainingExecutionPageSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingExecutionPage.v1"),
    teamId: Id,
    projectId: Id.nullable(),
    items: z.array(TrainingExecutionSummarySchema).max(100),
    nextCursor: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict();
export type TrainingExecutionSummary = z.infer<typeof TrainingExecutionSummarySchema>;
export type TrainingExecutionPage = z.infer<typeof TrainingExecutionPageSchema>;
export type TrainingExecutionListQuery = z.input<typeof TrainingExecutionListQuerySchema>;
export function createTrainingExecutionClient(
  request: (path: string, init?: RequestInit) => Promise<unknown>,
) {
  return {
    async listExecutions(
      teamId: string,
      input: TrainingExecutionListQuery = {},
    ): Promise<TrainingExecutionPage> {
      const scope = Id.parse(teamId),
        query = TrainingExecutionListQuerySchema.parse(input);
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) params.set(key, String(value));
      const page = TrainingExecutionPageSchema.parse(
        await request(`/v1/training/executions?${params}`),
      );
      if (
        page.teamId !== scope ||
        page.projectId !== (query.projectId ?? null) ||
        page.items.length > query.limit ||
        new Set(page.items.map((item) => item.job.id)).size !== page.items.length ||
        (query.cursor && page.nextCursor === query.cursor) ||
        page.items.some(
          (item) =>
            item.job.teamId !== scope ||
            (query.datasetHash && item.dataset?.contentHash !== query.datasetHash),
        )
      )
        throw new OpenPondProtocolError(
          "training_execution_page_mismatch",
          "Training history returned a different scope or input selection.",
        );
      return page;
    },
  };
}
