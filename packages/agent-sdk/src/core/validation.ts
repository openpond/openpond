import { readFileSync } from "node:fs";
import path from "node:path";

import type { ActionDefinition, AgentProjectDefinition, IntentRouterDefinition } from "../index";
import { ARTIFACT_DIR, ARTIFACT_SCHEMAS, DEFAULT_AGENT_CONFIG, OPENPOND_MANIFEST, SDK_SCHEMA_VERSION } from "./constants";
import { pathExists, writeText } from "./files";
import { createAgentManifest } from "./manifest";
import { actionId, localAgentId, remoteAgentId, toolName, workflowName } from "./schema";
import type { ValidationIssue, ValidationResult } from "./types";

type IssueInput = Omit<ValidationIssue, "summary"> & { summary?: string };
const SYNTHESIZED_OPENPOND_YAML_SENTINEL =
  "# openpond-agent-sdk-source-upload: synthesized-openpond-yaml";

export function validateAgentProject(project: AgentProjectDefinition, cwd: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  const actionNames = new Set<string>();
  const actionIds = new Set<string>();
  const workflowNames = new Set((project.workflows ?? []).map((workflow) => workflow.name));
  const agentIds = new Set((project.agents ?? []).map((agent) => agent.id));
  const remoteAgentIds = new Set((project.remoteAgents ?? []).map((agent) => agent.id));
  const toolNames = new Set((project.tools ?? []).map((tool) => tool.name));

  if (!project.name.trim()) addIssue(issues, {
    code: "project_name_required",
    severity: "error",
    path: "project.name",
    message: "Project name is required.",
  });
  if (!project.version.trim()) addIssue(issues, {
    code: "project_version_required",
    severity: "error",
    path: "project.version",
    message: "Project version is required.",
  });
  validateSourceOfTruth(project, cwd, issues);
  if (!Array.isArray(project.actions) || project.actions.length === 0) {
    addIssue(issues, {
      code: "action_required",
      severity: "error",
      path: "actions",
      message: "At least one action is required.",
    });
  }

  for (const action of project.actions ?? []) {
    const id = actionId(action);
    if (actionNames.has(action.name)) addIssue(issues, {
      code: "action_duplicate",
      severity: "error",
      path: `actions.${action.name}`,
      message: `Duplicate action: ${action.name}`,
      details: { action: action.name },
    });
    if (actionIds.has(id)) addIssue(issues, {
      code: "action_id_duplicate",
      severity: "error",
      path: `actions.${id}`,
      message: `Duplicate action id: ${id}`,
      details: { action: id },
    });
    actionNames.add(action.name);
    actionIds.add(id);
    validateActionTarget(action, workflowNames, agentIds, remoteAgentIds, toolNames, issues);
    validateActionExposure(action, issues);
  }

  const defaultAction = project.defaultAction ?? (project.actions[0] ? actionId(project.actions[0]) : undefined);
  if (defaultAction && !actionNames.has(defaultAction) && !actionIds.has(defaultAction)) {
    addIssue(issues, {
      code: "default_action_missing",
      severity: "error",
      path: "defaultAction",
      message: `Default action ${defaultAction} is not declared.`,
      details: { action: defaultAction },
    });
  }

  validateRemoteAgents(project, issues);
  validateConnections(project, issues);
  validateConversationalSurface(project, actionIds, issues);
  validateChannels(project, actionIds, issues);
  validateSchedules(project, actionIds, issues);
  validateTools(project, actionIds, workflowNames, issues);
  validateVolumes(project, actionIds, issues);
  validateEvals(project, issues);
  validateEnvSecrets(project, issues);
  validateEditable(project, issues);
  validateInstructionsAndSkills(project, cwd, issues);
  validateSecretLeakage(project, issues);

  return validationResult(issues);
}

function validateEvals(project: AgentProjectDefinition, issues: ValidationIssue[]) {
  const declaredArtifacts = new Set(
    (project.actions ?? []).flatMap((action) => action.outputArtifacts ?? []),
  );
  for (const evaluation of project.evals ?? []) {
    for (const artifact of evaluation.expectedArtifacts ?? []) {
      if (!declaredArtifacts.has(artifact)) addIssue(issues, {
        code: "eval_expected_artifact_not_declared",
        severity: "warning",
        path: `evals.${evaluation.name}.expectedArtifacts`,
        message: `Eval ${evaluation.name} expects artifact ${artifact}, but no action declares it.`,
        details: { eval: evaluation.name, artifact },
      });
    }
  }
}

