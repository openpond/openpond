import type { z } from "zod";

export type AgentChannelId =
  | "openpond_chat"
  | "microsoft_teams"
  | "slack"
  | "mcp"
  | "api"
  | "schedule"
  | "manual";

export type AgentFileRef = {
  ref: string;
  name?: string;
  mimeType?: string;
};

export type AgentChatInput = {
  prompt: string;
  channel: AgentChannelId;
  conversationId?: string | null;
  messageId?: string | null;
  threadId?: string | null;
  files?: AgentFileRef[];
  context?: Record<string, unknown>;
};

export type AgentChatResult = {
  text: string;
  intent?: string;
  needsUserInput?: boolean;
  files?: AgentFileRef[];
  artifactRefs?: string[];
  metadata?: Record<string, unknown>;
};

export type AgentTraceEvent = {
  name: string;
  payload?: Record<string, unknown>;
  timestamp: string;
};

export type AgentTraceArtifact = {
  ref: string;
  metadata?: Record<string, unknown>;
};

export type AgentContext = {
  trace: {
    event(name: string, payload?: Record<string, unknown>): void;
    artifact(ref: string, metadata?: Record<string, unknown>): void;
    span<TResult>(
      kind: "workflow" | "step" | "model" | "tool" | "action" | "eval" | "skill",
      name: string,
      run: () => Promise<TResult>,
      payload?: Record<string, unknown>,
    ): Promise<TResult>;
  };
  step<TResult>(name: string, run: () => Promise<TResult>): Promise<TResult>;
  model<TResult>(name: string, run: () => Promise<TResult>): Promise<TResult>;
  tool<TResult>(name: string, run: () => Promise<TResult>): Promise<TResult>;
  action<TResult>(name: string, run: () => Promise<TResult>): Promise<TResult>;
  loadSkill(name: string): Promise<{ name: string; description?: string | null }>;
  runCommand(
    command: string,
    options?: Record<string, unknown>,
  ): Promise<{
    status: "succeeded" | "failed";
    stdout?: string;
    stderr?: string;
  }>;
  workflow<TInput, TResult>(name: string, input: TInput): Promise<TResult>;
};

export type AgentModelPolicyDefinition = {
  provider: "openpond-managed" | "team-binding" | "project-binding" | "byok";
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  required?: boolean;
  [key: string]: unknown;
};

export type ActionApprovalPolicyDefinition = {
  mode: "never" | "always" | "writes" | "sensitive";
  reason?: string;
};

export type ActionArtifactPolicyDefinition = {
  outputArtifacts?: string[];
  persistRunSummary?: boolean;
  persistTrace?: boolean;
};

export type ActionSetupRequirementDefinition = {
  kind:
    | "channel"
    | "connection"
    | "integration"
    | "env"
    | "volume"
    | "schedule"
    | "package"
    | "python"
    | "native_tool";
  name: string;
  required?: boolean;
  description?: string;
  command?: string;
  packageName?: string;
  version?: string;
  status?: string;
  satisfied?: boolean;
  ready?: boolean;
};

export type ActionMcpExportDefinition = {
  enabled: boolean;
  toolName?: string;
  title?: string;
  description?: string;
  scopes?: string[];
};

export type ActionSchedulePolicyDefinition = {
  enabled?: boolean;
  allowAdHoc?: boolean;
};

export type ActionTracePolicyDefinition = {
  name?: string;
  namespace?: string;
  parentActionId?: string;
};

export type ActionImplementationDefinition =
  | {
      type: "intent-router";
      routerId?: string;
    }
  | {
      type: "chat";
      allowedActionIds?: string[];
    }
  | {
      type: "workflow";
      workflowId: string;
    }
  | {
      type: "agent";
      agentId: string;
    }
  | {
      type: "tool";
      toolId: string;
    }
  | {
      type: "remote-agent";
      remoteAgentId: string;
    };

