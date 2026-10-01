import { z } from "zod";
import { ExperimentModelConfigurationSchema } from "@openpond/contracts";
import { JavaScriptEnvironmentDefinitionSchema } from "@openpond/evals/javascript-environment";
import { LearningTextAssetSchema } from "@openpond/evals/learning";
import { StandaloneHarnessExperimentSourceSchema } from "@openpond/evals/experiments";

const Id = z.string().trim().min(1).max(500);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);


/** Trusted execution-owner input. Private environment bytes stay with the
 * evaluator; the policy adapter receives only Evals' policy-facing messages. */
export const ExperimentModelCaseSchema = z.object({
  kind: z.literal("model"), id: z.string().trim().min(1).max(191), taskId: Id, admissionHash: Hash,
  model: ExperimentModelConfigurationSchema, instructions: z.string().max(262_144),
  harness: StandaloneHarnessExperimentSourceSchema.optional(),
  input: z.record(z.string(),z.unknown()),
  policyVisibleContext: z.record(z.string(),z.unknown()),
  timeoutMs: z.number().int().positive().max(3_600_000),
  environment: z.discriminatedUnion("kind", [
    z.object({kind:z.literal("text")}).strict(),
    z.object({kind:z.literal("javascript"),definition:JavaScriptEnvironmentDefinitionSchema,
      asset:LearningTextAssetSchema,initialState:z.record(z.string(),z.unknown()),seed:z.number().int().safe(),
    }).strict(),
  ]),
}).strict();
export const ExperimentCaseRequestSchema = z.discriminatedUnion("kind", [
  ExperimentModelCaseSchema,
  z.object({kind:z.literal("profile"),request:z.unknown()}).strict(),
]);
export type ExperimentModelCase = z.infer<typeof ExperimentModelCaseSchema>;
