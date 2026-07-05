import crypto from "node:crypto";
import path from "node:path";

import type {
  ActionApprovalPolicyDefinition,
  ActionArtifactPolicyDefinition,
  ActionCatalogEntry,
  ActionDefinition,
  ActionMcpExportDefinition,
  ActionSchedulePolicyDefinition,
  ActionSetupRequirementDefinition,
  ActionTracePolicyDefinition,
  AgentProjectDefinition,
} from "../index";
import { ARTIFACT_DIR, ARTIFACT_SCHEMAS, DEFAULT_AGENT_CONFIG, OPENPOND_MANIFEST, SDK_SCHEMA_VERSION, traceDir } from "./constants";
import { isConnectedIntegrationProvider } from "./connected-integrations";
import { pathExists } from "./files";
import type { CompiledPromptArtifacts } from "./prompts";
import {
  actionId,
  actionLabel,
  inferActionImplementation,
  localAgentId,
  remoteAgentId,
  schemaLabel,
  toolName,
  workflowName,
} from "./schema";

export function createInspect(
  project: AgentProjectDefinition,
  cwd: string,
  artifactDir = ARTIFACT_DIR,
) {
  return {
    schemaVersion: SDK_SCHEMA_VERSION,
    schema: ARTIFACT_SCHEMAS.inspect,
    artifactSchemas: ARTIFACT_SCHEMAS,
    command: "openpond agent inspect --json",
    packageCommand: "openpond-agent inspect --json",
    sourceOfTruth: "agent-source",
    project: projectSummary(project),
    agent: {
      id: project.name,
      defaultAction: project.defaultAction ?? firstActionId(project),
      manifestHash: agentManifestHash(project),
    },
    actionCatalog: inspectActions(project),
    mcpExports: inspectActions(project).filter((entry) => entry.mcp.enabled),
    providerSupport: providerSupport(project),
    modelPolicy: project.model ?? defaultModelPolicy(),
    implementationRefs: implementationRefs(project),
    sourceLayout: sourceLayout(project, cwd),
    generatedArtifacts: generatedArtifacts(artifactDir),
    runtimeManifest: path.join(ARTIFACT_DIR, "openpond-manifest.preview.yaml"),
    editable: project.editable
      ? { schema: ARTIFACT_SCHEMAS.editablePolicy, ...project.editable }
      : null,
    capabilities: capabilities(project),
    setup: setupProjection(project),
    inputSchema: project.inputSchema ?? null,
    inputSchemas: project.inputSchemas ?? {},
    validation: {
      declaredCommands: project.validation?.commands ?? [],
      requiredChecks: project.editable?.requiredChecks ?? [],
    },
  };
}