export type ActionCatalogEntry = {
  id: string;
  name: string;
  label: string;
  description: string;
  visibility: "default" | "end_user" | "internal" | "debug";
  implementation: ActionImplementationDefinition;
  inputSchema: string | null;
  outputSchema: string | null;
  approvalPolicy: ActionApprovalPolicyDefinition;
  artifactPolicy: ActionArtifactPolicyDefinition;
  setupRequirements: ActionSetupRequirementDefinition[];
  mcp: ActionMcpExportDefinition;
  schedulePolicy: ActionSchedulePolicyDefinition;
  trace: ActionTracePolicyDefinition;
  invokesModel: boolean;
};

export type IntentDefinition<TInput = AgentChatInput> = {
  kind: "intent";
  name: string;
  description: string;
  inputSchema?: z.ZodType<unknown> | string;
  when?: (input: AgentChatInput) => boolean | Promise<boolean>;
  run: (ctx: AgentContext, input: TInput) => Promise<AgentChatResult>;
};

export type IntentRouterDefinition = {
  kind: "intent-router";
  inputSchema?: z.ZodType<unknown> | string;
  intents: IntentDefinition[];
  defaultIntent: IntentDefinition;
  routing?: {
    strategy: "model" | "code" | "model-or-code";
    model?: string;
    traceSelection?: boolean;
  };
};

export type ChannelDefinition = {
  kind: "channel";
  id: AgentChannelId;
  target: { action: string };
  requiredConnections?: string[];
  capabilities?: string[];
  enabledByDefault?: boolean;
  normalizeEvent: (event: Record<string, unknown>) => AgentChatInput;
  renderResponse: (result: AgentChatResult) => Record<string, unknown>;
};

export type WorkflowDefinition = {
  kind: "workflow";
  name: string;
  description?: string;
  run: (
    ctx: AgentContext,
    input: Record<string, unknown>,
  ) => Promise<AgentChatResult>;
};

export type LocalAgentDefinition = {
  kind: "local-agent";
  id: string;
  label?: string;
  description?: string;
  instructions?: InstructionsDefinition | string;
  model?: AgentModelPolicyDefinition;
  tools?: string[];
  workflows?: string[];
  run: (ctx: AgentContext, input: AgentChatInput) => Promise<AgentChatResult>;
};

export type RemoteAgentReferenceDefinition = {
  kind: "remote-agent";
  id: string;
  description: string;
  projectId?: string;
  agentId?: string;
  url?: string;
  auth: {
    policy: "openpond-service" | "connection" | "bearer-token" | "none";
    connectionId?: string;
    env?: string;
  };
  inputSchema?: z.ZodType<unknown> | string;
  outputSchema?: z.ZodType<unknown> | string;
  trace?: {
    namespace?: string;
    linkParent?: boolean;
  };
};

export type McpClientConnectionDefinition = {
  kind: "mcp-client-connection";
  id: string;
  description?: string;
  serverUrl?: string;
  auth?: {
    policy: "none" | "openpond-oauth" | "connection" | "env-token";
    connectionId?: string;
    env?: string;
  };
  tools?: {
    allow?: string[];
    block?: string[];
  };
  approvalPolicy?: ActionApprovalPolicyDefinition;
  traceNamespace?: string;
};

export type ToolTargetDefinition = {
  kind: "action";
  action: string;
  workflow?: string;
};

export type ToolDefinition = {
  kind: "tool";
  name: string;
  description: string;
  visibility: "end_user" | "internal" | "debug";
  target: ToolTargetDefinition;
  inputSchema?: z.ZodType<unknown> | string;
  outputArtifacts?: string[];
  run?: (
    ctx: AgentContext,
    input: Record<string, unknown>,
  ) => Promise<AgentChatResult>;
};

export type EvalDefinition = {
  kind: "eval";
  name: string;
  description: string;
  fixtures?: string[];
  expectedArtifacts?: string[];
  publishGate?: boolean;
  run: (t: EvalContext) => Promise<void>;
};

export type EvalContext = {
  send(input: Partial<AgentChatInput> & { prompt: string }): Promise<AgentChatResult>;
  runAction(actionName: string, input: Partial<AgentChatInput> & { prompt: string }): Promise<AgentChatResult>;
  expectIntent(name: string): void;
  expectTextIncludes(text: string): void;
  expectArtifact(ref: string): void;
  expectTraceEvent(name: string): void;
};

