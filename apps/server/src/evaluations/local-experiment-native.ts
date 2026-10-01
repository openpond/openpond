import type { StandaloneHarnessExperimentSource } from "@openpond/evals/experiments";
import type { LocalExperimentDefinition } from "./local-experiment-contract.js";
import { LocalExperimentError } from "./local-experiment-contract.js";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import { createStandaloneExperimentTurnOwner } from "../harness/standalone-experiment-turn-owner.js";
import { resolveStandaloneExperimentSource } from "../harness/standalone-experiment-source.js";
import { standaloneExperimentToolDeclarations } from "../harness/standalone-experiment-tools.js";
import { authorizeLocalExperimentSource } from "./local-experiment-source-authority.js";

/** Trusted server-only injection. The factory below admits persisted source
 * authority, exact native execution and the local owner's durable stream. */
export type QualifiedLocalNativeHarness = {
  qualified: true;
  resolve(source: StandaloneHarnessExperimentSource): Promise<void>;
  execute: ReturnType<typeof createStandaloneExperimentTurnOwner>["execute"];
};

export async function admitLocalNativeHarness(
  policy: LocalExperimentDefinition["configuration"]["request"]["policy"],
  owner: QualifiedLocalNativeHarness | undefined,
): Promise<boolean> {
  if (policy.kind !== "hosted_chat" || !policy.harness) return false;
  if (owner?.qualified !== true) throw new LocalExperimentError("local_harness_not_qualified",
    "This released Harness requires a qualified native execution owner; it cannot run as a model-only case.",422);
  if (policy.messages?.length) throw new LocalExperimentError("local_harness_prompt_not_qualified",
    "Standalone Harness cases use released instructions. Additional raw model messages are not admitted.",422);
  await owner.resolve(policy.harness);
  return true;
}

/** This factory uses the ordinary native owner, never the unrestricted chat
 * stream. The local service supplies its SQLite-budgeted dispatch callback. */
export function createLocalNativeExperimentOwner(deps: Parameters<typeof createStandaloneExperimentTurnOwner>[0] & {
  store: HarnessStateStore; actorId(): Promise<string>; teamId(): Promise<string>;
  authorizeRemote?:Parameters<typeof authorizeLocalExperimentSource>[0]["authorizeRemote"];
}) {
  const authorizeWorkspace:NonNullable<Parameters<typeof createStandaloneExperimentTurnOwner>[0]["authorizeWorkspace"]>=async(source,workspace)=> {
    const authorized=await authorizeLocalExperimentSource({store:deps.store,source,authorizeRemote:deps.authorizeRemote});
    if(authorized.id!==workspace.id)throw new LocalExperimentError("local_harness_origin_access_denied","The source owning workspace changed during admission.",403);
  };
  const owner = createStandaloneExperimentTurnOwner({...deps,authorizeWorkspace});
  async function resolve(source: StandaloneHarnessExperimentSource) {
    const actor = await deps.actorId(), team = await deps.teamId();
    if (!actor.trim() || !team.trim()) throw new LocalExperimentError("local_account_required", "Sign in and select a workspace before using a native Harness.", 403);
    await authorizeLocalExperimentSource({ store: deps.store, source,authorizeRemote:deps.authorizeRemote });
    const resolved = await resolveStandaloneExperimentSource({ store: deps.store, source,authorizeWorkspace });
    standaloneExperimentToolDeclarations(resolved.runtime.release);
    if (await deps.actorId() !== actor || await deps.teamId() !== team)
      throw new LocalExperimentError("local_workspace_denied", "The signed-in account or workspace changed during native source admission.", 403);
  }
  const native: QualifiedLocalNativeHarness = { qualified: true, resolve, execute: async input => {
    await resolve(input.source);
    return owner.execute(input);
  } };
  return { native, resolveSessionModelStream: owner.resolveSessionModelStream };
}