export function createAgentManifest(
  project: AgentProjectDefinition,
  promptArtifacts?: CompiledPromptArtifacts,
) {
  return {
    schemaVersion: SDK_SCHEMA_VERSION,
    schema: ARTIFACT_SCHEMAS.agentManifest,
    artifactSchemas: ARTIFACT_SCHEMAS,
    sourceOfTruth: project.manifestMode,
    project: projectSummary(project),
    defaultEntrypoint: {
      scope: "action",
      name: project.defaultAction ?? firstActionId(project),
    },
    runtime: project.runtime,
    resources: project.resources ?? {},
    modelPolicy: project.model ?? defaultModelPolicy(),
    instructions: promptArtifacts?.instructions ?? serializeInstructions(project.instructions),
    skills: promptArtifacts?.skills ?? serializeSkills(project.skills ?? []),
    editable: project.editable
      ? { schema: ARTIFACT_SCHEMAS.editablePolicy, ...project.editable }
      : null,
    setup: project.setup ?? null,
    validation: project.validation ?? null,
    inputSchema: project.inputSchema ?? null,
    inputSchemas: project.inputSchemas ?? {},
    actionCatalog: inspectActions(project),
    actions: project.actions.map(serializeAction),
    chat: serializeChatRouter(project),
    agents: (project.agents ?? []).map((agent) => ({
      schema: ARTIFACT_SCHEMAS.agent,
      id: agent.id,
      label: agent.label ?? null,
      description: agent.description ?? null,
      tools: agent.tools ?? [],
      workflows: agent.workflows ?? [],
      modelPolicy: agent.model ?? null,
    })),
    remoteAgents: (project.remoteAgents ?? []).map((agent) => ({
      schema: ARTIFACT_SCHEMAS.remoteAgent,
      id: agent.id,
      description: agent.description,
      projectId: agent.projectId ?? null,
      agentId: agent.agentId ?? null,
      url: agent.url ?? null,
      auth: agent.auth,
      inputSchema: schemaLabel(agent.inputSchema),
      outputSchema: schemaLabel(agent.outputSchema),
      trace: agent.trace ?? null,
    })),
    connections: (project.connections ?? []).map((connection) => ({
      schema: ARTIFACT_SCHEMAS.mcpClientConnection,
      id: connection.id,
      description: connection.description ?? null,
      serverUrl: connection.serverUrl ?? null,
      auth: connection.auth ?? { policy: "none" },
      tools: connection.tools ?? {},
      approvalPolicy: connection.approvalPolicy ?? defaultApprovalPolicy(),
      traceNamespace: connection.traceNamespace ?? connection.id,
    })),
    workflows: (project.workflows ?? []).map((workflow) => ({
      schema: ARTIFACT_SCHEMAS.workflow,
      name: workflow.name,
      description: workflow.description ?? null,
    })),
    channels: (project.channels ?? []).map((channel) => serializeChannel(project, channel)),
    tools: (project.tools ?? []).map((tool) => ({
      schema: ARTIFACT_SCHEMAS.tool,
      name: tool.name,
      description: tool.description,
      visibility: tool.visibility,
      target: tool.target,
      inputSchema: schemaLabel(tool.inputSchema),
      outputArtifacts: tool.outputArtifacts ?? [],
    })),
    volumes: (project.volumes ?? []).map((volume) => ({ schema: ARTIFACT_SCHEMAS.volume, ...volume })),
    envRefs: (project.env ?? []).map(serializeEnvRef),
    integrations: (project.integrations ?? []).map((integration) => ({
      schema: ARTIFACT_SCHEMAS.integration,
      ...integration,
    })),
    schedules: (project.schedules ?? []).map((schedule) => ({
      schema: ARTIFACT_SCHEMAS.schedule,
      ...schedule,
    })),
    evals: (project.evals ?? []).map((evaluation) => ({
      schema: ARTIFACT_SCHEMAS.eval,
      name: evaluation.name,
      description: evaluation.description,
      expectedArtifacts: evaluation.expectedArtifacts ?? [],
    })),
  };
}

function serializeInstructions(instructions: AgentProjectDefinition["instructions"]) {
  if (!instructions) return null;
  if (typeof instructions === "string") {
    return { schema: ARTIFACT_SCHEMAS.instructions, source: instructions, format: "markdown" };
  }
  return {
    schema: ARTIFACT_SCHEMAS.instructions,
    source: serializeGeneratedSource(instructions.markdown ?? instructions.source),
    format: instructions.format ?? "markdown",
  };
}

function serializeSkills(skills: NonNullable<AgentProjectDefinition["skills"]>) {
  return skills.map((skill) => ({
    schema: ARTIFACT_SCHEMAS.skill,
    name: skill.name,
    description: skill.description ?? null,
    source: serializeGeneratedSource(skill.markdown ?? skill.source),
    format: skill.format ?? "markdown",
  }));
}

function serializeGeneratedSource(source: unknown) {
  return typeof source === "string" && source.startsWith("./") ? source : "generated";
}