export type ActionTargetDefinition =
  | {
      kind: "chat";
      instructions?: InstructionsDefinition | string;
      allowedActions?: string[];
      run?: (
        ctx: AgentContext,
        input: AgentChatInput,
        catalog: ActionCatalogEntry[],
      ) => Promise<AgentChatResult>;
    }
  | {
      kind: "intent-router";
      router: IntentRouterDefinition | string;
    }
  | {
      kind: "workflow";
      workflow: WorkflowDefinition | string;
    }
  | {
      kind: "local-agent";
      agent: LocalAgentDefinition | string;
    }
  | {
      kind: "remote-agent";
      remoteAgent: RemoteAgentReferenceDefinition | string;
    }
  | {
      kind: "tool";
      tool: ToolDefinition | string;
    };

export type JsonSchema = Record<string, unknown>;

export type ActionDefinition = {
  id?: string;
  name: string;
  label?: string;
  description?: string;
  target: ActionTargetDefinition;
  visibility?: "default" | "end_user" | "internal" | "debug";
  timeoutSeconds?: number;
  inputSchema?: z.ZodType<unknown> | string;
  outputSchema?: z.ZodType<unknown> | string;
  outputArtifacts?: string[];
  approval?: ActionApprovalPolicyDefinition;
  artifacts?: ActionArtifactPolicyDefinition;
  setup?: ActionSetupRequirementDefinition[];
  mcp?: ActionMcpExportDefinition;
  schedule?: ActionSchedulePolicyDefinition;
  trace?: ActionTracePolicyDefinition;
  implementation?: ActionImplementationDefinition;
  model?: AgentModelPolicyDefinition;
};

export type VolumeProvisioningPolicy = {
  mode: "create" | "select" | "select-or-create";
  scope: "project" | "workspace" | "user" | "organization";
  selector?: {
    kind: "project-volume" | "workspace-volume" | "input";
    name?: string;
    inputName?: string;
    labels?: Record<string, string>;
  };
  create?: {
    storageGb: number;
    retention: "delete-with-sandbox" | "retain";
  };
  ui?: {
    label: string;
    description?: string;
    allowUpload?: boolean;
    required?: boolean;
  };
};

export type VolumeStatePolicy = {
  engine: "filesystem" | "sqlite";
  files?: string[];
  concurrency?: "single-writer-per-agent-run" | "read-only" | "runtime-managed-lock";
};

export type VolumeDefinition = {
  name: string;
  mountPath: string;
  description?: string;
  storageGb?: number;
  deleteOnSandboxDelete?: boolean;
  provisioning: VolumeProvisioningPolicy;
  state?: VolumeStatePolicy;
  usedBy?: string[];
};

export type IntegrationDefinition = {
  provider: string;
  required?: boolean;
  capabilities?: string[];
  scopes?: string[];
  models?: string[];
  [key: string]: unknown;
};

export type EnvSecretDefinition = {
  kind: "env";
  name: string;
  required?: boolean;
  secret?: boolean;
  description?: string;
  [key: string]: unknown;
};

export type ScheduleDefinition = {
  kind: "schedule";
  name: string;
  scheduleType: "cron" | "rate";
  target: { action: string };
  enabledByDefault?: boolean;
  input?: Partial<AgentChatInput>;
  cron?: string;
  rate?: string;
  timezone?: string;
  [key: string]: unknown;
};

export type GeneratedMarkdownSource = string | (() => string | Promise<string>);

export type InstructionsDefinition = {
  kind: "instructions";
  source?: GeneratedMarkdownSource;
  markdown?: GeneratedMarkdownSource;
  format?: "markdown";
};

export type SkillDefinition = {
  kind: "skill";
  name: string;
  description?: string;
  source?: GeneratedMarkdownSource;
  markdown?: GeneratedMarkdownSource;
  format?: "markdown";
  files?: Record<string, GeneratedMarkdownSource>;
};

export type EditableResultMode =
  | "patch_only"
  | "commit_to_runtime_ref"
  | "create_branch"
  | "open_pr"
  | "checkpoint_only";

