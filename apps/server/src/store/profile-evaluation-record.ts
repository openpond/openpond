import { z } from "zod";
import { OpenPondProfileRefSchema } from "@openpond/contracts";
import { ImmutableReleaseRefSchema } from "@openpond/harness";
import { TasksetRunManifestSchema, TasksetMetricResultSchema } from "@openpond/evals";

export const LocalProfileEvaluationRunSchema = z.object({
  profileRef: OpenPondProfileRefSchema,
  manifest: TasksetRunManifestSchema,
  metric: TasksetMetricResultSchema,
  gradeRefs: z.array(ImmutableReleaseRefSchema),
  receiptRefs: z.array(ImmutableReleaseRefSchema),
  passRate: z.number().min(0).max(1),
  passed: z.boolean(),
  completedAt: z.string().datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type LocalProfileEvaluationRun = z.infer<typeof LocalProfileEvaluationRunSchema>;

