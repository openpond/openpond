import { contentHash } from "@openpond/harness";
import type { HarnessWorkspace } from "@openpond/contracts";
import type { StandaloneHarnessExperimentSource } from "@openpond/evals/experiments";
import { createTrainingClient } from "openpond-sdk/training";
import { hostedApiAuthHeaders } from "../openpond/hosted-api-access.js";
import { LocalExperimentError } from "./local-experiment-contract.js";

/** Reauthorize a cached remote closure using the existing published source
 * store. Persisted owner scope and current authenticated access must agree;
 * neither cache presence nor a caller-supplied hash grants source permission. */
export function createLocalExperimentRemoteSourceLookup(deps: {
  resolveAccess(): Promise<{ apiBaseUrl: string; token: string; teamId: string; actorId: string }>;
  fetch?: typeof fetch;
}) {
  return async (workspace: HarnessWorkspace, reference: {id:string;contentHash:string}) => {
    const access = await deps.resolveAccess();
    const own = workspace.ownerScope;
    if ((own.kind === "team" && own.id !== access.teamId) || (own.kind === "personal" && own.id !== access.actorId))
      throw new LocalExperimentError("local_harness_origin_access_denied", "The cached Harness belongs to a different account or workspace.", 403);
    const headers = hostedApiAuthHeaders(access.token);
    headers.set("x-openpond-team-id", access.teamId);
    const source = await createTrainingClient({ baseUrl: access.apiBaseUrl, headers, fetch: deps.fetch }).getHarnessSource(reference);
    if (source.harnessRelease.id!==reference.id||source.harnessRelease.contentHash!==reference.contentHash)
      throw new LocalExperimentError("local_harness_authorized_source_conflict","The authorized source differs from its original published release.",409);
    return {harnessRelease:reference,agentSnapshot:{id:source.agentSnapshot.id,contentHash:source.agentSnapshot.contentHash},sourcePackageHash:source.contentHash};
  };
}

export function createLocalExperimentRemoteSourceAuthority(deps:Parameters<typeof createLocalExperimentRemoteSourceLookup>[0]) {
  const resolve=createLocalExperimentRemoteSourceLookup(deps);
  return async(reference:StandaloneHarnessExperimentSource,workspace:HarnessWorkspace)=> {
    const original=await resolve(workspace,reference.harnessRelease);
    if(contentHash(original)!==contentHash(reference))throw new LocalExperimentError("local_harness_authorized_source_conflict","The authorized published source differs from this immutable Harness closure.",409);
  };
}
