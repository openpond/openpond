import { readFile } from "node:fs/promises";
import path from "node:path";
import { contentHash, createHarnessSourcePackage, createHarnessSourceRuntime, type HarnessSourcePackage } from "@openpond/harness";
import { StandaloneHarnessExperimentSourceSchema, type StandaloneHarnessExperimentSource } from "@openpond/evals/experiments";
import type { HarnessStateStore } from "../store/harness-state-store.js";
import type { HarnessWorkspace } from "@openpond/contracts";
import { loadSelectedLocalHarnessRuntime, loadLocalHarnessRuntimeFromRelease, type SelectedLocalHarnessRuntime } from "./local-harness-skill-runtime.js";
import { standaloneExperimentToolDeclarations } from "./standalone-experiment-tools.js";

/** Resolve an owner-accessible immutable closure without moving the personal
 * current channel or attaching an incidental Profile to the Experiment. */
export async function resolveStandaloneExperimentSource(input: {
  store: HarnessStateStore;
  source: StandaloneHarnessExperimentSource;
  authorizeWorkspace?: (source: StandaloneHarnessExperimentSource, workspace: HarnessWorkspace) => Promise<void>;
}): Promise<{ runtime: SelectedLocalHarnessRuntime; sourcePackage: HarnessSourcePackage }> {
  const source = StandaloneHarnessExperimentSourceSchema.parse(input.source);
  let runtime:SelectedLocalHarnessRuntime|null;
  if(input.authorizeWorkspace) {
    const release=await input.store.getHarnessReleaseRecord(source.harnessRelease.contentHash);
    const workspace=release&&await input.store.getHarnessWorkspace(release.workspaceId);
    if(!release||!workspace||release.harnessRelease.id!==source.harnessRelease.id)throw new Error("The selected immutable Harness has no persisted owning workspace.");
    await input.authorizeWorkspace(source,workspace);
    runtime=await loadLocalHarnessRuntimeFromRelease({workspace,release});
  } else runtime=await loadSelectedLocalHarnessRuntime(input.store, source.harnessRelease);
  if (!runtime) throw new Error("The selected immutable Harness is unavailable.");
  const release = runtime.release;
  if (contentHash(source.agentSnapshot) !== contentHash({
    id: release.agentSnapshot.id, contentHash: release.agentSnapshot.contentHash,
  })) throw new Error("The selected Harness differs from its admitted Agent snapshot.");
  const root = path.join(release.bundlePath, "source");
  const files = new Map<string, Uint8Array>();
  for (const asset of release.harnessRelease.files) {
    files.set(asset.path, await readFile(path.join(root, ...asset.path.split("/"))));
  }
  const sourcePackage = createHarnessSourcePackage({
    agentSnapshot: release.agentSnapshot, harnessRelease: release.harnessRelease, files,
  });
  if (sourcePackage.contentHash !== source.sourcePackageHash) {
    throw new Error("The selected Harness source bytes differ from the admitted package.");
  }
  const declarations = standaloneExperimentToolDeclarations(release);
  // The shared runtime validates the actual program protocol, dependencies,
  // subagent programs and policy-visible instruction/Skill closure. Matching
  // release hashes alone must not admit a program this native adapter cannot run.
  createHarnessSourceRuntime({
    sourcePackage, expectedRelease: source.harnessRelease,
    baseSystemPrompt: "", runtimeId: "openpond.native-standalone-experiment.v1",
    tools: declarations.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema,
      definition: { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } } })),
    maxContextCharacters: 262_144,
  });
  return { runtime, sourcePackage };
}