function serializeEnvRef(envRef: NonNullable<AgentProjectDefinition["env"]>[number]) {
  return {
    schema: ARTIFACT_SCHEMAS.envSecret,
    kind: envRef.kind,
    name: envRef.name,
    required: envRef.required ?? false,
    secret: envRef.secret ?? true,
    description: envRef.description ?? null,
  };
}

function serializeChannel(
  project: AgentProjectDefinition,
  channel: NonNullable<AgentProjectDefinition["channels"]>[number],
) {
  const requiredConnections = channel.requiredConnections ?? [];
  const setupRequirements = requiredConnections.map((connection) => ({
    kind: "integration",
    name: connection,
    required: true,
    satisfied: hasIntegration(project, connection),
  }));
  return {
    schema: ARTIFACT_SCHEMAS.channel,
    id: channel.id,
    target: { action: channel.target.action },
    targetAction: channel.target.action,
    requiredConnections,
    capabilities: channel.capabilities ?? [],
    enabledByDefault: channel.enabledByDefault ?? false,
    adapter: {
      normalizeEvent: {
        kind: "function",
        output: "AgentChatInput",
        requiredFields: ["prompt", "channel"],
      },
      renderResponse: {
        kind: "function",
        input: "AgentChatResult",
        output: "Record<string, unknown>",
        supportedFields: ["text", "files", "artifactRefs", "metadata"],
      },
    },
    setupRequirements,
    setupStatus: setupRequirements.every((requirement) => requirement.satisfied)
      ? "ready"
      : "missing_setup",
  };
}

function setupProjection(project: AgentProjectDefinition) {
  return {
    channels: (project.channels ?? []).map((channel) => {
      const compiled = serializeChannel(project, channel);
      return {
        id: compiled.id,
        targetAction: compiled.targetAction,
        requiredConnections: compiled.requiredConnections,
        capabilities: compiled.capabilities,
        enabledByDefault: compiled.enabledByDefault,
        setupRequirements: compiled.setupRequirements,
        setupStatus: compiled.setupStatus,
      };
    }),
    integrations: (project.integrations ?? []).map((integration) => ({
      schema: ARTIFACT_SCHEMAS.integration,
      provider: integration.provider,
      required: integration.required ?? false,
      capabilities: integration.capabilities ?? [],
      scopes: integration.scopes ?? [],
    })),
    connections: (project.connections ?? []).map((connection) => ({
      schema: ARTIFACT_SCHEMAS.mcpClientConnection,
      id: connection.id,
      required: true,
      auth: connection.auth ?? { policy: "none" },
      toolFilters: connection.tools ?? {},
      setupStatus: connection.serverUrl ? "ready" : "missing_setup",
    })),
    envRefs: (project.env ?? []).map(serializeEnvRef),
    volumes: (project.volumes ?? []).map((volume) => ({
      schema: ARTIFACT_SCHEMAS.volume,
      name: volume.name,
      mountPath: volume.mountPath,
      provisioning: volume.provisioning,
      required: volume.provisioning.ui?.required ?? true,
    })),
    schedules: (project.schedules ?? []).map((schedule) => ({
      schema: ARTIFACT_SCHEMAS.schedule,
      name: schedule.name,
      targetAction: schedule.target.action,
      enabledByDefault: schedule.enabledByDefault ?? false,
      setupStatus: schedule.enabledByDefault ? "enabled" : "disabled",
    })),
  };
}

function hasIntegration(project: AgentProjectDefinition, provider: string): boolean {
  return (project.integrations ?? []).some((integration) => integration.provider === provider);
}

