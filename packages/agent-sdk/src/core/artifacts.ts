import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import type { AgentProjectDefinition } from "../index";
import { ARTIFACT_SCHEMAS, SDK_SCHEMA_VERSION, traceDir } from "./constants";
import type { CompiledPromptArtifacts } from "./prompts";
import { pathExists, writeJson } from "./files";

export type ArtifactIndexEntry = {
  path: string;
  kind:
    | "agent-manifest"
    | "action-registry"
    | "artifact-index"
    | "inspect"
    | "runtime-manifest-preview"
    | "runtime-bridge"
    | "validator-report"
    | "instructions"
    | "skill"
    | "skill-file"
    | "eval-results"
    | "trace-jsonl";
  schema: string;
  format: "json" | "jsonl" | "yaml" | "markdown" | "javascript";
};

export type ArtifactIndex = {
  schemaVersion: number;
  schema: string;
  artifactSchemas: typeof ARTIFACT_SCHEMAS;
  project: {
    name: string;
    version: string;
  };
  artifactDir: string;
  entries: ArtifactIndexEntry[];
};

export function createArtifactIndex(
  project: AgentProjectDefinition,
  artifactDir: string,
  options: {
    includeStandard?: boolean;
    promptArtifacts?: CompiledPromptArtifacts;
    extraEntries?: ArtifactIndexEntry[];
  } = {},
): ArtifactIndex {
  const entries = [
    ...(options.includeStandard === false ? [] : standardEntries(artifactDir)),
    ...promptEntries(options.promptArtifacts),
    ...(options.extraEntries ?? []),
  ];
  return {
    schemaVersion: SDK_SCHEMA_VERSION,
    schema: ARTIFACT_SCHEMAS.artifactIndex,
    artifactSchemas: ARTIFACT_SCHEMAS,
    project: { name: project.name, version: project.version },
    artifactDir,
    entries: dedupeEntries(entries),
  };
}

export async function writeArtifactIndex(
  cwd: string,
  project: AgentProjectDefinition,
  artifactDir: string,
  options: {
    includeStandard?: boolean;
    promptArtifacts?: CompiledPromptArtifacts;
    extraEntries?: ArtifactIndexEntry[];
    mergeExisting?: boolean;
  } = {},
): Promise<ArtifactIndex> {
  const index = createArtifactIndex(project, artifactDir, options);
  if (options.mergeExisting !== false) {
    const existing = await readExistingIndex(cwd, artifactDir);
    if (existing) index.entries = dedupeEntries([...existingEntriesThatStillExist(cwd, existing), ...index.entries]);
  }
  await writeJson(cwd, path.join(artifactDir, "artifact-index.json"), index);
  return index;
}

export async function assertArtifactSchemaCompatibility(
  cwd: string,
  index: ArtifactIndex,
) {
  for (const entry of index.entries) {
    if (entry.format === "json") {
      const payload = JSON.parse(await readFile(path.join(cwd, entry.path), "utf8")) as {
        schema?: string;
      };
      assertSchema(entry, payload.schema);
      continue;
    }
    if (entry.format === "jsonl") {
      const contents = await readFile(path.join(cwd, entry.path), "utf8");
      for (const line of contents.split("\n").filter(Boolean)) {
        const payload = JSON.parse(line) as { schema?: string };
        assertSchema(entry, payload.schema);
      }
      continue;
    }
    if (entry.format === "yaml") {
      const payload = parseYaml(await readFile(path.join(cwd, entry.path), "utf8")) as {
        schema?: string;
      };
      assertSchema(entry, payload?.schema);
      continue;
    }
    if (entry.kind === "validator-report") {
      const contents = await readFile(path.join(cwd, entry.path), "utf8");
      if (!contents.includes(`Schema: ${entry.schema}`)) {
        throw new Error(`${entry.path} does not declare schema ${entry.schema}.`);
      }
      continue;
    }
    if (entry.kind === "runtime-bridge") {
      const contents = await readFile(path.join(cwd, entry.path), "utf8");
      if (!contents.includes(entry.schema)) {
        throw new Error(`${entry.path} does not declare schema ${entry.schema}.`);
      }
    }
  }
}

