import { contentHash } from "@openpond/harness";
import { OpenPondTasksetPackageClient } from "openpond-sdk/taskset-packages";
import { OpenPondTrainingProjectClient } from "openpond-sdk/training-projects";
import type { LocalExperimentSaveFromReleaseSchema } from "@openpond/contracts";
import type { z } from "zod";
import { LocalExperimentError } from "./local-experiment-contract.js";

export function createLocalExperimentProjectAuthorizer(deps:{resolveAccess:()=>Promise<{apiBaseUrl:string;token:string}>;fetch?:typeof fetch}) {
  return async(configuration:z.infer<typeof LocalExperimentSaveFromReleaseSchema>["configuration"])=> {
    const request=configuration.request;if(!request.project)return;
    const access=await deps.resolveAccess();
    const project=await new OpenPondTrainingProjectClient({baseUrl:access.apiBaseUrl,apiKey:access.token,teamId:request.teamId,fetch:deps.fetch}).get(request.project.id);
    if(project.archived||project.revision!==request.project.revision||contentHash(project.content)!==request.project.contentHash)
      throw new LocalExperimentError("local_project_pin_conflict","The selected Project changed. Reload its configuration before saving or starting.",409);
    if(request.project.targetId!==null)throw new LocalExperimentError("local_project_target_not_qualified","Choose the explicit local model or prepare a local Profile target without inheriting a hosted Project target.",422);
  };
}

/** Private bytes cross directly into the evaluator server. This authenticated
 * read uses the same owner ACL as hosted execution and never returns to the UI. */
export function createLocalExperimentPackageResolver(deps: {
  resolveAccess: () => Promise<{ apiBaseUrl: string; token: string }>;
  fetch?: typeof fetch;
}) {
  return async (input: z.infer<typeof LocalExperimentSaveFromReleaseSchema>) => {
    const access = await deps.resolveAccess();
    const request = input.configuration.request;
    const options = {
      baseUrl: access.apiBaseUrl,
      apiKey: access.token,
      teamId: request.teamId,
      fetch: deps.fetch,
    };
    await createLocalExperimentProjectAuthorizer(deps)(input.configuration);
    return new OpenPondTasksetPackageClient(options).getByRelease(request.taskset, {
      expectedPackageHash: input.expectedPackageHash,
    });
  };
}
