import type {
  ActionDefinition,
  ActionImplementationDefinition,
  AgentChatInput,
  LocalAgentDefinition,
  RemoteAgentReferenceDefinition,
  ToolDefinition,
  WorkflowDefinition,
} from "../index";

export function workflowName(workflow: WorkflowDefinition | string): string {
  return typeof workflow === "string" ? workflow : workflow.name;
}

export function localAgentId(agent: LocalAgentDefinition | string): string {
  return typeof agent === "string" ? agent : agent.id;
}

export function remoteAgentId(agent: RemoteAgentReferenceDefinition | string): string {
  return typeof agent === "string" ? agent : agent.id;
}

export function toolName(tool: ToolDefinition | string): string {
  return typeof tool === "string" ? tool : tool.name;
}

export function actionId(action: ActionDefinition): string {
  return action.id ?? action.name;
}

export function actionLabel(action: ActionDefinition): string {
  return action.label ?? titleFromId(actionId(action));
}

export function inferActionImplementation(
  action: ActionDefinition,
): ActionImplementationDefinition {
  if (action.implementation) return action.implementation;
  if (action.target.kind === "chat") {
    return { type: "chat", allowedActionIds: action.target.allowedActions };
  }
  if (action.target.kind === "workflow") {
    return { type: "workflow", workflowId: workflowName(action.target.workflow) };
  }
  if (action.target.kind === "local-agent") {
    return { type: "agent", agentId: localAgentId(action.target.agent) };
  }
  if (action.target.kind === "remote-agent") {
    return { type: "remote-agent", remoteAgentId: remoteAgentId(action.target.remoteAgent) };
  }
  if (action.target.kind === "tool") {
    return { type: "tool", toolId: toolName(action.target.tool) };
  }
  return {
    type: "intent-router",
    routerId: typeof action.target.router === "string"
      ? action.target.router
      : `${actionId(action)}-router`,
  };
}

export function schemaLabel(schema: unknown): string | null {
  if (!schema) return null;
  if (typeof schema === "string") return schema;
  if (
    typeof schema === "object" &&
    schema &&
    "description" in schema &&
    typeof schema.description === "string"
  ) {
    return schema.description;
  }
  return schema.constructor?.name ?? "schema";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isChannelId(value: unknown): value is AgentChatInput["channel"] {
  return (
    value === "openpond_chat" ||
    value === "microsoft_teams" ||
    value === "slack" ||
    value === "mcp" ||
    value === "api" ||
    value === "schedule" ||
    value === "manual"
  );
}

export function normalizeInput(input: Record<string, unknown> | undefined): AgentChatInput {
  return {
    prompt: typeof input?.prompt === "string" ? input.prompt : "",
    channel: isChannelId(input?.channel) ? input.channel : "openpond_chat",
    conversationId: typeof input?.conversationId === "string" ? input.conversationId : null,
    messageId: typeof input?.messageId === "string" ? input.messageId : null,
    threadId: typeof input?.threadId === "string" ? input.threadId : null,
    files: Array.isArray(input?.files) ? input.files as AgentChatInput["files"] : [],
    context: isRecord(input?.context) ? input.context : {},
  };
}

function titleFromId(id: string): string {
  const normalized = id.replace(/[._-]+/g, " ").trim();
  if (!normalized) return id;
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
