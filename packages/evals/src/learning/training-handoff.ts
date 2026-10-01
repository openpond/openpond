import { z } from "zod";
import { ExperimentTargetSchema } from "../experiments.js";
const Id = z.string().trim().min(1).max(200);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Ref = z.object({ id: Id, contentHash: Hash }).strict();
export const TrainingHandoffOriginSchema = z
  .object({
    schemaVersion: z.literal("openpond.trainingHandoffOrigin.v1"),
    teamId: Id,
    projectId: Id.nullable(),
    configurationId: Id,
    source: z
      .object({ executionId: Id, passId: Id.nullable(), manifestHash: Hash, resultHash: Hash })
      .strict(),
    dataset: z
      .object({ id: Id, revision: z.number().int().positive(), contentHash: Hash })
      .strict(),
    target: ExperimentTargetSchema,
    graders: z
      .array(
        z
          .object({
            feedbackKey: Id,
            evaluator: Ref,
            expectedCount: z.number().int().positive(),
            scoredCount: z.number().int().nonnegative(),
            score: z.number().finite().nullable(),
          })
          .strict(),
      )
      .max(100),
    contentHash: Hash,
  })
  .strict();
export type TrainingHandoffOrigin = z.infer<typeof TrainingHandoffOriginSchema>;
