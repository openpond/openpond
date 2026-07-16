import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";
import { parse as parseYaml } from "yaml";

import type {
  ActionDefinition,
  AgentProjectDefinition,
  IntegrationDefinition,
  ScheduleDefinition,
  VolumeDefinition,
  WorkflowDefinition,
} from "../index";
import { DEFAULT_AGENT_CONFIG, OPENPOND_MANIFEST } from "./constants";
import { isRecord } from "./schema";

export type AgentProjectSourceMode =
  | "typescript"
  | "openpond-yaml"
  | "extends-openpond-yaml";

export type LoadedAgentProject = {
  project: AgentProjectDefinition;
  source: {
    mode: AgentProjectSourceMode;
    configPath: string;
    extendsManifest?: string;
  };
};

let typescriptLoaderRegistered = false;

export async function loadAgentProject(cwd: string): Promise<AgentProjectDefinition> {
  return (await loadAgentProjectContext(cwd)).project;
}

export async function loadAgentProjectContext(cwd: string): Promise<LoadedAgentProject> {
  const tsConfigPath = path.resolve(cwd, DEFAULT_AGENT_CONFIG);
  const yamlPath = path.resolve(cwd, OPENPOND_MANIFEST);
  const hasTypescriptConfig = await canAccess(tsConfigPath);
  const hasOpenPondManifest = await canAccess(yamlPath);

  if (hasTypescriptConfig) {
    const project = await loadTypescriptProject(tsConfigPath);
    const mode = project.manifestMode === "extends-openpond-yaml"
      ? "extends-openpond-yaml"
      : "typescript";
    return {
      project,
      source: {
        mode,
        configPath: DEFAULT_AGENT_CONFIG,
        ...(mode === "extends-openpond-yaml"
          ? { extendsManifest: project.extendsManifest ?? OPENPOND_MANIFEST }
          : {}),
      },
    };
  }

  if (hasOpenPondManifest) {
    const project = await loadOpenPondYamlProject(yamlPath);
    return {
      project,
      source: {
        mode: "openpond-yaml",
        configPath: OPENPOND_MANIFEST,
      },
    };
  }

  throw new Error(`${DEFAULT_AGENT_CONFIG} or ${OPENPOND_MANIFEST} is required.`);
}

async function loadTypescriptProject(configPath: string): Promise<AgentProjectDefinition> {
  await access(configPath);
  ensureTypescriptLoader();
  const cacheKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const moduleUrl = `${pathToFileURL(configPath).href}?openpondAgent=${cacheKey}`;
  const mod = (await import(moduleUrl)) as {
    default?: AgentProjectDefinition;
  };
  if (!mod.default) {
    throw new Error(`${DEFAULT_AGENT_CONFIG} must export a default agent project.`);
  }
  return mod.default;
}

function ensureTypescriptLoader() {
  if (typescriptLoaderRegistered) return;
  register();
  typescriptLoaderRegistered = true;
}

