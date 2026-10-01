import { z } from "zod";
import { StandaloneHarnessExperimentSourceSchema } from "@openpond/evals/experiments";

/** Catalog projections carry immutable pins and readiness, never source bytes. */
export const ExperimentHarnessCatalogSchema = z
  .object({
    teamId: z.string().trim().min(1).max(240),
    items: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(500),
            source: StandaloneHarnessExperimentSourceSchema,
            ready: z.boolean(),
            reason: z.string().min(1).max(2000).nullable(),
          })
          .strict(),
      )
      .max(8),
    nextCursor: z.string().min(1).max(8192).nullable(),
  })
  .strict();
export type ExperimentHarnessCatalog = z.infer<typeof ExperimentHarnessCatalogSchema>;