function validateSourceOfTruth(
  project: AgentProjectDefinition,
  cwd: string,
  issues: ValidationIssue[],
) {
  const hasTypescriptConfig = pathExists(path.join(cwd, DEFAULT_AGENT_CONFIG));
  const openPondManifestPath = path.join(cwd, OPENPOND_MANIFEST);
  const hasOpenPondManifest = pathExists(openPondManifestPath);
  const hasAuthoredOpenPondManifest =
    hasOpenPondManifest &&
    !isSynthesizedOpenPondYaml(openPondManifestPath);

  if (project.manifestMode !== "openpond-yaml" && !hasTypescriptConfig) addIssue(issues, {
    code: "agent_config_missing",
    severity: "error",
    path: DEFAULT_AGENT_CONFIG,
    source: { file: DEFAULT_AGENT_CONFIG },
    message: `${DEFAULT_AGENT_CONFIG} is missing.`,
  });

  if (project.manifestMode === "openpond-yaml" && !hasOpenPondManifest) addIssue(issues, {
    code: "openpond_yaml_missing",
    severity: "error",
    path: OPENPOND_MANIFEST,
    source: { file: OPENPOND_MANIFEST },
    message: `${OPENPOND_MANIFEST} is missing.`,
  });

  if (project.manifestMode === "typescript" && hasAuthoredOpenPondManifest) addIssue(issues, {
    code: "typescript_manifest_openpond_yaml_drift",
    severity: "error",
    path: OPENPOND_MANIFEST,
    source: { file: OPENPOND_MANIFEST },
    message: `${OPENPOND_MANIFEST} exists, but the TypeScript project does not explicitly extend it.`,
    details: { manifestMode: project.manifestMode },
  });

  if (project.manifestMode === "extends-openpond-yaml") {
    const extendsManifest = project.extendsManifest ?? OPENPOND_MANIFEST;
    if (!pathExists(path.join(cwd, extendsManifest))) addIssue(issues, {
      code: "extends_manifest_missing",
      severity: "error",
      path: "extendsManifest",
      source: { file: extendsManifest },
      message: `Extended OpenPond manifest ${extendsManifest} is missing.`,
      details: { manifestMode: project.manifestMode, extendsManifest },
    });
  }
}

function isSynthesizedOpenPondYaml(filePath: string): boolean {
  try {
    const source = readFileSync(filePath, "utf8");
    return source.startsWith(`${SYNTHESIZED_OPENPOND_YAML_SENTINEL}\n`);
  } catch {
    return false;
  }
}

export async function writeValidationReport(
  cwd: string,
  validation: ValidationResult,
  artifactDir = ARTIFACT_DIR,
) {
  await writeText(cwd, path.join(artifactDir, "validator-report.md"), formatValidationReport(validation));
}

export function formatValidationReport(validation: ValidationResult): string {
  const lines = ["# OpenPond Agent Validation Report", ""];
  lines.push(`Schema: ${validation.schema}`, "");
  lines.push(`Status: ${validation.status}`, "");
  lines.push("## Summary", "");
  lines.push(`- Errors: ${validation.summary.errors}`);
  lines.push(`- Warnings: ${validation.summary.warnings}`);
  lines.push("", "## Errors", "");
  lines.push(...formatIssues(validation.issues.filter((issue) => issue.severity === "error")));
  lines.push("", "## Warnings", "");
  lines.push(...formatIssues(validation.issues.filter((issue) => issue.severity === "warning")));
  lines.push("");
  return lines.join("\n");
}

