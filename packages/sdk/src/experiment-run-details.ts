import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { ExperimentExecutionContextSchema, ExperimentGraderPinSchema } from "./experiment-contracts.js";
import { ModelTasksetRunDetailsSchema, ModelTasksetRunRequestSchema, verifyModelTasksetRunDetails, type ModelTasksetRunRequest } from "./model-taskset-runs-contracts.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const ConfigurationContent = z.object({
  request: ModelTasksetRunRequestSchema,
  maximumCostUsd: z.number().finite().positive().max(10_000),
  graders: z.array(ExperimentGraderPinSchema).min(1).max(100),
  admissionRequestHash: Hash.optional(),
  sourceExperimentId: z.string().trim().min(1).max(200).optional(),
}).strict();
export const ExperimentRunConfigurationSchema = ConfigurationContent.extend({configurationHash:Hash}).strict();
export type ExperimentRunConfiguration = z.infer<typeof ExperimentRunConfigurationSchema>;
export const ExperimentRunDetailsSchema = ModelTasksetRunDetailsSchema.extend({configuration:ExperimentRunConfigurationSchema}).strict();
export type ExperimentRunDetails = z.infer<typeof ExperimentRunDetailsSchema>;

/** Native preparation assigns new receipt IDs while retaining the selected
 * task/seed population. Other runtimes seal their submitted IDs exactly. */
export function experimentConfigurationRequest(request: ModelTasksetRunRequest) {
  return request.policy.kind === "hosted_harness"
    ? {...request,population:request.population.map(({receiptId:_id,...member})=>member)}
    : request;
}
export function experimentRunConfigurationHash(value: z.input<typeof ConfigurationContent>): string {
  const content = ConfigurationContent.parse(value);
  return contentHash({...content,request:experimentConfigurationRequest(content.request)});
}
export async function verifyExperimentRunDetails(value: unknown): Promise<ExperimentRunDetails> {
  const parsed = ExperimentRunDetailsSchema.parse(value);
  const {configuration,...rawDetails} = parsed;
  const details = await verifyModelTasksetRunDetails(rawDetails);
  const {configurationHash,...content} = configuration;
  if (configurationHash !== experimentRunConfigurationHash(content)
    || contentHash(experimentConfigurationRequest(configuration.request)) !== contentHash(experimentConfigurationRequest(details.request))
    || configuration.maximumCostUsd !== details.manifest.limits.maximumSpendUsd)
    throw new Error("Experiment configuration differs from its retained run.");
  if (details.manifest.metadata.experimentDefinition === null) {
    const context = ExperimentExecutionContextSchema.parse({
      definition:null, configurationHash:configuration.configurationHash,
      maximumCostUsd:configuration.maximumCostUsd,graders:configuration.graders,
      ...(configuration.admissionRequestHash ? {admissionRequestHash:configuration.admissionRequestHash} : {}),
      ...(configuration.sourceExperimentId ? {sourceExperimentId:configuration.sourceExperimentId} : {}),
    });
    if (details.manifest.metadata.experimentConfigurationHash !== contentHash(context))
      throw new Error("Experiment configuration differs from its admitted manifest.");
  }
  return {...details,configuration};
}
