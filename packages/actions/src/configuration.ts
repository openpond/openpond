import { promises as fs } from "node:fs";
import path from "node:path";

import { z } from "zod";

export const PROJECT_ACTION_CONFIG_PATH = "openpond/project-actions.json";

const connectionSchema = z.object({
  values: z.record(z.string(), z.unknown()).optional().default({}),
  environment: z.record(z.string(), z.string().trim().min(1)).optional().default({}),
}).strict();

const configSchema = z.object({
  sourceDirectory: z.string().trim().min(1).optional(),
  outputDirectory: z.string().trim().min(1).optional(),
  environment: z.record(z.string(), z.string().trim().min(1)).optional().default({}),
  connections: z.record(z.string(), connectionSchema).optional().default({}),
}).strict();

export type ProjectActionConfiguration = z.infer<typeof configSchema>;

export type ResolvedProjectActionRuntime = {
  environment: Record<string, string>;
  connections: Record<string, unknown>;
};

export async function loadProjectActionConfiguration(
  projectRoot: string,
): Promise<ProjectActionConfiguration> {
  const resolvedRoot = path.resolve(projectRoot);
  const configPath = path.join(resolvedRoot, PROJECT_ACTION_CONFIG_PATH);
  const raw = await fs.readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return configSchema.parse({});
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${PROJECT_ACTION_CONFIG_PATH} is not valid JSON: ${message}`);
  }
  return configSchema.parse(value);
}

export function resolveProjectActionRuntime(
  config: ProjectActionConfiguration,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
): ResolvedProjectActionRuntime {
  const environment: Record<string, string> = {};
  for (const [runtimeName, hostName] of Object.entries(config.environment)) {
    const value = hostEnvironment[hostName];
    if (value !== undefined) environment[runtimeName] = value;
  }
  const connections: Record<string, unknown> = {};
  for (const [name, descriptor] of Object.entries(config.connections)) {
    const value: Record<string, unknown> = { ...descriptor.values };
    for (const [property, hostName] of Object.entries(descriptor.environment)) {
      const environmentValue = hostEnvironment[hostName];
      if (environmentValue !== undefined) value[property] = environmentValue;
    }
    connections[name] = value;
  }
  return { environment, connections };
}