async function loadOpenPondYamlProject(configPath: string): Promise<AgentProjectDefinition> {
  const parsed = parseYaml(await readFile(configPath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${OPENPOND_MANIFEST} must contain a YAML object.`);
  }

  const actions = yamlActions(parsed);
  const workflows = actions.map(commandWorkflow);
  return {
    name: stringValue(parsed.name, "openpond-yaml-agent"),
    version: stringValue(parsed.version, "0.0.0"),
    useCase: stringValue(parsed.useCase, stringValue(parsed.name, "openpond-yaml-agent")),
    description: optionalString(parsed.description),
    manifestMode: "openpond-yaml",
    runtime: isRecord(parsed.runtime) ? parsed.runtime : { base: "node-bun-workspace" },
    resources: isRecord(parsed.resources) ? parsed.resources : undefined,
    setup: commandsBlock(parsed.setup),
    validation: commandsBlock(parsed.validation),
    defaultAction: actions[0]?.name,
    actions,
    workflows,
    volumes: yamlVolumes(parsed),
    schedules: yamlSchedules(parsed),
    integrations: yamlIntegrations(parsed),
    env: yamlEnv(parsed),
  };
}

async function canAccess(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function yamlActions(manifest: Record<string, unknown>): ActionDefinition[] {
  const manifestActions = Array.isArray(manifest.actions) ? manifest.actions : [];
  const actions = manifestActions
    .filter(isRecord)
    .map((entry) => actionFromYaml(entry));
  if (actions.length > 0) return actions;
  const start = isRecord(manifest.start) ? manifest.start : {};
  return [actionFromYaml({ ...start, name: "chat" })];
}

function actionFromYaml(entry: Record<string, unknown>): ActionDefinition {
  const name = stringValue(entry.name, "chat");
  const artifactPaths = Array.isArray(entry.artifactPaths)
    ? entry.artifactPaths.filter((item): item is string => typeof item === "string")
    : [];
  return {
    name,
    description: optionalString(entry.description) ?? optionalString(entry.command),
    target: { kind: "workflow", workflow: `${name}-command` },
    timeoutSeconds: numberValue(entry.timeoutSeconds),
    outputArtifacts: artifactPaths,
  };
}

function commandWorkflow(action: ActionDefinition): WorkflowDefinition {
  return {
    kind: "workflow",
    name: `${action.name}-command`,
    description: `Command-backed workflow imported from ${OPENPOND_MANIFEST}.`,
    async run(_ctx, input) {
      return {
        text: `Command-backed action ${action.name} is inspectable locally.`,
        intent: action.name,
        metadata: { input },
      };
    },
  };
}

function yamlVolumes(manifest: Record<string, unknown>): VolumeDefinition[] {
  const volumes = Array.isArray(manifest.volumes) ? manifest.volumes : [];
  return volumes.filter(isRecord).map((entry) => ({
    name: stringValue(entry.name, "volume"),
    mountPath: stringValue(entry.mountPath, "/workspace/volumes/volume"),
    storageGb: numberValue(entry.storageGb),
    deleteOnSandboxDelete: booleanValue(entry.deleteOnSandboxDelete),
    provisioning: {
      mode: "select-or-create",
      scope: "project",
      create: {
        storageGb: numberValue(entry.storageGb) ?? 1,
        retention: booleanValue(entry.deleteOnSandboxDelete) === false
          ? "retain"
          : "delete-with-sandbox",
      },
    },
    state: { engine: "filesystem" },
  }));
}

function yamlSchedules(manifest: Record<string, unknown>): ScheduleDefinition[] {
  const schedules = Array.isArray(manifest.schedules) ? manifest.schedules : [];
  return schedules.filter(isRecord).map((entry) => ({
    kind: "schedule",
    name: stringValue(entry.name, "schedule"),
    scheduleType: typeof entry.cron === "string" ? "cron" : "rate",
    target: { action: stringValue(entry.action, stringValue(entry.targetAction, "chat")) },
    enabledByDefault: booleanValue(entry.enabled) ?? false,
    input: isRecord(entry.metadata) && isRecord(entry.metadata.input)
      ? entry.metadata.input
      : undefined,
    cron: optionalString(entry.cron),
    rate: optionalString(entry.rate),
    timezone: optionalString(entry.timezone),
  }));
}

function yamlIntegrations(manifest: Record<string, unknown>): IntegrationDefinition[] {
  const integrations: IntegrationDefinition[] = [];
  const requiredLeases = isRecord(manifest.integrations) && Array.isArray(manifest.integrations.requiredLeases)
    ? manifest.integrations.requiredLeases
    : [];
  for (const lease of requiredLeases.filter(isRecord)) {
    integrations.push({
      provider: stringValue(lease.provider, "integration"),
      required: true,
      scopes: stringArray(lease.scopes),
      capabilities: stringArray(lease.capabilities),
    });
  }
  if (isRecord(manifest.permissions) && isRecord(manifest.permissions.opchat)) {
    integrations.push({
      provider: "opchat",
      required: false,
      scopes: stringArray(manifest.permissions.opchat.scopes),
      models: stringArray(manifest.permissions.opchat.models),
    });
  }
  return integrations;
}

function yamlEnv(manifest: Record<string, unknown>) {
  const env = isRecord(manifest.inputs) && Array.isArray(manifest.inputs.env)
    ? manifest.inputs.env
    : [];
  return env.filter(isRecord).map((entry) => ({
    kind: "env" as const,
    name: stringValue(entry.name, "ENV_NAME"),
    required: booleanValue(entry.required) ?? false,
    secret: booleanValue(entry.secret) ?? true,
    description: optionalString(entry.description),
  }));
}

function commandsBlock(value: unknown) {
  if (!isRecord(value)) return undefined;
  return { commands: stringArray(value.commands) };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