export function createRuntimeManifest(project: AgentProjectDefinition) {
  const defaultActionName = project.defaultAction ?? firstActionId(project) ?? "chat";
  const defaultAction = project.actions.find((action) => actionId(action) === defaultActionName || action.name === defaultActionName);
  const validationCommands =
    project.validation?.commands && project.validation.commands.length > 0
      ? project.validation.commands
      : ["openpond-agent validate"];
  return {
    schemaVersion: SDK_SCHEMA_VERSION,
    schema: ARTIFACT_SCHEMAS.runtimeManifest,
    name: project.name,
    version: project.version,
    useCase: project.useCase,
    description: project.description ?? `${project.name} OpenPond agent.`,
    runtime: project.runtime,
    ...(project.resources ? { resources: project.resources } : {}),
    setup: {
      commands: project.setup?.commands ?? [],
    },
    validation: {
      commands: validationCommands,
    },
    start: {
      command: `openpond-agent run ${defaultActionName}`,
      timeoutSeconds: defaultAction?.timeoutSeconds ?? 3600,
      artifactPaths: defaultAction?.outputArtifacts ?? [],
      ports: [],
    },
    actions: project.actions.map((agentAction) => ({
      id: actionId(agentAction),
      name: agentAction.name,
      label: actionLabel(agentAction),
      command: `openpond-agent run ${actionId(agentAction)}`,
      timeoutSeconds: agentAction.timeoutSeconds ?? 3600,
      artifactPaths: agentAction.outputArtifacts ?? [],
      ports: [],
    })),
    services: [],
    schedules: (project.schedules ?? []).map((agentSchedule) => ({
      name: agentSchedule.name,
      ...(agentSchedule.scheduleType === "cron"
        ? { cron: agentSchedule.cron ?? agentSchedule.scheduleExpression ?? "" }
        : { rate: agentSchedule.rate ?? agentSchedule.scheduleExpression ?? "" }),
      ...(agentSchedule.timezone ? { timezone: agentSchedule.timezone } : {}),
      enabled: agentSchedule.enabledByDefault ?? false,
      action: agentSchedule.target.action,
      ...(agentSchedule.input ? { metadata: { input: agentSchedule.input } } : {}),
    })),
    volumes: (project.volumes ?? []).map((agentVolume) => ({
      name: agentVolume.name,
      mountPath: agentVolume.mountPath,
      ...(agentVolume.storageGb ? { storageGb: agentVolume.storageGb } : {}),
      ...(agentVolume.deleteOnSandboxDelete !== undefined
        ? { deleteOnSandboxDelete: agentVolume.deleteOnSandboxDelete }
        : {}),
    })),
    integrations: runtimeIntegrations(project.integrations ?? []),
    permissions: runtimePermissions(project.integrations ?? []),
    inputs: {
      schema: project.inputSchema ?? { type: "object" },
      env: (project.env ?? []).map((envRef) => ({
        name: envRef.name,
        required: envRef.required ?? false,
        secret: envRef.secret ?? true,
        description: envRef.description ?? null,
      })),
    },
    artifacts: {
      paths: Array.from(
        new Set(project.actions.flatMap((agentAction) => agentAction.outputArtifacts ?? [])),
      ),
    },
    network: {
      egress: "restricted",
    },
  };
}

function runtimeIntegrations(integrations: AgentProjectDefinition["integrations"] = []) {
  return {
    requiredLeases: integrations
      .filter(
        (integration) =>
          integration.required === true && isConnectedIntegrationProvider(integration.provider),
      )
      .map((integration) => ({
        provider: integration.provider,
        scopes: integration.scopes ?? [],
        capabilities: integration.capabilities ?? [],
      })),
  };
}

function runtimePermissions(integrations: AgentProjectDefinition["integrations"] = []) {
  const opchat = integrations.find((integration) => integration.provider === "opchat");
  return {
    ...(opchat
      ? {
          opchat: {
            models: opchat.models ?? [],
            scopes: opchat.scopes ?? [],
          },
        }
      : {}),
  };
}

