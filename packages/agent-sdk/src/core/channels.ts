import type {
  AgentChannelId,
  AgentChatInput,
  AgentChatResult,
  AgentProjectDefinition,
  ChannelDefinition,
} from "../index";

export type ChannelSetupProjection = {
  id: AgentChannelId;
  targetAction: string;
  enabledByDefault: boolean;
  requiredConnections: string[];
  capabilities: string[];
  setupRequirements: Array<{
    kind: "integration";
    name: string;
    required: true;
    satisfied: boolean;
  }>;
  setupStatus: "ready" | "missing_setup";
};

export function normalizeChannelEvent(
  project: AgentProjectDefinition,
  channelId: AgentChannelId,
  event: Record<string, unknown>,
): AgentChatInput {
  const channel = findChannel(project, channelId);
  const input = channel.normalizeEvent(event);
  assertChannelInput(channelId, input);
  return input;
}

export function renderChannelResponse(
  project: AgentProjectDefinition,
  channelId: AgentChannelId,
  result: AgentChatResult,
): Record<string, unknown> {
  return findChannel(project, channelId).renderResponse(result);
}

export function inspectChannelSetup(
  project: AgentProjectDefinition,
  channelId: AgentChannelId,
): ChannelSetupProjection {
  return projectChannelSetup(project, findChannel(project, channelId));
}

export function listChannelSetups(project: AgentProjectDefinition): ChannelSetupProjection[] {
  return (project.channels ?? []).map((channel) => projectChannelSetup(project, channel));
}

function findChannel(
  project: AgentProjectDefinition,
  channelId: AgentChannelId,
): ChannelDefinition {
  const channel = (project.channels ?? []).find((candidate) => candidate.id === channelId);
  if (!channel) throw new Error(`Unknown channel: ${channelId}`);
  return channel;
}

function projectChannelSetup(
  project: AgentProjectDefinition,
  channel: ChannelDefinition,
): ChannelSetupProjection {
  const requiredConnections = channel.requiredConnections ?? [];
  const setupRequirements = requiredConnections.map((connection) => ({
    kind: "integration" as const,
    name: connection,
    required: true as const,
    satisfied: (project.integrations ?? []).some((integration) => integration.provider === connection),
  }));
  return {
    id: channel.id,
    targetAction: channel.target.action,
    enabledByDefault: channel.enabledByDefault ?? false,
    requiredConnections,
    capabilities: channel.capabilities ?? [],
    setupRequirements,
    setupStatus: setupRequirements.every((requirement) => requirement.satisfied)
      ? "ready"
      : "missing_setup",
  };
}

function assertChannelInput(channelId: AgentChannelId, input: AgentChatInput) {
  if (!input || typeof input !== "object") {
    throw new Error(`Channel ${channelId} normalizeEvent must return an AgentChatInput object.`);
  }
  if (typeof input.prompt !== "string") {
    throw new Error(`Channel ${channelId} normalizeEvent must return a string prompt.`);
  }
  if (input.channel !== channelId) {
    throw new Error(`Channel ${channelId} normalizeEvent returned channel ${input.channel}.`);
  }
}
