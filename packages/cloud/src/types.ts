export type ResponseItem = {
  type: string;
  [key: string]: unknown;
};

export type ResponseMessageItem = ResponseItem & {
  type: "message";
  role: "user" | "assistant" | "system";
  content: Array<{ type: "markdown" | "text" | "json"; text: string }>;
};

export type ToolCallItem = ResponseItem & {
  type: "tool_call";
  callId?: string;
  name: string;
  args?: Record<string, unknown>;
};

export type ToolOutputItem = ResponseItem & {
  type: "tool_output";
  callId?: string;
  name?: string;
  ok: boolean;
  output?: unknown;
  error?: string;
};

export type UsageInfo = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type TemplateBootstrap = {
  name?: string;
  description?: string;
  templateRepoUrl?: string;
  templateBranch?: string;
  envVars?: Record<string, string>;
};

export type ChatRequestBody = {
  input: ResponseItem[];
  mode: "general" | "builder";
  executionMode?: "local" | "hosted";
  conversationId?: string | null;
  appId?: string | null;
  template?: TemplateBootstrap;
  streamDeployLogs?: boolean;
  userId?: string;
  teamId?: string;
  action?: "tool_result";
  toolResult?: {
    toolName: string;
    callId?: string;
    output?: unknown;
    ok?: boolean;
    error?: string;
  };
};
