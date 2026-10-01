import { z } from "zod";
import { RewardReleaseRefSchema } from "@openpond/evals/rewards";

/** Publication freezes the owner-selected Dataset revision and exact grader
 * releases. Capture never infers a correctness reference from an answer. */
export const ConnectedDatasetPublicationSchema = z.object({
  datasetId: z.string().trim().min(1).max(240),
  expectedRevision: z.number().int().positive(),
  operationId: z.string().trim().min(1).max(240),
  graders: z.array(RewardReleaseRefSchema).min(1).max(100).optional(),
}).strict().superRefine((request, context) => {
  if (request.graders && new Set(request.graders.map(ref => ref.id)).size !== request.graders.length)
    context.addIssue({ code: "custom", path: ["graders"], message: "Choose one exact revision of each grader." });
});
export type ConnectedDatasetPublication = z.infer<typeof ConnectedDatasetPublicationSchema>;
