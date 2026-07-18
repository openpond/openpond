import type { BootstrapPayload } from "@openpond/contracts";
import type { SandboxActionCatalogEntry } from "./sandbox-types";

const LOCAL_PROFILE_AGENT_IMPLEMENTATION = "local-profile-agent";

type ProfileState = NonNullable<BootstrapPayload["profile"]>;

export function teamChatActionCatalogWithProfileAgents(input: {
  hostedActions: SandboxActionCatalogEntry[];
  profile: BootstrapPayload["profile"] | null | undefined;
  teamId: string | null;
}): SandboxActionCatalogEntry[] {
  const profile = input.profile;
  if (!profile || profile.mode !== "local") return input.hostedActions;

  const hostedNames = new Set(
    input.hostedActions.flatMap((action) => {
      const implementation = action.implementation;
      if (
        implementation?.type !== "openpond-agent" ||
        implementation.profileName !== profile.activeProfile
      ) {
        return [];
      }
      return [
        normalizedAgentName(implementation.agentName),
        normalizedAgentName(action.name),
        normalizedAgentName(action.label),
      ].filter(Boolean);
    }),
  );
  const lastMaterialization =
    profile.hosted?.teamId === input.teamId
      ? profile.hosted.hostedSourceMaterialization
      : null;
  const hostedRuntimeAgentIds = new Set(
    input.hostedActions
      .map((action) => action.implementation?.agentId)
      .filter((value): value is string => typeof value === "string"),
  );

  const localActions = profile.agents.flatMap((agent) => {
    if (!agent.enabled) return [];
    const materializedHere =
      lastMaterialization?.agentId === agent.id &&
      Boolean(
        lastMaterialization.runtimeAgentId &&
          hostedRuntimeAgentIds.has(lastMaterialization.runtimeAgentId),
      );
    if (
      materializedHere ||
      hostedNames.has(normalizedAgentName(agent.name)) ||
      hostedNames.has(normalizedAgentName(agent.id))
    ) {
      return [];
    }
    return [localProfileAgentAction(profile, agent)];
  });

  return [...input.hostedActions, ...localActions];
}

export function isLocalTeamProfileAgentAction(
  action: SandboxActionCatalogEntry | null | undefined,
): action is SandboxActionCatalogEntry {
  return action?.implementation?.type === LOCAL_PROFILE_AGENT_IMPLEMENTATION;
}

export function localTeamProfileAgentId(
  action: SandboxActionCatalogEntry,
): string | null {
  const value = action.implementation?.profileAgentId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function teamProfileAgentPublicationError(
  profile: BootstrapPayload["profile"] | null | undefined,
  agentId: string,
): string | null {
  if (!profile || profile.mode !== "local") {
    return "Load a local OpenPond profile before publishing an agent to Team.";
  }
  const agent = profile.agents.find((candidate) => candidate.id === agentId);
  if (!agent) return `Profile agent not found: ${agentId}`;
  if (!agent.enabled) return `${agent.name} is disabled in the active profile.`;
  if (!profile.git?.head) {
    return `Commit ${agent.name} before publishing it to Team.`;
  }
  if (profile.git.dirty) {
    return `Commit your profile changes before publishing ${agent.name} to Team.`;
  }
  if (profile.setupGate.blockingCount > 0) {
    return `${agent.name} has ${profile.setupGate.blockingCount} blocking setup requirement${
      profile.setupGate.blockingCount === 1 ? "" : "s"
    }. Complete setup before publishing it to Team.`;
  }
  return null;
}

export function hostedTeamActionForProfileAgent(
  actions: SandboxActionCatalogEntry[],
  input: {
    runtimeAgentId?: string | null;
    profileName?: string | null;
    agentName?: string | null;
  },
): SandboxActionCatalogEntry | null {
  const runtimeAgentId = input.runtimeAgentId?.trim() ?? "";
  const profileName = input.profileName?.trim() ?? "";
  const agentName = normalizedAgentName(input.agentName);

  return (
    actions.find((action) => {
      const implementation = action.implementation;
      if (implementation?.type !== "openpond-agent") return false;
      if (
        runtimeAgentId &&
        typeof implementation.agentId === "string" &&
        implementation.agentId === runtimeAgentId
      ) {
        return true;
      }
      return Boolean(
        profileName &&
          implementation.profileName === profileName &&
          agentName &&
          [
            implementation.agentName,
            action.name,
            action.label,
          ].some((value) => normalizedAgentName(value) === agentName),
      );
    }) ?? null
  );
}

function localProfileAgentAction(
  profile: ProfileState,
  agent: ProfileState["agents"][number],
): SandboxActionCatalogEntry {
  return {
    id: `local-profile:${profile.activeProfile ?? "default"}:${agent.id}:chat`,
    name: agent.name,
    label: agent.name,
    description: localProfileAgentDescription(profile),
    approvalPolicy: {
      required: false,
      risk: "write",
    },
    setupRequirements: profile.setupGate.blockingRequirements,
    invokesModel: true,
    implementation: {
      type: LOCAL_PROFILE_AGENT_IMPLEMENTATION,
      profileAgentId: agent.id,
      profileName: profile.activeProfile ?? "default",
    },
  };
}

function localProfileAgentDescription(profile: ProfileState): string {
  if (!profile.git?.head) {
    return "My Agent · Commit the profile before publishing to this Team";
  }
  if (profile.git.dirty) {
    return "My Agent · Commit profile changes before publishing to this Team";
  }
  if (profile.setupGate.blockingCount > 0) {
    return "My Agent · Complete required setup before publishing to this Team";
  }
  return "My Agent · Publishes to this Team on first use";
}

function normalizedAgentName(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")
    : "";
}