export type EditablePolicyDefinition = {
  kind: "editable";
  enabled: boolean;
  backend: "openpond-coding-work-item";
  runtimeEnvironmentId: "openpond-coding-core-v1";
  sourceOfTruth: "agent-source";
  policyDiscovery: {
    command: string;
    runAfter: "source-materialized";
  };
  allowedPaths: string[];
  requiredChecks: string[];
  defaultResultMode: EditableResultMode;
  supportedResultModes?: EditableResultMode[];
};

export type AgentProjectDefinition = {
  name: string;
  version: string;
  useCase: string;
  description?: string;
  manifestMode: "typescript" | "openpond-yaml" | "extends-openpond-yaml";
  extendsManifest?: string;
  runtime: Record<string, unknown>;
  resources?: Record<string, unknown>;
  model?: AgentModelPolicyDefinition;
  instructions?: InstructionsDefinition | string;
  skills?: SkillDefinition[];
  volumes?: VolumeDefinition[];
  setup?: { commands: string[] };
  validation?: { commands: string[] };
  inputSchema?: JsonSchema;
  inputSchemas?: Record<string, JsonSchema>;
  defaultAction?: string;
  actions: ActionDefinition[];
  agents?: LocalAgentDefinition[];
  remoteAgents?: RemoteAgentReferenceDefinition[];
  connections?: McpClientConnectionDefinition[];
  tools?: ToolDefinition[];
  workflows?: WorkflowDefinition[];
  channels?: ChannelDefinition[];
  schedules?: ScheduleDefinition[];
  integrations?: IntegrationDefinition[];
  env?: EnvSecretDefinition[];
  editable?: EditablePolicyDefinition;
  evals?: EvalDefinition[];
};

export function defineAgentProject(definition: AgentProjectDefinition) {
  return definition;
}

export function defineAgent(definition: AgentProjectDefinition): AgentProjectDefinition;
export function defineAgent(definition: Omit<LocalAgentDefinition, "kind">): LocalAgentDefinition;
export function defineAgent(
  definition: AgentProjectDefinition | Omit<LocalAgentDefinition, "kind">,
): AgentProjectDefinition | LocalAgentDefinition {
  if ("version" in definition && "useCase" in definition && "actions" in definition) {
    return defineAgentProject(definition);
  }
  return { kind: "local-agent", ...definition };
}

export function defineLocalAgent(
  definition: Omit<LocalAgentDefinition, "kind">,
): LocalAgentDefinition {
  return { kind: "local-agent", ...definition };
}

export function defineRemoteAgent(
  definition: Omit<RemoteAgentReferenceDefinition, "kind">,
): RemoteAgentReferenceDefinition {
  return { kind: "remote-agent", ...definition };
}

export function defineMcpClientConnection(
  definition: Omit<McpClientConnectionDefinition, "kind">,
): McpClientConnectionDefinition {
  return { kind: "mcp-client-connection", ...definition };
}

export function defineIntent<TInput = AgentChatInput>(
  definition: Omit<IntentDefinition<TInput>, "kind">,
): IntentDefinition<TInput> {
  return { kind: "intent", ...definition };
}

export function defineIntentRouter(
  definition: Omit<IntentRouterDefinition, "kind">,
): IntentRouterDefinition {
  return { kind: "intent-router", ...definition };
}

export function defineChannel(
  definition: Omit<ChannelDefinition, "kind">,
): ChannelDefinition {
  return { kind: "channel", ...definition };
}

export function defineWorkflow(
  definition: Omit<WorkflowDefinition, "kind">,
): WorkflowDefinition {
  return { kind: "workflow", ...definition };
}

export function defineTool(
  definition: Omit<ToolDefinition, "kind">,
): ToolDefinition {
  return { kind: "tool", ...definition };
}

export function defineEval(
  definition: Omit<EvalDefinition, "kind">,
): EvalDefinition {
  return { kind: "eval", ...definition };
}

export function defineSchedule(
  definition: Omit<ScheduleDefinition, "kind">,
): ScheduleDefinition {
  return { kind: "schedule", ...definition } as ScheduleDefinition;
}