export function createActionRegistry(project: AgentProjectDefinition) {
  return {
    schemaVersion: SDK_SCHEMA_VERSION,
    schema: ARTIFACT_SCHEMAS.actionRegistry,
    generatedBy: "openpond-agent-sdk",
    actions: inspectActions(project).map((entry) => {
      const sourceAction = project.actions.find((action) => actionId(action) === entry.id) ?? null;
      return {
        id: entry.id,
        name: entry.name,
        label: entry.label,
        description: entry.description,
        command: `openpond-agent run ${entry.id}`,
        target: sourceAction ? serializeActionTarget(sourceAction) : entry.implementation,
        implementation: entry.implementation,
        visibility: entry.visibility,
        timeoutSeconds: sourceAction?.timeoutSeconds ?? 3600,
        inputSchema: entry.inputSchema,
        outputSchema: entry.outputSchema,
        outputArtifacts: entry.artifactPolicy.outputArtifacts ?? [],
        approvalPolicy: entry.approvalPolicy,
        setupRequirements: entry.setupRequirements,
        mcp: entry.mcp,
        trace: entry.trace,
      };
    }),
  };
}

export function createRuntimeBridge(actionRegistry: ReturnType<typeof createActionRegistry>) {
  return `#!/usr/bin/env node
// Generated by openpond-agent-sdk. Current runtimes can call the CLI command in action-registry.json.
export const schema = ${JSON.stringify(ARTIFACT_SCHEMAS.runtimeBridge)};
export const actionRegistry = ${JSON.stringify(actionRegistry, null, 2)};

export function commandForAction(name) {
  const action = actionRegistry.actions.find((candidate) => candidate.id === name || candidate.name === name);
  if (!action) throw new Error(\`Unknown action: \${name}\`);
  return action.command;
}
`;
}

export function inspectActions(project: AgentProjectDefinition): ActionCatalogEntry[] {
  return project.actions.map(inspectAction);
}

function inspectAction(action: ActionDefinition): ActionCatalogEntry {
  const id = actionId(action);
  const artifactPolicy = actionArtifactPolicy(action);
  return {
    id,
    name: action.name,
    label: actionLabel(action),
    description: action.description ?? "",
    visibility: action.visibility ?? "default",
    implementation: inferActionImplementation(action),
    inputSchema: schemaLabel(action.inputSchema),
    outputSchema: schemaLabel(action.outputSchema),
    approvalPolicy: action.approval ?? defaultApprovalPolicy(),
    artifactPolicy,
    setupRequirements: action.setup ?? [],
    mcp: action.mcp ?? defaultMcpExport(),
    schedulePolicy: action.schedule ?? defaultSchedulePolicy(),
    trace: {
      name: action.trace?.name ?? id,
      namespace: action.trace?.namespace ?? "actions",
      parentActionId: action.trace?.parentActionId,
    },
    invokesModel: actionInvokesModel(action),
  };
}

function actionArtifactPolicy(action: ActionDefinition): ActionArtifactPolicyDefinition {
  return {
    outputArtifacts: action.artifacts?.outputArtifacts ?? action.outputArtifacts ?? [],
    persistRunSummary: action.artifacts?.persistRunSummary ?? true,
    persistTrace: action.artifacts?.persistTrace ?? true,
  };
}

function defaultApprovalPolicy(): ActionApprovalPolicyDefinition {
  return { mode: "never" };
}

function defaultMcpExport(): ActionMcpExportDefinition {
  return { enabled: false };
}

function defaultSchedulePolicy(): ActionSchedulePolicyDefinition {
  return { enabled: false, allowAdHoc: true };
}

function defaultModelPolicy() {
  return { provider: "openpond-managed" as const, required: false };
}

function actionInvokesModel(action: ActionDefinition): boolean {
  if (action.model) return true;
  return action.target.kind === "chat" || action.target.kind === "intent-router" || action.target.kind === "local-agent" || action.target.kind === "remote-agent";
}

function providerSupport(project: AgentProjectDefinition) {
  return (project.channels ?? []).map((channel) => {
    const compiled = serializeChannel(project, channel);
    return {
      id: compiled.id,
      setupStatus: compiled.setupStatus,
      setupRequirements: compiled.setupRequirements,
      capabilities: compiled.capabilities,
      enabledByDefault: compiled.enabledByDefault,
      responseRendering: compiled.adapter.renderResponse,
    };
  });
}

