import { z } from "zod";
import { ProfileEvaluationRunSourceSchema } from "@openpond/evals";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

/** The host admits this released component through its native Harness engine.
 * Chat prompt/settings are owned by the released source, not replaced here. */
export const HarnessExperimentPolicySchema = z.object({
  kind: z.literal("hosted_harness"),
  modelId: Id,
  reasoningEffort: z.enum(["off", "low", "medium", "high", "xhigh", "max"]).optional(),
  profileRepositoryId: Id,
  source: ProfileEvaluationRunSourceSchema,
  modelConfigurationHash: Hash,
  packageHash: Hash,
}).strict();
export type HarnessExperimentPolicy = z.infer<typeof HarnessExperimentPolicySchema>;