function validateActionTarget(
  action: ActionDefinition,
  workflowNames: Set<string>,
  agentIds: Set<string>,
  remoteAgentIds: Set<string>,
  toolNames: Set<string>,
  issues: ValidationIssue[],
) {
  const id = actionId(action);
  if (action.target.kind === "workflow") {
    const name = workflowName(action.target.workflow);
    if (typeof action.target.workflow === "string" && !workflowNames.has(name)) {
      addIssue(issues, {
        code: "action_target_workflow_missing",
        severity: "error",
        path: `actions.${id}.target.workflow`,
        message: `Action ${id} targets missing workflow ${name}.`,
        details: { action: id, workflow: name },
      });
    }
  }
  if (action.target.kind === "local-agent") {
    const agentId = localAgentId(action.target.agent);
    if (typeof action.target.agent === "string" && !agentIds.has(agentId)) {
      addIssue(issues, {
        code: "action_target_agent_missing",
        severity: "error",
        path: `actions.${id}.target.agent`,
        message: `Action ${id} targets missing local agent ${agentId}.`,
        details: { action: id, agent: agentId },
      });
    }
  }
  if (action.target.kind === "remote-agent") {
    const targetRemoteAgentId = remoteAgentId(action.target.remoteAgent);
    if (typeof action.target.remoteAgent === "string" && !remoteAgentIds.has(targetRemoteAgentId)) {
      addIssue(issues, {
        code: "action_target_remote_agent_missing",
        severity: "error",
        path: `actions.${id}.target.remoteAgent`,
        message: `Action ${id} targets missing remote agent ${targetRemoteAgentId}.`,
        details: { action: id, remoteAgent: targetRemoteAgentId },
      });
    }
  }
  if (action.target.kind === "tool") {
    const targetToolName = toolName(action.target.tool);
    if (typeof action.target.tool === "string" && !toolNames.has(targetToolName)) {
      addIssue(issues, {
        code: "action_target_tool_missing",
        severity: "error",
        path: `actions.${id}.target.tool`,
        message: `Action ${id} targets missing tool ${targetToolName}.`,
        details: { action: id, tool: targetToolName },
      });
    }
  }
  if (action.target.kind === "intent-router" && typeof action.target.router !== "string") {
    validateRouter(id, action.target.router, issues);
  }
}

function validateActionExposure(action: ActionDefinition, issues: ValidationIssue[]) {
  const id = actionId(action);
  const isDirectAction = action.target.kind !== "chat" && action.target.kind !== "intent-router";
  if (isDirectAction && (action.visibility === "end_user" || action.mcp?.enabled) && !action.inputSchema) {
    addIssue(issues, {
      code: "action_direct_input_schema_missing",
      severity: action.mcp?.enabled ? "error" : "warning",
      path: `actions.${id}.inputSchema`,
      message: `Direct action ${id} should declare an input schema.`,
      details: { action: id },
    });
  }
  if (action.mcp?.enabled && !action.inputSchema) {
    addIssue(issues, {
      code: "mcp_export_input_schema_missing",
      severity: "error",
      path: `actions.${id}.mcp`,
      message: `MCP-exported action ${id} must declare an input schema.`,
      details: { action: id },
    });
  }
  if (action.mcp?.enabled && (action.visibility === "internal" || action.visibility === "debug")) {
    addIssue(issues, {
      code: "mcp_export_visibility_unsafe",
      severity: "error",
      path: `actions.${id}.mcp`,
      message: `MCP-exported action ${id} must not use ${action.visibility} visibility.`,
      details: { action: id, visibility: action.visibility },
    });
  }
}

function validateRouter(
  actionName: string,
  router: IntentRouterDefinition,
  issues: ValidationIssue[],
) {
  const intentNames = new Set<string>();
  for (const intent of router.intents) {
    if (intentNames.has(intent.name)) addIssue(issues, {
      code: "intent_duplicate",
      severity: "error",
      path: `actions.${actionName}.router.intents.${intent.name}`,
      message: `Action ${actionName} has duplicate router intent ${intent.name}.`,
      details: { action: actionName, intent: intent.name },
    });
    intentNames.add(intent.name);
  }
  if (!intentNames.has(router.defaultIntent.name)) {
    addIssue(issues, {
      code: "intent_default_missing",
      severity: "error",
      path: `actions.${actionName}.router.defaultIntent`,
      message: `Action ${actionName} default intent ${router.defaultIntent.name} is not listed in router intents.`,
      details: { action: actionName, intent: router.defaultIntent.name },
    });
  }
}

function validateChannels(
  project: AgentProjectDefinition,
  actionIds: Set<string>,
  issues: ValidationIssue[],
) {
  for (const channel of project.channels ?? []) {
    if (hasBusinessRoutingMetadata(channel)) {
      addIssue(issues, {
        code: "channel_business_routing_forbidden",
        severity: "error",
        path: `channels.${channel.id}`,
        message: `Channel ${channel.id} must not define business routing metadata. Route natural-language provider traffic through action chat.`,
        setupRequirement: { kind: "channel", name: channel.id, required: true },
        details: { channel: channel.id },
      });
    }
    if (!actionIds.has(channel.target.action)) {
      addIssue(issues, {
        code: "channel_target_action_missing",
        severity: "error",
        path: `channels.${channel.id}.target.action`,
        message: `Channel ${channel.id} targets missing action ${channel.target.action}.`,
        setupRequirement: { kind: "channel", name: channel.id, required: true },
        details: { channel: channel.id, action: channel.target.action },
      });
    }
    for (const connection of channel.requiredConnections ?? []) {
      const hasIntegration = (project.integrations ?? []).some((integration) => integration.provider === connection);
      if (!hasIntegration) addIssue(issues, {
        code: "channel_missing_integration_requirement",
        severity: "warning",
        path: `channels.${channel.id}.requiredConnections`,
        message: `Channel ${channel.id} requires ${connection}, but no matching integration is declared.`,
        setupRequirement: { kind: "integration", name: connection, required: true },
        details: { channel: channel.id, integration: connection },
      });
    }
  }
}

