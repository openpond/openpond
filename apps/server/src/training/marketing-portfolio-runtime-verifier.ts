import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { Taskset } from "@openpond/contracts";
import { contentHash, sha256 } from "@openpond/taskset-sdk";

const AGENT_ID = "marketing-portfolio-manager";
const ACTION_IDS = [
  "get-portfolio-snapshot",
  "submit-budget-decision",
] as const;

export async function verifyMarketingPortfolioRuntime(input: {
  taskset: Taskset;
  harnessRoot: string;
}) {
  const benchmark = object(
    input.taskset.environment.metadata.benchmark,
    "marketing benchmark metadata",
  );
  if (benchmark.id !== "marketing-portfolio-v1") {
    throw new Error("Taskset is not the marketing-portfolio-v1 benchmark.");
  }
  const scorer = object(benchmark.scorer, "marketing benchmark scorer");
  const relativeAgentPath = requiredString(
    scorer.profileRelativeAgentPath,
    "marketing Harness Agent path",
  );
  const profileRoot = path.resolve(input.harnessRoot);
  const agentRoot = path.resolve(profileRoot, relativeAgentPath);
  const relative = path.relative(profileRoot, agentRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Pinned marketing Agent source escapes the Harness bundle.");
  }
  const manifestPath = path.join(agentRoot, ".openpond", "agent-manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = object(
    JSON.parse(manifestBytes.toString("utf8")),
    "Harness Agent manifest",
  );
  const project = object(manifest.project, "Harness Agent project");
  if (
    project.name !== AGENT_ID ||
    project.useCase !== "cmo-budget-allocation-benchmark"
  ) {
    throw new Error("Pinned marketing Agent identity changed.");
  }
  const inventory = await agentReleaseInventory(agentRoot);
  const agentReleaseHash = contentHash({
    agentId: AGENT_ID,
    inventory,
    manifest: sha256(manifestBytes),
  });
  const bindings = input.taskset.environment.actionBindings ?? [];
  if (
    bindings.length !== ACTION_IDS.length ||
    ACTION_IDS.some((actionId, index) => bindings[index]?.actionId !== actionId)
  ) {
    throw new Error("Marketing Taskset action bindings changed or are incomplete.");
  }
  const agentRelease = bindings[0]!.agentRelease;
  if (
    agentRelease.contentHash !== agentReleaseHash ||
    bindings.some(
      (binding) =>
        binding.agentRelease.id !== agentRelease.id ||
        binding.agentRelease.contentHash !== agentRelease.contentHash,
    )
  ) {
    throw new Error("Pinned marketing Agent release no longer matches local source.");
  }
  const actionCatalog = array(manifest.actionCatalog, "Agent action catalog").map(
    (value) => object(value, "Agent action"),
  );
  const inputSchemas = object(manifest.inputSchemas, "Agent input schemas");
  for (const binding of bindings) {
    const action = actionCatalog.find(
      (candidate) => candidate.id === binding.actionId,
    );
    if (!action) throw new Error(`Pinned Agent action ${binding.actionId} is missing.`);
    const schemaName = requiredString(
      action.inputSchema,
      `${binding.actionId} input schema`,
    );
    const schema = object(inputSchemas[schemaName], `${binding.actionId} schema`);
    const projected = withoutEpisodeSelector(schema, "scenarioId");
    const implementationHash = contentHash({
      agentReleaseHash,
      action,
      actionSchema: schema,
    });
    if (
      binding.actionSchemaHash !== contentHash(projected) ||
      binding.implementationHash !== implementationHash ||
      contentHash(binding.inputSchema) !== contentHash(projected)
    ) {
      throw new Error(`Pinned Agent action ${binding.actionId} drifted.`);
    }
  }
  const scorerModule = requiredString(scorer.module, "marketing scorer module");
  const scorerModulePath = path.resolve(agentRoot, scorerModule);
  const relativeScorer = path.relative(agentRoot, scorerModulePath);
  if (relativeScorer.startsWith("..") || path.isAbsolute(relativeScorer)) {
    throw new Error("Pinned marketing scorer escapes the Agent release.");
  }
  const scorerImplementationHash = sha256(await readFile(scorerModulePath));
  if (
    scorerImplementationHash !==
    requiredString(scorer.implementationHash, "scorer implementation hash")
  ) {
    throw new Error("Pinned marketing scorer implementation changed.");
  }
  return { agentRoot, scorerModulePath, scorerImplementationHash };
}

function withoutEpisodeSelector(
  schema: Record<string, unknown>,
  selector: string,
): Record<string, unknown> {
  const properties = object(schema.properties, "Agent schema properties");
  if (!(selector in properties)) {
    throw new Error(`Agent action schema does not declare ${selector}.`);
  }
  const { [selector]: _selector, ...visibleProperties } = properties;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value) => value !== selector)
    : [];
  return {
    ...structuredClone(schema),
    properties: visibleProperties,
    required,
    additionalProperties: false,
  };
}

async function agentReleaseInventory(root: string) {
  const inventory = [];
  for (const file of await regularFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (
      relative.startsWith("node_modules/") ||
      relative.startsWith(".openpond/traces/") ||
      relative === ".openpond/eval-results.json"
    ) {
      continue;
    }
    const bytes = await readFile(file);
    inventory.push({
      path: relative,
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
    });
  }
  return inventory.sort((left, right) => left.path.localeCompare(right.path));
}

async function regularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error("Harness Agent releases cannot contain symlinks.");
    }
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...(await regularFiles(target)));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }
  return files;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}
