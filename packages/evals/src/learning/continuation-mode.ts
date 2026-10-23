import { z } from "zod";
import { ReleaseHashSchema, ReleaseIdSchema } from "@openpond/harness";
/** A deliberate future-stage choice, independent of the original pinned
 * optimizer/data configuration. Its Model source reference remains truthful;
 * already reserved iterations retain their earlier immutable policy revision. */
export const LearningContinuationModeOverrideSchema = z.object({
  adapterMode: z.enum(["residual_append", "shared", "sequential_merge"]),
  sourceConfiguration: z.object({ id: ReleaseIdSchema, revision: z.number().int().positive(), etag: ReleaseHashSchema }).strict(),
}).strict();
export type LearningContinuationModeOverride = z.infer<typeof LearningContinuationModeOverrideSchema>;