function validateConversationalSurface(
  project: AgentProjectDefinition,
  actionIds: Set<string>,
  issues: ValidationIssue[],
) {
  const conversationalChannels = new Set(["openpond_chat", "slack", "microsoft_teams", "mcp"]);
  const hasConversationalSurface = (project.channels ?? []).some((channel) => conversationalChannels.has(channel.id));
  if (hasConversationalSurface && !actionIds.has("chat")) {
    addIssue(issues, {
      code: "chat_action_required",
      severity: "error",
      path: "actions.chat",
      message: "Projects with conversational provider surfaces must declare a chat action.",
      details: { channels: (project.channels ?? []).map((channel) => channel.id) },
    });
  }
}

function validateRemoteAgents(project: AgentProjectDefinition, issues: ValidationIssue[]) {
  const ids = new Set<string>();
  for (const agent of project.remoteAgents ?? []) {
    if (ids.has(agent.id)) addIssue(issues, {
      code: "remote_agent_duplicate",
      severity: "error",
      path: `remoteAgents.${agent.id}`,
      message: `Duplicate remote agent id: ${agent.id}`,
      details: { remoteAgent: agent.id },
    });
    ids.add(agent.id);
    if (!agent.projectId && !agent.agentId && !agent.url) {
      addIssue(issues, {
        code: "remote_agent_target_missing",
        severity: "error",
        path: `remoteAgents.${agent.id}`,
        message: `Remote agent ${agent.id} must declare projectId, agentId, or url.`,
        details: { remoteAgent: agent.id },
      });
    }
    if (agent.auth.policy !== "none" && !agent.auth.connectionId && !agent.auth.env && agent.auth.policy !== "openpond-service") {
      addIssue(issues, {
        code: "remote_agent_auth_gap",
        severity: "error",
        path: `remoteAgents.${agent.id}.auth`,
        message: `Remote agent ${agent.id} auth policy ${agent.auth.policy} requires a connectionId or env token reference.`,
        details: { remoteAgent: agent.id, policy: agent.auth.policy },
      });
    }
  }
}

function validateConnections(project: AgentProjectDefinition, issues: ValidationIssue[]) {
  const ids = new Set<string>();
  for (const connection of project.connections ?? []) {
    if (ids.has(connection.id)) addIssue(issues, {
      code: "mcp_connection_duplicate",
      severity: "error",
      path: `connections.${connection.id}`,
      message: `Duplicate MCP client connection id: ${connection.id}`,
      details: { connection: connection.id },
    });
    ids.add(connection.id);
    if (!connection.serverUrl) addIssue(issues, {
      code: "mcp_connection_server_url_missing",
      severity: "warning",
      path: `connections.${connection.id}.serverUrl`,
      message: `MCP client connection ${connection.id} should declare a serverUrl for setup projection.`,
      setupRequirement: { kind: "connection", name: connection.id, required: true },
      details: { connection: connection.id },
    });
    if (!connection.tools?.allow?.length && !connection.tools?.block?.length) addIssue(issues, {
      code: "mcp_connection_tool_filter_missing",
      severity: "warning",
      path: `connections.${connection.id}.tools`,
      message: `MCP client connection ${connection.id} should declare allow or block tool filters.`,
      details: { connection: connection.id },
    });
  }
}

function validateSchedules(project: AgentProjectDefinition, actionIds: Set<string>, issues: ValidationIssue[]) {
  for (const schedule of project.schedules ?? []) {
    if (!actionIds.has(schedule.target.action)) {
      addIssue(issues, {
        code: "schedule_target_action_missing",
        severity: "error",
        path: `schedules.${schedule.name}.target.action`,
        message: `Schedule ${schedule.name} targets missing action ${schedule.target.action}.`,
        setupRequirement: { kind: "schedule", name: schedule.name, required: true },
        details: { schedule: schedule.name, action: schedule.target.action },
      });
    }
  }
}