function implementationRefs(project: AgentProjectDefinition) {
  return {
    agents: (project.agents ?? []).map((agent) => ({
      id: agent.id,
      label: agent.label ?? null,
      description: agent.description ?? null,
    })),
    remoteAgents: (project.remoteAgents ?? []).map((agent) => ({
      id: agent.id,
      description: agent.description,
      projectId: agent.projectId ?? null,
      agentId: agent.agentId ?? null,
      url: agent.url ?? null,
      trace: agent.trace ?? null,
    })),
    workflows: (project.workflows ?? []).map((workflow) => ({
      id: workflow.name,
      description: workflow.description ?? null,
    })),
    tools: (project.tools ?? []).map((tool) => ({
      id: tool.name,
      description: tool.description,
      visibility: tool.visibility,
    })),
    connections: (project.connections ?? []).map((connection) => ({
      id: connection.id,
      description: connection.description ?? null,
      traceNamespace: connection.traceNamespace ?? connection.id,
    })),
  };
}

function firstActionId(project: AgentProjectDefinition) {
  const first = project.actions[0];
  return first ? actionId(first) : null;
}

function projectSummary(project: AgentProjectDefinition) {
  return {
    name: project.name,
    version: project.version,
    useCase: project.useCase,
    description: project.description ?? null,
  };
}

function agentManifestHash(project: AgentProjectDefinition) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(createAgentManifest(project)))
    .digest("hex");
}

function sourceLayout(project: AgentProjectDefinition, cwd: string) {
  const agentConfig = project.manifestMode === "openpond-yaml"
    ? OPENPOND_MANIFEST
    : DEFAULT_AGENT_CONFIG;
  return {
    root: ".",
    agentConfig,
    manifestMode: project.manifestMode,
    extendsManifest: project.extendsManifest ?? null,
    openpondYaml: optionalPath(cwd, OPENPOND_MANIFEST),
    actions: optionalPath(cwd, "agent/actions"),
    legacyActions: optionalPath(cwd, "agent/actions.ts"),
    agents: optionalPath(cwd, "agent/agents"),
    remoteAgents: optionalPath(cwd, "agent/remote-agents"),
    connections: optionalPath(cwd, "agent/connections"),
    editable: optionalPath(cwd, "agent/editable.ts"),
    workflows: optionalPath(cwd, "agent/workflows"),
    channels: optionalPath(cwd, "agent/channels"),
    tools: optionalPath(cwd, "agent/tools"),
    evals: optionalPath(cwd, "agent/evals"),
    volumes: optionalPath(cwd, "agent/volumes.ts"),
    integrations: optionalPath(cwd, "agent/integrations.ts"),
    schedules: optionalPath(cwd, "agent/schedules"),
  };
}

function generatedArtifacts(artifactDir = ARTIFACT_DIR) {
  return {
    inspectJson: path.join(artifactDir, "agent-inspect.json"),
    agentManifestJson: path.join(artifactDir, "agent-manifest.json"),
    actionRegistryJson: path.join(artifactDir, "action-registry.json"),
    runtimeManifestPreviewYaml: path.join(artifactDir, "openpond-manifest.preview.yaml"),
    validatorReport: path.join(artifactDir, "validator-report.md"),
    evalResultsJson: path.join(artifactDir, "eval-results.json"),
    traces: traceDir(artifactDir),
  };
}

function capabilities(project: AgentProjectDefinition) {
  return {
    actions: project.actions.map((action) => actionId(action)),
    agents: (project.agents ?? []).map((agent) => agent.id),
    remoteAgents: (project.remoteAgents ?? []).map((agent) => agent.id),
    connections: (project.connections ?? []).map((connection) => connection.id),
    channels: (project.channels ?? []).map((channel) => channel.id),
    tools: (project.tools ?? []).map((tool) => tool.name),
    workflows: (project.workflows ?? []).map((workflow) => workflow.name),
    schedules: (project.schedules ?? []).map((schedule) => schedule.name),
    evals: (project.evals ?? []).map((evaluation) => evaluation.name),
    volumes: (project.volumes ?? []).map((volume) => volume.name),
    env: (project.env ?? []).map((envRef) => envRef.name),
    integrations: (project.integrations ?? []).map((integration) => integration.provider),
  };
}

