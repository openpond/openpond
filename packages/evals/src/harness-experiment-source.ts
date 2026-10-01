import { z } from "zod";
import { contentHash, ImmutableReleaseRefSchema, ReleaseHashSchema, type AgentSnapshot, type HarnessRelease, type ToolDeclaration } from "@openpond/harness";

/** A standalone Agent/Harness closure has no incidental Profile binding.
 * The execution host resolves and verifies these exact published bytes. */
export const StandaloneHarnessExperimentSourceSchema = z.object({
  harnessRelease: ImmutableReleaseRefSchema,
  agentSnapshot: ImmutableReleaseRefSchema,
  sourcePackageHash: ReleaseHashSchema,
}).strict();
export type StandaloneHarnessExperimentSource = z.infer<typeof StandaloneHarnessExperimentSourceSchema>;
export const STANDALONE_EXPERIMENT_MAX_POLICY_CALLS = 64;

export function harnessExperimentSourceRequiresProfile(source: { agentSnapshot: AgentSnapshot; harnessRelease: HarnessRelease }): boolean {
  return [source.agentSnapshot.metadata, source.harnessRelease.metadata].some(metadata =>
    typeof metadata.profileRepositoryId === "string" || metadata.profile !== undefined && metadata.profile !== null);
}

/** Qualified case-local implementations read this immutable closure or its
 * retained context. Other capabilities need an independently admitted world. */
export const STANDALONE_EXPERIMENT_READ_TOOLS: ReadonlySet<string> = new Set([
  "harness_inspect", "skill_inspect", "profile_skill_read", "context_read",
]);

export function standaloneHarnessExperimentTools(source: {
  agentSnapshot: AgentSnapshot;
  harnessRelease: HarnessRelease;
}): ToolDeclaration[] {
  if (harnessExperimentSourceRequiresProfile(source))
    throw new Error("This source is bound to a Profile; select Model + Harness + Profile.");
  return harnessExperimentReadToolDeclarations(source);
}

/** Profile-owned callers must establish exact Profile authority first. This
 * function qualifies only tools; it does not grant source or Profile access. */
export function harnessExperimentReadToolDeclarations(source: {
  agentSnapshot: AgentSnapshot;
  harnessRelease: HarnessRelease;
}): ToolDeclaration[] {
  const required = source.agentSnapshot.capabilityRequirements.find(capability => capability.required);
  if (required) throw new Error(`Standalone Harness capability requires an admitted case environment: ${required.id}.`);
  const declarations = new Map<string, ToolDeclaration>();
  for (const declaration of [...source.agentSnapshot.toolDeclarations, ...source.harnessRelease.tools]) {
    if (!STANDALONE_EXPERIMENT_READ_TOOLS.has(declaration.name) || declaration.sideEffect !== "read")
      throw new Error(`Standalone Harness tool requires an admitted case environment: ${declaration.name}.`);
    if (contentHash(declaration.inputSchema) !== declaration.inputSchemaHash)
      throw new Error(`Standalone Harness tool schema differs from its declaration: ${declaration.name}.`);
    const prior = declarations.get(declaration.name);
    if (prior && contentHash(prior) !== contentHash(declaration))
      throw new Error(`Standalone Harness has conflicting tool declarations: ${declaration.name}.`);
    declarations.set(declaration.name, declaration);
  }
  return [...declarations.values()];
}
