import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type {
  OpenPondProfileActionCatalogEntry,
  OpenPondProfileCatalogState,
} from "./local-profile-types.js";

const AGENT_MANIFEST_PATH = ".openpond/agent-manifest.json";
const ACTION_REGISTRY_PATH = ".openpond/action-registry.json";
const SOURCE_UPLOAD_METADATA_PATH = ".openpond/source-upload-metadata.json";

type LoadedProfileCatalog = {
  catalog: OpenPondProfileCatalogState;
  actionCatalog: OpenPondProfileActionCatalogEntry[];
  sourceSetupRequirements: Record<string, unknown>[];
};

export type ProfileActionCatalogSource = {
  agentId: string;
  sourcePath: string;
  preferred?: boolean;
};

export async function loadProfileActionCatalog(sourcePath: string): Promise<LoadedProfileCatalog> {
  return loadProfileActionCatalogSource({
    agentId: "default",
    sourcePath,
    preferred: true,
  });
}

export async function loadProfileActionCatalogForSources(
  sources: ProfileActionCatalogSource[],
): Promise<LoadedProfileCatalog> {
  if (sources.length === 0) {
    return {
      catalog: {
        actionCount: 0,
        generatedAt: null,
        manifestPath: null,
        registryPath: null,
        stale: true,
        error: "No profile agent sources are enabled.",
      },
      actionCatalog: [],
      sourceSetupRequirements: [],
    };
  }
  const sortedSources = [
    ...sources.filter((source) => source.preferred),
    ...sources.filter((source) => !source.preferred),
  ];
  const results = await Promise.all(sortedSources.map(loadProfileActionCatalogSource));
  const byId = new Map<string, OpenPondProfileActionCatalogEntry>();
  const actionCatalog: OpenPondProfileActionCatalogEntry[] = [];
  for (const result of results) {
    for (const action of result.actionCatalog) {
      const uniqueId = byId.has(action.id)
        ? `${action.agentId ?? "agent"}.${action.sourceActionId ?? action.id}`
        : action.id;
      const next = uniqueId === action.id ? action : { ...action, id: uniqueId };
      byId.set(uniqueId, next);
      actionCatalog.push(next);
    }
  }
  const generatedAt = latestIso(results.map((result) => result.catalog.generatedAt));
  const errors = results.map((result) => result.catalog.error).filter(Boolean);
  return {
    catalog: {
      actionCount: actionCatalog.length,
      generatedAt,
      manifestPath: results.find((result) => result.catalog.manifestPath)?.catalog.manifestPath ?? null,
      registryPath: results.find((result) => result.catalog.registryPath)?.catalog.registryPath ?? null,
      stale: results.some((result) => result.catalog.stale),
      error: errors.length > 0 ? errors.join("; ") : null,
    },
    actionCatalog,
    sourceSetupRequirements: results.flatMap((result) => result.sourceSetupRequirements),
  };
}

