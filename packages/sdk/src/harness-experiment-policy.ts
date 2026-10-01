import { z } from "zod";
import { ProfileEvaluationRunSourceSchema, ProfileExternalDatasetBindingSchema } from "@openpond/evals";

const Id = z.string().trim().min(1).max(240);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

/** The host admits this released component through its native Harness engine.
 * Chat prompt/settings are owned by the released source, not replaced here. */
export const HarnessExperimentPolicySchema = z.object({
  kind: z.literal("hosted_harness"),
  modelId: Id,
  candidate:z.object({artifactId:Id,contentHash:Hash,preparationId:Id,dispatchId:Id,baseProfileId:Id,workerImageDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/)}).strict().optional(),
  sourceCandidate:ProfileEvaluationRunSourceSchema.shape.sourceCandidate,
  reasoningEffort: z.enum(["off", "low", "medium", "high", "xhigh", "max"]).optional(),
  profileRepositoryId: Id,
  source: ProfileEvaluationRunSourceSchema,
  modelConfigurationHash: Hash,
  packageHash: Hash,
  externalDatasetBinding: ProfileExternalDatasetBindingSchema.optional(),
}).strict().superRefine((value,context)=>{if(JSON.stringify(value.externalDatasetBinding??null)!==JSON.stringify(value.source.externalDatasetBinding??null))context.addIssue({code:"custom",message:"The policy and source must bind the same external Dataset recipe."});if(JSON.stringify(value.sourceCandidate??null)!==JSON.stringify(value.source.sourceCandidate??null))context.addIssue({code:"custom",message:"The policy and prepared source must bind the same actual source candidate."});});
export type HarnessExperimentPolicy = z.infer<typeof HarnessExperimentPolicySchema>;
