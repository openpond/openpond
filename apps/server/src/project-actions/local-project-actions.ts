import path from "node:path";
import { promises as fs } from "node:fs";

import {
  OpenPondActionCatalogEntrySchema,
  type LocalProject,
  type OpenPondActionCatalogEntry,
} from "@openpond/contracts";
import {
  createLocalActionRunner,
  loadProjectActionConfiguration,
  PROJECT_ACTION_CONFIG_PATH,
} from "openpond-sdk/actions/local";

export async function localProjectActionCatalog(
  project: Pick<LocalProject, "id" | "workspacePath">,
): Promise<OpenPondActionCatalogEntry[]> {
  const sourceDirectory = await projectActionSourceDirectory(project.workspacePath);
  const sourceStats = await fs.stat(sourceDirectory).catch(() => null);
  if (!sourceStats?.isDirectory()) return [];
  const runner = createLocalActionRunner({
    projectRoot: project.workspacePath,
    build: "always",
  });
  const registry = await runner.catalog();
  return registry.actions.map((action) =>
    OpenPondActionCatalogEntrySchema.parse({
      ...action,
      sourcePath: project.workspacePath,
      implementation: {
        ...action.implementation,
        projectId: project.id,
        projectRoot: path.resolve(project.workspacePath),
      },
    }),
  );
}

export async function runLocalProjectAction(input: {
  projectRoot: string;
  actionId: string;
  value: unknown;
  runId?: string;
  idempotencyKey?: string | null;
  signal?: AbortSignal;
}) {
  return createLocalActionRunner({
    projectRoot: input.projectRoot,
    build: "always",
  }).run({
    actionId: input.actionId,
    input: input.value,
    runId: input.runId,
    idempotencyKey: input.idempotencyKey,
    signal: input.signal,
  });
}

async function projectActionSourceDirectory(projectRoot: string): Promise<string> {
  try {
    const configuration = await loadProjectActionConfiguration(projectRoot);
    return path.resolve(projectRoot, configuration.sourceDirectory ?? "openpond/actions");
  } catch (error) {
    throw new Error(
      `Cannot load ${PROJECT_ACTION_CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