export function evalResultsEntry(artifactDir: string): ArtifactIndexEntry {
  return {
    path: path.join(artifactDir, "eval-results.json"),
    kind: "eval-results",
    schema: ARTIFACT_SCHEMAS.evalResults,
    format: "json",
  };
}

export function traceEntry(traceArtifactRef: string): ArtifactIndexEntry {
  return {
    path: traceArtifactRef,
    kind: "trace-jsonl",
    schema: ARTIFACT_SCHEMAS.trace,
    format: "jsonl",
  };
}

function standardEntries(artifactDir: string): ArtifactIndexEntry[] {
  return [
    {
      path: path.join(artifactDir, "artifact-index.json"),
      kind: "artifact-index",
      schema: ARTIFACT_SCHEMAS.artifactIndex,
      format: "json",
    },
    {
      path: path.join(artifactDir, "agent-manifest.json"),
      kind: "agent-manifest",
      schema: ARTIFACT_SCHEMAS.agentManifest,
      format: "json",
    },
    {
      path: path.join(artifactDir, "action-registry.json"),
      kind: "action-registry",
      schema: ARTIFACT_SCHEMAS.actionRegistry,
      format: "json",
    },
    {
      path: path.join(artifactDir, "agent-inspect.json"),
      kind: "inspect",
      schema: ARTIFACT_SCHEMAS.inspect,
      format: "json",
    },
    {
      path: path.join(artifactDir, "openpond-manifest.preview.yaml"),
      kind: "runtime-manifest-preview",
      schema: ARTIFACT_SCHEMAS.runtimeManifest,
      format: "yaml",
    },
    {
      path: path.join(artifactDir, "runtime-bridge.mjs"),
      kind: "runtime-bridge",
      schema: ARTIFACT_SCHEMAS.runtimeBridge,
      format: "javascript",
    },
    {
      path: path.join(artifactDir, "validator-report.md"),
      kind: "validator-report",
      schema: ARTIFACT_SCHEMAS.validatorReport,
      format: "markdown",
    },
  ];
}

function promptEntries(promptArtifacts: CompiledPromptArtifacts | undefined): ArtifactIndexEntry[] {
  if (!promptArtifacts) return [];
  const entries: ArtifactIndexEntry[] = [];
  if (promptArtifacts.instructions) {
    entries.push({
      path: promptArtifacts.instructions.artifactRef,
      kind: "instructions",
      schema: ARTIFACT_SCHEMAS.instructions,
      format: "markdown",
    });
  }
  for (const skill of promptArtifacts.skills) {
    entries.push({
      path: skill.artifactRef,
      kind: "skill",
      schema: ARTIFACT_SCHEMAS.skill,
      format: "markdown",
    });
    for (const file of skill.files) {
      entries.push({
        path: file.artifactRef,
        kind: "skill-file",
        schema: ARTIFACT_SCHEMAS.skill,
        format: "markdown",
      });
    }
  }
  return entries;
}

function dedupeEntries(entries: ArtifactIndexEntry[]): ArtifactIndexEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.path}:${entry.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readExistingIndex(cwd: string, artifactDir: string): Promise<ArtifactIndex | null> {
  const indexPath = path.join(cwd, artifactDir, "artifact-index.json");
  if (!pathExists(indexPath)) return null;
  const parsed = JSON.parse(await readFile(indexPath, "utf8")) as ArtifactIndex;
  return parsed.schema === ARTIFACT_SCHEMAS.artifactIndex ? parsed : null;
}

function existingEntriesThatStillExist(cwd: string, index: ArtifactIndex): ArtifactIndexEntry[] {
  return index.entries.filter((entry) => pathExists(path.join(cwd, entry.path)));
}

function assertSchema(entry: ArtifactIndexEntry, actual: string | undefined) {
  if (actual !== entry.schema) {
    throw new Error(`${entry.path} schema mismatch: expected ${entry.schema}, received ${actual ?? "none"}.`);
  }
}