export function defineInstructions(
  definition: InstructionsDefinition["source"] | Omit<InstructionsDefinition, "kind">,
): InstructionsDefinition {
  if (typeof definition === "string" || typeof definition === "function") {
    return { kind: "instructions", source: definition, format: "markdown" };
  }
  return { kind: "instructions", format: "markdown", ...definition };
}

export function defineSkill(
  definition: Omit<SkillDefinition, "kind">,
): SkillDefinition {
  return { kind: "skill", format: "markdown", ...definition };
}

export function action(
  name: string,
  definition: Omit<ActionDefinition, "name">,
): ActionDefinition {
  return { name, id: definition.id ?? name, ...definition };
}

export function defineAction(
  id: string,
  definition: Omit<ActionDefinition, "id" | "name"> & { name?: string },
): ActionDefinition;
export function defineAction(
  definition: Omit<ActionDefinition, "name"> & { id: string; name?: string },
): ActionDefinition;
export function defineAction(
  idOrDefinition: string | (Omit<ActionDefinition, "name"> & { id: string; name?: string }),
  maybeDefinition?: Omit<ActionDefinition, "id" | "name"> & { name?: string },
): ActionDefinition {
  if (typeof idOrDefinition === "string") {
    const definition = maybeDefinition ?? ({} as Omit<ActionDefinition, "id" | "name"> & { name?: string });
    return action(definition.name ?? idOrDefinition, { ...definition, id: idOrDefinition });
  }
  const { id, name = id, ...definition } = idOrDefinition;
  return action(name, { ...definition, id });
}

export function editable(
  definition: Omit<EditablePolicyDefinition, "kind">,
): EditablePolicyDefinition {
  return { kind: "editable", ...definition };
}

export const integration = {
  openpondChat(definition: Omit<IntegrationDefinition, "provider"> = {}) {
    return { provider: "openpond_chat", ...definition };
  },
  microsoftTeams(definition: Omit<IntegrationDefinition, "provider">) {
    return { provider: "microsoft_teams", ...definition };
  },
  slack(definition: Omit<IntegrationDefinition, "provider">) {
    return { provider: "slack", ...definition };
  },
  opchat(definition: Omit<IntegrationDefinition, "provider">) {
    return { provider: "opchat", ...definition };
  },
};

export function defineIntegration(
  definition: IntegrationDefinition,
): IntegrationDefinition {
  return definition;
}

export function defineEnvSecret(
  name: string,
  definition: Omit<EnvSecretDefinition, "kind" | "name"> = {},
): EnvSecretDefinition {
  return { kind: "env", name, ...definition };
}

export const env = {
  variable(
    name: string,
    definition: Omit<EnvSecretDefinition, "kind" | "name" | "secret"> = {},
  ) {
    return defineEnvSecret(name, { ...definition, secret: false });
  },
};

export const secret = {
  env(
    name: string,
    definition: Omit<EnvSecretDefinition, "kind" | "name" | "secret"> = {},
  ) {
    return defineEnvSecret(name, { ...definition, secret: true });
  },
};

export function volume(
  name: string,
  mountPath: string,
  definition: Omit<VolumeDefinition, "name" | "mountPath">,
): VolumeDefinition {
  return { name, mountPath, ...definition };
}

export const defineVolume = volume;

export const schedule = {
  cron(
    name: string,
    definition: Omit<ScheduleDefinition, "kind" | "name" | "scheduleType">,
  ) {
    return defineSchedule({ ...definition, name, scheduleType: "cron" } as Omit<ScheduleDefinition, "kind">);
  },
  rate(
    name: string,
    definition: Omit<ScheduleDefinition, "kind" | "name" | "scheduleType">,
  ) {
    return defineSchedule({ ...definition, name, scheduleType: "rate" } as Omit<ScheduleDefinition, "kind">);
  },
};

export async function runAgentAction(
  _agent: AgentProjectDefinition,
  _actionName: string,
  _options: Record<string, unknown> = {},
): Promise<void> {
  throw new Error("Use `openpond-agent run <action>` for the local SDK runner.");
}