function validateTools(
  project: AgentProjectDefinition,
  actionIds: Set<string>,
  workflowNames: Set<string>,
  issues: ValidationIssue[],
) {
  for (const tool of project.tools ?? []) {
    if (!actionIds.has(tool.target.action)) addIssue(issues, {
      code: "tool_target_action_missing",
      severity: "error",
      path: `tools.${tool.name}.target.action`,
      message: `Tool ${tool.name} targets missing action ${tool.target.action}.`,
      details: { tool: tool.name, action: tool.target.action },
    });
    if (tool.target.workflow && !workflowNames.has(tool.target.workflow)) {
      addIssue(issues, {
        code: "tool_target_workflow_missing",
        severity: "error",
        path: `tools.${tool.name}.target.workflow`,
        message: `Tool ${tool.name} references missing workflow ${tool.target.workflow}.`,
        details: { tool: tool.name, workflow: tool.target.workflow },
      });
    }
  }
}

function validateVolumes(project: AgentProjectDefinition, actionIds: Set<string>, issues: ValidationIssue[]) {
  for (const volume of project.volumes ?? []) {
    for (const actionName of volume.usedBy ?? []) {
      if (!actionIds.has(actionName)) addIssue(issues, {
        code: "volume_used_by_action_missing",
        severity: "warning",
        path: `volumes.${volume.name}.usedBy`,
        message: `Volume ${volume.name} is marked usedBy missing action ${actionName}.`,
        setupRequirement: { kind: "volume", name: volume.name, required: false },
        details: { volume: volume.name, action: actionName },
      });
    }
  }
}

function validateEnvSecrets(project: AgentProjectDefinition, issues: ValidationIssue[]) {
  const names = new Set<string>();
  for (const envRef of project.env ?? []) {
    if (!envRef.name.trim()) addIssue(issues, {
      code: "env_name_required",
      severity: "error",
      path: "env.name",
      setupRequirement: { kind: "env", name: "", required: envRef.required ?? true },
      message: "Env/secret declaration requires a name.",
    });
    if (names.has(envRef.name)) addIssue(issues, {
      code: "env_duplicate",
      severity: "error",
      path: `env.${envRef.name}`,
      setupRequirement: { kind: "env", name: envRef.name, required: envRef.required ?? true },
      message: `Duplicate env/secret declaration: ${envRef.name}`,
      details: { name: envRef.name },
    });
    names.add(envRef.name);
    if (hasInlineSecretValue(envRef)) addIssue(issues, {
      code: "env_secret_value_inline",
      severity: "error",
      path: `env.${envRef.name}`,
      setupRequirement: { kind: "env", name: envRef.name, required: envRef.required ?? true },
      message: `Env/secret ${envRef.name} appears to contain an inline value. Store values in OpenPond secret storage.`,
      details: { name: envRef.name },
    });
  }
}


function validateEditable(project: AgentProjectDefinition, issues: ValidationIssue[]) {
  if (!project.editable?.enabled) return;
  if (project.editable.backend !== "openpond-coding-work-item") addIssue(issues, {
    code: "editable_backend_invalid",
    severity: "error",
    path: "editable.backend",
    message: "Editable backend must be openpond-coding-work-item.",
  });
  if (project.editable.allowedPaths.length === 0) addIssue(issues, {
    code: "editable_allowed_paths_missing",
    severity: "error",
    path: "editable.allowedPaths",
    message: "Editable policy requires at least one allowed path.",
  });
  if (project.editable.requiredChecks.length === 0) addIssue(issues, {
    code: "editable_required_checks_missing",
    severity: "warning",
    path: "editable.requiredChecks",
    message: "Editable policy has no required checks.",
  });
}