function optionalPath(cwd: string, relativePath: string) {
  return pathExists(path.join(cwd, relativePath)) ? relativePath : null;
}

function serializeAction(action: ActionDefinition) {
  const catalogEntry = inspectAction(action);
  return {
    schema: ARTIFACT_SCHEMAS.action,
    id: catalogEntry.id,
    name: action.name,
    label: catalogEntry.label,
    description: action.description ?? null,
    visibility: action.visibility ?? "default",
    target: serializeActionTarget(action),
    implementation: catalogEntry.implementation,
    timeoutSeconds: action.timeoutSeconds ?? null,
    inputSchema: schemaLabel(action.inputSchema),
    outputSchema: schemaLabel(action.outputSchema),
    approvalPolicy: catalogEntry.approvalPolicy,
    artifactPolicy: catalogEntry.artifactPolicy,
    setupRequirements: catalogEntry.setupRequirements,
    mcp: catalogEntry.mcp,
    schedulePolicy: catalogEntry.schedulePolicy,
    trace: catalogEntry.trace,
    invokesModel: catalogEntry.invokesModel,
    outputArtifacts: action.outputArtifacts ?? [],
  };
}

function serializeActionTarget(action: ActionDefinition) {
  if (action.target.kind === "chat") {
    return {
      kind: "chat",
      allowedActions: action.target.allowedActions ?? [],
      hasRuntime: Boolean(action.target.run),
    };
  }
  if (action.target.kind === "workflow") {
    return { kind: "workflow", workflow: workflowName(action.target.workflow) };
  }
  if (action.target.kind === "local-agent") {
    return { kind: "local-agent", agentId: localAgentId(action.target.agent) };
  }
  if (action.target.kind === "remote-agent") {
    return { kind: "remote-agent", remoteAgentId: remoteAgentId(action.target.remoteAgent) };
  }
  if (action.target.kind === "tool") {
    return { kind: "tool", tool: toolName(action.target.tool) };
  }
  return {
    kind: "intent-router",
    router: typeof action.target.router === "string" ? action.target.router : `${actionId(action)}-router`,
    intents: typeof action.target.router === "string"
      ? []
      : action.target.router.intents.map((intent) => intent.name),
    defaultIntent: typeof action.target.router === "string"
      ? null
      : action.target.router.defaultIntent.name,
  };
}

function serializeChatRouter(project: AgentProjectDefinition) {
  const defaultAction = project.actions.find(
    (action) => actionId(action) === (project.defaultAction ?? "chat") || action.name === (project.defaultAction ?? "chat"),
  );
  if (!defaultAction || defaultAction.target.kind !== "intent-router") {
    if (defaultAction?.target.kind === "chat") {
      return {
        schema: ARTIFACT_SCHEMAS.intentRouter,
        kind: "chat-action",
        allowedActions: defaultAction.target.allowedActions ?? [],
      };
    }
    return null;
  }
  if (typeof defaultAction.target.router === "string") {
    return { schema: ARTIFACT_SCHEMAS.intentRouter, kind: "intent-router", router: defaultAction.target.router };
  }
  return {
    schema: ARTIFACT_SCHEMAS.intentRouter,
    kind: "intent-router",
    inputSchema: schemaLabel(defaultAction.target.router.inputSchema),
    intents: defaultAction.target.router.intents.map((intent) => intent.name),
    defaultIntent: defaultAction.target.router.defaultIntent.name,
    routing: defaultAction.target.router.routing ?? null,
  };
}
