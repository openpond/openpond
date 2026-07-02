import { promises as fs } from "node:fs";
import path from "node:path";

export const WORKSPACE_TEMPLATE_CONFIG_PATH = "openpond.config.json";

export type WorkspaceTemplateConfigContract = {
  version: number | string | null;
  envVar: string;
  toolName: string | null;
  defaults: Record<string, unknown>;
  schema: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type WorkspaceTemplateConfigPatch = {
  contract: WorkspaceTemplateConfigContract;
  currentConfig: Record<string, unknown>;
  nextConfig: Record<string, unknown>;
  changedKeys: string[];
  unknownKeys: string[];
  replace: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertInside(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Path escapes the workspace root");
  }
}

function parseJsonRecord(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`${label} is not valid JSON: ${message}`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

export function parseConfigEnvValue(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function assertTemplateConfigEnvVar(envVar: string): string {
  const trimmed = envVar.trim();
  if (!/^OPENTOOL_PUBLIC_[A-Z0-9_]+$/.test(trimmed)) {
    throw new Error("Template config envVar must be an OPENTOOL_PUBLIC_* variable.");
  }
  return trimmed;
}

export async function loadWorkspaceTemplateConfig(
  repoPath: string,
  toolName?: string | null
): Promise<WorkspaceTemplateConfigContract> {
  const configPath = path.resolve(repoPath, WORKSPACE_TEMPLATE_CONFIG_PATH);
  assertInside(repoPath, configPath);
  const raw = parseJsonRecord(await fs.readFile(configPath, "utf8"), WORKSPACE_TEMPLATE_CONFIG_PATH);
  const envVar = typeof raw.envVar === "string" ? assertTemplateConfigEnvVar(raw.envVar) : "";
  if (!envVar) throw new Error(`${WORKSPACE_TEMPLATE_CONFIG_PATH} is missing envVar`);

  const declaredToolName = typeof raw.toolName === "string" && raw.toolName.trim() ? raw.toolName.trim() : null;
  const requestedToolName = typeof toolName === "string" && toolName.trim() ? toolName.trim() : null;
  if (requestedToolName && declaredToolName && requestedToolName !== declaredToolName) {
    throw new Error(`Template config for ${requestedToolName} was not found.`);
  }

  const defaults = isRecord(raw.defaults) ? raw.defaults : {};
  const schema = isRecord(raw.schema) ? raw.schema : {};
  if (Object.keys(defaults).length === 0) throw new Error(`${WORKSPACE_TEMPLATE_CONFIG_PATH} is missing defaults`);
  return {
    version: typeof raw.version === "number" || typeof raw.version === "string" ? raw.version : null,
    envVar,
    toolName: declaredToolName,
    defaults,
    schema,
    raw,
  };
}

function schemaProperties(schema: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return isRecord(schema?.properties) ? schema.properties : {};
}

function allowedKeysFor(schema: Record<string, unknown> | null | undefined, defaults: unknown): Set<string> {
  return new Set([
    ...Object.keys(schemaProperties(schema)),
    ...(isRecord(defaults) ? Object.keys(defaults) : []),
  ]);
}

function schemaForKey(schema: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const candidate = schemaProperties(schema)[key];
  return isRecord(candidate) ? candidate : null;
}

function unknownConfigPaths(
  patch: Record<string, unknown>,
  schema: Record<string, unknown> | null | undefined,
  defaults: Record<string, unknown>,
  prefix = ""
): string[] {
  const allowed = allowedKeysFor(schema, defaults);
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (!allowed.has(key)) {
      unknown.push(fullPath);
      continue;
    }
    const childSchema = schemaForKey(schema, key);
    const childDefaults = isRecord(defaults[key]) ? defaults[key] : {};
    if (
      isRecord(value) &&
      childSchema &&
      (childSchema.additionalProperties === false || Object.keys(schemaProperties(childSchema)).length > 0)
    ) {
      unknown.push(...unknownConfigPaths(value, childSchema, childDefaults, fullPath));
    }
  }
  return unknown;
}

export function deepMergeConfig(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value) && isRecord(output[key])) {
      output[key] = deepMergeConfig(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function prepareWorkspaceTemplateConfigPatch(input: {
  contract: WorkspaceTemplateConfigContract;
  currentEnvValue?: unknown;
  configPatch: Record<string, unknown>;
  replace?: boolean;
}): WorkspaceTemplateConfigPatch {
  const currentConfig = parseConfigEnvValue(input.currentEnvValue) ?? input.contract.defaults;
  const unknownKeys = unknownConfigPaths(input.configPatch, input.contract.schema, input.contract.defaults);
  const nextConfig = input.replace
    ? input.configPatch
    : deepMergeConfig(currentConfig, input.configPatch);
  return {
    contract: input.contract,
    currentConfig,
    nextConfig,
    changedKeys: Object.keys(input.configPatch).sort(),
    unknownKeys,
    replace: input.replace === true,
  };
}

export function templateConfigFileContentWithDefaults(
  contract: WorkspaceTemplateConfigContract,
  defaults: Record<string, unknown>
): string {
  return `${JSON.stringify(
    {
      ...contract.raw,
      defaults,
    },
    null,
    2
  )}\n`;
}
