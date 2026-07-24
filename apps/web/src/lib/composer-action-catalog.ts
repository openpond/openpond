import type { SandboxActionCatalogEntry } from "./sandbox-types";
import { isGenericChatLabel, shortProfileAgentLabel } from "./profile-agent-labels";

const PROFILE_ACTION_TYPE = "openpond-profile-action";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function profileChatActionAgentLabel(action: SandboxActionCatalogEntry): string | null {
  const implementation = asRecord(action.implementation);
  if (implementation?.type !== PROFILE_ACTION_TYPE) return null;
  const actionId = text(implementation.actionId) ?? action.id;
  if (action.sourceActionId !== "chat" && actionId !== "chat" && !actionId.endsWith(".chat")) {
    return null;
  }
  const label = text(action.label);
  if (label && !isGenericChatLabel(label)) return shortProfileAgentLabel({ label, description: action.description });
  const agentName = text(implementation.agentName) ?? text(action.name);
  return shortProfileAgentLabel({
    actionId,
    description: action.description,
    name: agentName,
  });
}

export function composerActionSlashQuery(prompt: string): string | null {
  if (!prompt.startsWith("/")) return null;
  return prompt.slice(1).trim().toLowerCase();
}

export function composerActionCatalogLabel(
  action: SandboxActionCatalogEntry,
): string {
  const profileAgentLabel = profileChatActionAgentLabel(action);
  if (profileAgentLabel) return profileAgentLabel;
  return action.label?.trim() || action.name?.trim() || action.id;
}

export function composerActionCatalogHint(
  action: SandboxActionCatalogEntry,
): string {
  const implementationType =
    typeof action.implementation?.type === "string"
      ? action.implementation.type
      : null;
  if (implementationType === "openpond-agent") return "OpenPond Agent";
  if (
    implementationType === "openpond-profile-action" &&
    (action.sourceActionId === "chat" || action.id === "chat" || action.id.endsWith(".chat"))
  ) {
    return "Profile agent";
  }
  if (implementationType === "workflow") return "Workflow-backed action";
  if (implementationType === "agent") return "Agent-backed action";
  if (implementationType === "remote-agent") return "Remote-agent action";
  if (implementationType === "chat" || implementationType === "intent-router") {
    return "Chat action";
  }
  return action.id;
}

export function composerActionCatalogMatches({
  actions,
  prompt,
  limit = 8,
}: {
  actions: SandboxActionCatalogEntry[];
  prompt: string;
  limit?: number;
}): SandboxActionCatalogEntry[] {
  const query = composerActionSlashQuery(prompt);
  if (query === null || actions.length === 0) return [];
  return actions
    .filter((action) => {
      if (!query) return true;
      return [
        action.id,
        action.name ?? "",
        action.label ?? "",
        action.description ?? "",
        text(action.implementation?.actionId) ?? "",
        text(action.implementation?.agentName) ?? "",
        typeof action.implementation?.type === "string"
          ? action.implementation.type
          : "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .slice(0, limit);
}
