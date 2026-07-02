import type { SandboxActionCatalogEntry, SandboxProject } from "./sandbox-types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)))
    : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function schemaValue(value: unknown): string | Record<string, unknown> | null {
  return text(value) ?? asRecord(value);
}

export function actionCatalogForProject(
  project: SandboxProject | null | undefined,
): SandboxActionCatalogEntry[] {
  if (!project) return [];
  const registry = asRecord(project.sandboxActionRegistry);
  const manifest = asRecord(project.sandboxManifest);
  const byId = new Map<string, SandboxActionCatalogEntry>();

  for (const record of [
    ...records(manifest?.actionCatalog),
    ...records(registry?.actions),
    ...records(manifest?.actions),
  ]) {
    const id = text(record.id) ?? text(record.name);
    if (!id) continue;
    const existing = byId.get(id);
    byId.set(id, {
      id,
      name: text(record.name) ?? existing?.name ?? id,
      label: text(record.label) ?? existing?.label ?? titleFromActionId(id),
      description: text(record.description) ?? existing?.description ?? null,
      visibility: text(record.visibility) ?? existing?.visibility ?? "default",
      inputSchema: schemaValue(record.inputSchema) ?? existing?.inputSchema ?? null,
      outputSchema: schemaValue(record.outputSchema) ?? existing?.outputSchema ?? null,
      implementation: asRecord(record.implementation) ?? existing?.implementation ?? null,
      mcp: asRecord(record.mcp) ?? existing?.mcp ?? null,
      invokesModel:
        typeof record.invokesModel === "boolean"
          ? record.invokesModel
          : existing?.invokesModel,
    });
  }

  return Array.from(byId.values()).filter(
    (action) => action.visibility !== "internal" && action.visibility !== "debug",
  );
}

function titleFromActionId(id: string): string {
  const title = id.replace(/[._-]+/g, " ").trim();
  return title ? title.replace(/\b\w/g, (letter) => letter.toUpperCase()) : id;
}