function validateInstructionsAndSkills(
  project: AgentProjectDefinition,
  cwd: string,
  issues: ValidationIssue[],
) {
  const instructionSource =
    typeof project.instructions === "string"
      ? project.instructions
      : project.instructions?.markdown ?? project.instructions?.source;
  if (typeof instructionSource === "string") {
    validateSourcePath(cwd, instructionSource, "Instructions", "instructions", issues);
  }

  for (const skill of project.skills ?? []) {
    if (!skill.description?.trim()) addIssue(issues, {
      code: "skill_description_missing",
      severity: "warning",
      path: `skills.${skill.name}.description`,
      message: `Skill ${skill.name} should declare a description for routing.`,
      details: { skill: skill.name },
    });
    const skillSource = skill.markdown ?? skill.source;
    if (!skillSource) addIssue(issues, {
      code: "skill_source_missing",
      severity: "warning",
      path: `skills.${skill.name}.source`,
      message: `Skill ${skill.name} should declare markdown or source content.`,
      details: { skill: skill.name },
    });
    if (typeof skillSource === "string") {
      validateSourcePath(cwd, skillSource, `Skill ${skill.name}`, `skills.${skill.name}.source`, issues);
    }
    if (Object.keys(skill.files ?? {}).length > 50) {
      addIssue(issues, {
        code: "skill_generated_file_count_exceeded",
        severity: "warning",
        path: `skills.${skill.name}.files`,
        message: `Skill ${skill.name} declares more than 50 generated files.`,
        details: { skill: skill.name, limit: 50 },
      });
    }
    for (const relativePath of Object.keys(skill.files ?? {})) {
      if (!isSafeRelativePath(relativePath)) {
        addIssue(issues, {
          code: "skill_generated_file_path_invalid",
          severity: "warning",
          path: `skills.${skill.name}.files.${relativePath}`,
          message: `Skill ${skill.name} generated file path must stay inside the skill package: ${relativePath}`,
          details: { skill: skill.name, file: relativePath },
        });
      }
    }
  }
}

function validateSourcePath(
  cwd: string,
  source: string,
  label: string,
  issuePath: string,
  issues: ValidationIssue[],
) {
  if (!source.startsWith("./")) return;
  const relativePath = source.slice(2);
  if (!pathExists(path.join(cwd, relativePath))) addIssue(issues, {
    code: "source_file_missing",
    severity: "warning",
    path: issuePath,
    source: { file: relativePath },
    message: `${label} source ${source} does not exist.`,
    details: { source },
  });
}

function validateSecretLeakage(project: AgentProjectDefinition, issues: ValidationIssue[]) {
  const suspiciousValues = findSuspiciousSecretValues(createAgentManifest(project));
  for (const valuePath of suspiciousValues) {
    addIssue(issues, {
      code: "secret_leakage_detected",
      severity: "error",
      path: valuePath,
      message: `Manifest appears to contain a raw secret value at ${valuePath}. Store secret values in OpenPond secret storage.`,
      details: { path: valuePath },
    });
  }
}

function validationResult(issues: ValidationIssue[]): ValidationResult {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return {
    schemaVersion: SDK_SCHEMA_VERSION,
    schema: ARTIFACT_SCHEMAS.validatorReport,
    status: errors.length === 0 ? "passed" : "failed",
    summary: { errors: errors.length, warnings: warnings.length },
    issues,
    errors: errors.map((issue) => issue.message),
    warnings: warnings.map((issue) => issue.message),
  };
}

function addIssue(issues: ValidationIssue[], input: IssueInput) {
  issues.push({ ...input, summary: input.summary ?? input.message });
}

function formatIssues(issues: ValidationIssue[]): string[] {
  if (issues.length === 0) return ["- None"];
  return issues.map((issue) => {
    const pathSuffix = issue.path ? ` (${issue.path})` : "";
    return `- [${issue.code}] ${issue.message}${pathSuffix}`;
  });
}

function isSafeRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    !path.isAbsolute(relativePath) &&
    !relativePath.split(/[\\/]+/).includes("..")
  );
}

function hasInlineSecretValue(envRef: Record<string, unknown>): boolean {
  return ["value", "defaultValue", "secretValue", "token", "password"].some(
    (key) => typeof envRef[key] === "string" && String(envRef[key]).length > 0,
  );
}

function hasBusinessRoutingMetadata(channel: Record<string, unknown>): boolean {
  return [
    "commands",
    "commandRoutes",
    "intents",
    "routing",
    "router",
    "actionMap",
    "actions",
    "businessRules",
  ].some((key) => key in channel);
}

function findSuspiciousSecretValues(value: unknown, currentPath = "manifest"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findSuspiciousSecretValues(entry, `${currentPath}.${index}`));
  }
  if (!value || typeof value !== "object") return [];
  const paths: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = `${currentPath}.${key}`;
    if (typeof entry === "string" && isSecretValueKey(key) && entry.trim().length > 0) {
      paths.push(nextPath);
      continue;
    }
    paths.push(...findSuspiciousSecretValues(entry, nextPath));
  }
  return paths;
}

function isSecretValueKey(key: string): boolean {
  return /^(value|defaultValue|secretValue|token|password|apiKey|accessToken|refreshToken)$/i.test(key);
}
