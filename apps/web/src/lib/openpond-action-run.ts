import type { ChatAttachment } from "@openpond/contracts";
import type {
  SandboxActionCatalogEntry,
  SandboxAgent,
  SandboxAgentSelectedEntrypoint,
  SandboxWorkflowMode,
} from "./sandbox-types";

const OPENPOND_AGENT_COMMAND_TYPE = "openpond-agent";
const OPENPOND_PROFILE_ACTION_TYPE = "openpond-profile-action";

export type OpenPondAgentSlashCommandInfo = {
  agentId: string;
  agentName: string;
  teamId: string;
  projectId: string;
  projectName: string | null;
  selectedEntrypoint: SandboxAgentSelectedEntrypoint;
  workflowMode: SandboxWorkflowMode;
};

export type OpenPondProfileActionInfo = {
  actionId: string;
  actionLabel: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function selectedByForPrompt(input: { displayPrompt?: string | null; prompt: string }): "mention" | "slash" {
  if (input.displayPrompt && input.displayPrompt !== input.prompt && /(?:^|\s)@[A-Za-z0-9_-]+/.test(input.displayPrompt)) {
    return "mention";
  }
  return "slash";
}

function selectedEntrypoint(value: unknown): SandboxAgentSelectedEntrypoint | null {
  const record = asRecord(value);
  const scope = text(record?.scope);
  if (
    scope !== "entire_manifest" &&
    scope !== "start" &&
    scope !== "action" &&
    scope !== "service" &&
    scope !== "schedule"
  ) {
    return null;
  }
  return {
    scope,
    name: text(record?.name),
  };
}

function workflowMode(value: unknown): SandboxWorkflowMode | null {
  const mode = text(value);
  if (
    mode !== "readonly" &&
    mode !== "attempt" &&
    mode !== "feature" &&
    mode !== "rollout" &&
    mode !== "replay" &&
    mode !== "template_build" &&
    mode !== "scheduled_run" &&
    mode !== "patch_only" &&
    mode !== "hotfix" &&
    mode !== "multi_feature_batch"
  ) {
    return null;
  }
  return mode;
}

export function buildOpenPondAgentSlashCommand(
  agent: SandboxAgent,
  projectName: string | null = null,
): SandboxActionCatalogEntry {
  return {
    id: `agent:${agent.id}`,
    name: agent.slug || agent.name,
    label: agent.name,
    description: agent.description || (projectName ? `Agent for ${projectName}` : "OpenPond Agent"),
    visibility: "default",
    inputSchema: null,
    outputSchema: null,
    implementation: {
      type: OPENPOND_AGENT_COMMAND_TYPE,
      agentId: agent.id,
      agentName: agent.name,
      teamId: agent.teamId,
      projectId: agent.projectId,
      projectName,
      selectedEntrypoint: agent.selectedEntrypoint,
      workflowMode: agent.defaultWorkflowMode,
    },
    mcp: null,
    invokesModel: true,
  };
}

export function openPondAgentSlashCommandInfo(
  action: SandboxActionCatalogEntry,
): OpenPondAgentSlashCommandInfo | null {
  const implementation = asRecord(action.implementation);
  if (implementation?.type !== OPENPOND_AGENT_COMMAND_TYPE) return null;
  const agentId = text(implementation.agentId);
  const teamId = text(implementation.teamId);
  const projectId = text(implementation.projectId);
  const entrypoint = selectedEntrypoint(implementation.selectedEntrypoint);
  const mode = workflowMode(implementation.workflowMode);
  if (!agentId || !teamId || !projectId || !entrypoint || !mode) return null;
  return {
    agentId,
    agentName: text(implementation.agentName) ?? action.label ?? action.name ?? action.id,
    teamId,
    projectId,
    projectName: text(implementation.projectName),
    selectedEntrypoint: entrypoint,
    workflowMode: mode,
  };
}

export function buildOpenPondProfileActionCommand(
  action: SandboxActionCatalogEntry,
): SandboxActionCatalogEntry {
  return {
    ...action,
    implementation: {
      ...(asRecord(action.implementation) ?? {}),
      type: OPENPOND_PROFILE_ACTION_TYPE,
      actionId: action.id,
    },
    invokesModel: action.invokesModel ?? true,
  };
}

export function openPondProfileActionInfo(
  action: SandboxActionCatalogEntry,
): OpenPondProfileActionInfo | null {
  const implementation = asRecord(action.implementation);
  if (implementation?.type !== OPENPOND_PROFILE_ACTION_TYPE) return null;
  const actionId = text(implementation.actionId) ?? action.id;
  if (!actionId) return null;
  return {
    actionId,
    actionLabel: action.label ?? action.name ?? actionId,
  };
}

export function buildOpenPondProfileActionRunInput({
  action,
  attachments = [],
  displayPrompt,
  prompt,
  sessionId,
}: {
  action: OpenPondProfileActionInfo;
  attachments?: ChatAttachment[];
  displayPrompt?: string | null;
  prompt: string;
  sessionId?: string | null;
}) {
  return {
    action: action.actionId,
    input: {
      prompt,
      message: prompt,
      source: "openpond_app",
      ...(attachments.length > 0 ? { attachments } : {}),
    },
    metadata: {
        source: "openpond_app",
        selectedActionId: action.actionId,
        selectedActionLabel: action.actionLabel,
        selectedBy: selectedByForPrompt({ displayPrompt, prompt }),
        ...(displayPrompt && displayPrompt !== prompt ? { displayPrompt } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    };
}

export function buildOpenPondAppActionRunInput({
  action,
  attachments = [],
  prompt,
  teamId,
}: {
  action: SandboxActionCatalogEntry;
  attachments?: ChatAttachment[];
  prompt: string;
  teamId: string;
}) {
  return {
    teamId,
    triggerType: "manual" as const,
    entrypoint: { scope: "action" as const, name: action.id },
    input: {
      prompt,
      message: prompt,
      actionName: action.id,
      source: "openpond_app",
      ...(attachments.length > 0 ? { attachments } : {}),
    },
    metadata: {
      source: "openpond_app",
      selectedActionId: action.id,
      selectedActionLabel: action.label ?? action.name ?? action.id,
      selectedBy: "slash",
    },
  };
}

export function buildOpenPondAgentRunInput({
  agent,
  attachments = [],
  prompt,
}: {
  agent: OpenPondAgentSlashCommandInfo;
  attachments?: ChatAttachment[];
  prompt: string;
}) {
  return {
    teamId: agent.teamId,
    triggerType: "manual" as const,
    entrypoint: agent.selectedEntrypoint,
    input: {
      prompt,
      message: prompt,
      source: "openpond_app",
      ...(attachments.length > 0 ? { attachments } : {}),
    },
    metadata: {
      source: "openpond_app",
      selectedAgentId: agent.agentId,
      selectedAgentName: agent.agentName,
      selectedActionId: `agent:${agent.agentId}`,
      selectedActionLabel: agent.agentName,
      selectedBy: "slash",
    },
    workflowMode: agent.workflowMode,
  };
}
