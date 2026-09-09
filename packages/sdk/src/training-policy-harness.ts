import {
  canonicalJson, contentHash, createAgentSnapshot, createHarnessRelease,
  type AgentSnapshot, type HarnessRelease, type ImmutableAssetRef,
  type ImmutableReleaseRef, type ToolDeclaration,
} from "@openpond/harness";

/** Compile immutable Agent-loop dependencies for local and hosted callers.
 * The protocol and asset identities preserve existing approved training Runs.
 * Taskset environment, tools and graders are bound separately in the bundle.
 * Callers resolve source/assets before entering this pure compilation boundary.
 */
export function createPolicyHarnessContext(input: {
  sourceRelease: ImmutableReleaseRef | null;
  profileHead?: string | null;
  skills?: ImmutableAssetRef[];
  agents?: ImmutableAssetRef[];
}): { agentSnapshot: AgentSnapshot; harnessRelease: HarnessRelease } {
  const sourceRelease = input.sourceRelease;
  const harnessTools: ToolDeclaration[] = [];
  const skills = input.skills ?? [];
  const agents = input.agents ?? [];
  if ([...skills, ...agents].some(entry => entry.visibility !== "policy")) {
    throw new Error("The portable policy Harness requires policy-visible dependencies.");
  }
  const dependencyLock = asset({
    id: "desktop-dependency-lock",
    path: ".openpond/harness/dependency-lock.json",
    hashInput: {
      profileHead: input.profileHead ?? null,
      sourceRelease,
      tools: harnessTools,
      skills: skills.map(({ id, contentHash: assetHash }) => ({ id, contentHash: assetHash })),
      agents: agents.map(({ id, contentHash: assetHash }) => ({ id, contentHash: assetHash })),
    },
    mediaType: "application/json",
    visibility: "policy",
  });
  const agentSnapshot = createAgentSnapshot({
    schemaVersion: "openpond.agentSnapshot.v2",
    id: `agent-snapshot-${contentHash([sourceRelease, harnessTools, dependencyLock.contentHash]).slice(0, 24)}`,
    sourceRelease,
    instructions: [],
    skills,
    agents,
    toolDeclarations: harnessTools,
    capabilityRequirements: [],
    dependencyLock,
    portability: {
      portable: true,
      blockers: [],
      localOnlyAssetRefs: [],
      hostPrivateAssetRefs: [],
    },
    metadata: { sourceReleaseId: sourceRelease?.id ?? null },
  });
  const program = asset({
    id: "desktop-harness-program",
    path: ".openpond/harness/program.json",
    hashInput: { program: "openpond.desktop-agent-loop.v1" },
    mediaType: "application/json",
    visibility: "policy",
  });
  const harnessRelease = createHarnessRelease({
    schemaVersion: "openpond.harnessRelease.v2",
    id: `harness-${contentHash([agentSnapshot.contentHash, program.contentHash, harnessTools]).slice(0, 24)}`,
    agentSnapshot: { id: agentSnapshot.id, contentHash: agentSnapshot.contentHash },
    program,
    tools: harnessTools,
    lifecycle: {
      create: true,
      reset: true,
      step: true,
      collect: true,
      destroy: true,
      resetScope: "attempt",
    },
    graderInterface: {
      visibleEvidence: ["output", "runtime_events", "artifacts"],
      privilegedEvidence: ["expected_output", "private_verifier"],
      privateVerifierIsolation: true,
    },
    files: [...skills, ...agents],
    metadata: { runtimeProtocol: "openpond.desktop-agent-loop.v1" },
  });
  return { agentSnapshot, harnessRelease };
}

function asset(input: {
  id: string;
  path: string;
  hashInput: unknown;
  mediaType: string;
  visibility: ImmutableAssetRef["visibility"];
}): ImmutableAssetRef {
  const bytes = canonicalJson(input.hashInput);
  return {
    id: input.id,
    path: input.path,
    contentHash: contentHash(input.hashInput),
    sizeBytes: new TextEncoder().encode(bytes).byteLength,
    mediaType: input.mediaType,
    visibility: input.visibility,
  };
}
