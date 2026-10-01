import { z } from "zod";
import { ModelTasksetRunRequestSchema } from "./model-taskset-runs-contracts.js";
import { ExperimentGraderSelectionSchema } from "./experiment-contracts.js";

const Id = z.string().trim().min(1).max(200);

/** One reviewed configuration admits one Experiment. A transport retry reuses
 * its operation identity; Duplicate and edit submits a new operation. */
export const RunExperimentSchema = z.object({
  operationId: Id,
  request: ModelTasksetRunRequestSchema,
  maximumCostUsd: z.number().finite().positive().max(10_000),
  graders: z.array(ExperimentGraderSelectionSchema).min(1).max(100).optional(),
  sourceExperimentId: Id.optional(),
}).strict().superRefine((value, context) => {
  if (!value.request.name)
    context.addIssue({ code: "custom", path: ["request", "name"], message: "Name this Experiment before starting it." });
  if (value.operationId !== value.request.operationId)
    context.addIssue({ code: "custom", path: ["request", "operationId"], message: "Use one operation identity for this Experiment." });
  if (Math.round(value.maximumCostUsd * 1_000_000) < 1)
    context.addIssue({ code: "custom", path: ["maximumCostUsd"], message: "The spending cap must be at least $0.000001." });
  if (value.graders && new Set(value.graders.map(grader => grader.id)).size !== value.graders.length)
    context.addIssue({ code: "custom", path: ["graders"], message: "Select each grader once." });
});
export type RunExperiment = z.infer<typeof RunExperimentSchema>;