async function loadProfileActionCatalogSource(
  source: ProfileActionCatalogSource,
): Promise<LoadedProfileCatalog> {
  const sourcePath = source.sourcePath;
  const manifestPath = path.join(sourcePath, AGENT_MANIFEST_PATH);
  const registryPath = path.join(sourcePath, ACTION_REGISTRY_PATH);
  const sourceUploadMetadataPath = path.join(sourcePath, SOURCE_UPLOAD_METADATA_PATH);
  try {
    const manifest = await readJsonIfExists(manifestPath);
    const registry = await readJsonIfExists(registryPath);
    const sourceUploadMetadata = await readJsonIfExists(sourceUploadMetadataPath);
    const sourceSetupRequirements =
      recordArray(asRecord(sourceUploadMetadata)?.setupRequirements) ?? [];
    const byId = new Map<string, OpenPondProfileActionCatalogEntry>();

    for (const record of [
      ...records(asRecord(manifest)?.actionCatalog),
      ...records(asRecord(registry)?.actions),
      ...records(asRecord(manifest)?.actions),
    ]) {
      const id = text(record.id) ?? text(record.name);
      if (!id) continue;
      const existing = byId.get(id);
      const next: OpenPondProfileActionCatalogEntry = {
        id,
        agentId: source.agentId,
        sourcePath,
        sourceActionId: id,
        name: text(record.name) ?? existing?.name ?? id,
        label: text(record.label) ?? existing?.label ?? titleFromActionId(id),
        description: text(record.description) ?? existing?.description ?? null,
        visibility: text(record.visibility) ?? existing?.visibility ?? "default",
        inputSchema: schemaValue(record.inputSchema) ?? existing?.inputSchema ?? null,
        outputSchema: schemaValue(record.outputSchema) ?? existing?.outputSchema ?? null,
        approvalPolicy: asRecord(record.approvalPolicy) ?? existing?.approvalPolicy ?? null,
        artifactPolicy: asRecord(record.artifactPolicy) ?? existing?.artifactPolicy ?? null,
        setupRequirements: recordArray(record.setupRequirements) ?? existing?.setupRequirements ?? [],
        mcp: asRecord(record.mcp) ?? existing?.mcp ?? null,
        schedulePolicy: asRecord(record.schedulePolicy) ?? existing?.schedulePolicy ?? null,
        trace: asRecord(record.trace) ?? existing?.trace ?? null,
        implementation: asRecord(record.implementation) ?? existing?.implementation ?? null,
        invokesModel:
          typeof record.invokesModel === "boolean"
            ? record.invokesModel
            : existing?.invokesModel,
      };
      byId.set(id, next);
    }

    const actionCatalog = Array.from(byId.values()).filter(
      (action) => action.visibility !== "internal" && action.visibility !== "debug",
    );
    const missingArtifacts = [
      ...(!manifest ? [AGENT_MANIFEST_PATH] : []),
      ...(!registry ? [ACTION_REGISTRY_PATH] : []),
    ];
    const generatedAt = await latestMtime([manifestPath, registryPath]);
    return {
      catalog: {
        actionCount: actionCatalog.length,
        generatedAt,
        manifestPath: existsSync(manifestPath) ? manifestPath : null,
        registryPath: existsSync(registryPath) ? registryPath : null,
        stale: missingArtifacts.length > 0,
        error: missingArtifacts.length > 0
          ? missingSourceArtifactsMessage(source, missingArtifacts)
          : null,
      },
      actionCatalog,
      sourceSetupRequirements,
    };
  } catch (error) {
    return {
      catalog: {
        actionCount: 0,
        generatedAt: null,
        manifestPath: existsSync(manifestPath) ? manifestPath : null,
        registryPath: existsSync(registryPath) ? registryPath : null,
        stale: true,
        error: error instanceof Error ? error.message : String(error),
      },
      actionCatalog: [],
      sourceSetupRequirements: [],
    };
  }
}

function latestIso(values: Array<string | null>): string | null {
  let latest = 0;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time)) latest = Math.max(latest, time);
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function missingSourceArtifactsMessage(source: ProfileActionCatalogSource, missingArtifacts: string[]): string {
  return [
    `Profile agent ${source.agentId} at ${source.sourcePath} is missing SDK catalog artifact(s): ${missingArtifacts.join(", ")}.`,
    "Run `openpond profile check --kind all` after source materialization so each enabled profile agent has inspect/build artifacts.",
  ].join(" ");
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  if (!existsSync(filePath)) return null;
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function latestMtime(filePaths: string[]): Promise<string | null> {
  let latest = 0;
  for (const filePath of filePaths) {
    if (!existsSync(filePath)) continue;
    const fileStat = await stat(filePath);
    latest = Math.max(latest, fileStat.mtimeMs);
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

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

function recordArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function schemaValue(value: unknown): string | Record<string, unknown> | null {
  return text(value) ?? asRecord(value);
}

function titleFromActionId(id: string): string {
  const title = id.replace(/[._-]+/g, " ").trim();
  return title ? title.replace(/\b\w/g, (letter) => letter.toUpperCase()) : id;
}
