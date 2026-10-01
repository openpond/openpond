import { OpenPondProfileRefSchema } from "@openpond/contracts";
import { z } from "zod";
import { contentHash } from "@openpond/harness";
import { PrepareHarnessExperimentSchema,PreparedHarnessExperimentSchema } from "openpond-sdk/experiments";
import type { createProfileEvaluationRunPreparationService } from "../harness/profile-evaluation-run-preparation.js";
import type { TasksetPackage } from "openpond-sdk/taskset-packages";
import { localPackageGraders } from "./local-experiment-admission.js";
import type { LocalProfileOwner } from "./local-experiment-profile.js";
import type { LocalExperimentDefinition } from "./local-experiment-contract.js";
import { LocalExperimentError } from "./local-experiment-contract.js";

type Prepared=Awaited<ReturnType<ReturnType<typeof createProfileEvaluationRunPreparationService>>>;
/** Public projection omits the prepared Taskset and its private verifier bytes. */
export async function prepareLocalProfileExperiment(input:{raw:unknown;teamId:string;
  prepare:ReturnType<typeof createProfileEvaluationRunPreparationService>;
  loadPackage(prepared:Prepared):Promise<TasksetPackage>;
  resolve:LocalProfileOwner["resolve"];
}) {
  const request=PrepareHarnessExperimentSchema.extend({profileRef:OpenPondProfileRefSchema,profileSource:z.object({sourceRevision:z.string().min(1).max(500),harnessRelease:z.object({id:z.string().min(1),contentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()}).strict().optional()}).parse(input.raw);
  if(request.profileRef.source!=="local"||request.profileRef.repositoryId!==request.profileRepositoryId)throw new LocalExperimentError("local_profile_origin_not_qualified","Choose an accepted device-local Profile repository.",403);
  if(request.reasoningEffort)throw new LocalExperimentError("local_profile_sampling_not_qualified","This local Profile owner does not admit reasoning overrides.",422);
  const prepared=await input.prepare({id:`local-profile-review-${contentHash([input.teamId,request.operationId]).slice(0,40)}`,
    createdAt:"1970-01-01T00:00:00.000Z",profileRef:request.profileRef,...(request.profileSource?{profileSource:request.profileSource}:{}),definitionId:request.definitionId,modelRef:{providerId:"openpond",modelId:request.modelId},maximumSpendUsd:request.maximumCostUsd});
  const source=prepared.manifest.profileEvaluation!;
  const value=await input.loadPackage(prepared);
  const policy={kind:"hosted_harness" as const,modelId:request.modelId,profileRepositoryId:request.profileRepositoryId,
    source,modelConfigurationHash:prepared.modelConfigurationHash,packageHash:value.contentHash};
  const runRequest={schemaVersion:"openpond.modelTasksetRunRequest.v1" as const,operationId:request.operationId,teamId:input.teamId,
    modelProjectId:null,name:source.definitionId,taskset:{id:prepared.taskset.id,revision:prepared.taskset.revision,contentHash:prepared.taskset.contentHash},
    policy,population:prepared.manifest.population};
  const configuration:LocalExperimentDefinition["configuration"]={operationId:request.operationId,expectedRevision:0,
    request:runRequest,maximumCostUsd:request.maximumCostUsd};
  await input.resolve(configuration,value);
  return PreparedHarnessExperimentSchema.parse({request:runRequest,manifest:prepared.manifest,maximumCostUsd:request.maximumCostUsd,graders:localPackageGraders(value)});
}
