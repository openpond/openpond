import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import { collectProjectActions, createProjectActionRegistry } from "./catalog.js";
import { loadProjectActionConfiguration } from "./configuration.js";
import { discoverProjectActionFiles } from "./discovery.js";
import { canonicalJson, sha256 } from "./hash.js";
import { validateProjectActionStaticSetup } from "./setup.js";
import type {
  ProjectActionBuildManifest,
  ProjectActionBuildResult,
  ProjectActionDefinition,
} from "./types.js";

export const DEFAULT_PROJECT_ACTION_OUTPUT_DIRECTORY = ".openpond/actions";

export async function buildProjectActions(input: {
  projectRoot: string;
  sourceDirectory?: string;
  outputDirectory?: string;
}): Promise<ProjectActionBuildResult> {
  const configuration = await loadProjectActionConfiguration(input.projectRoot);
  const discovered = await discoverProjectActionFiles({
    projectRoot: input.projectRoot,
    sourceDirectory: input.sourceDirectory ?? configuration.sourceDirectory,
  });
  const outputDirectory = path.resolve(
    discovered.projectRoot,
    input.outputDirectory ?? configuration.outputDirectory ?? DEFAULT_PROJECT_ACTION_OUTPUT_DIRECTORY,
  );
  assertWithinProject(discovered.projectRoot, outputDirectory);
  await fs.mkdir(outputDirectory, { recursive: true });

  const entryPath = path.join(outputDirectory, "entry.mjs");
  const bundlePath = path.join(outputDirectory, "bundle.mjs");
  const runnerPath = path.join(outputDirectory, "runner.mjs");
  const registryPath = path.join(outputDirectory, "action-registry.json");
  const manifestPath = path.join(outputDirectory, "build-manifest.json");
  const imports = discovered.files.map((file, index) => {
    const relative = path.relative(outputDirectory, path.join(discovered.projectRoot, file)).split(path.sep).join("/");
    const specifier = relative.startsWith(".") ? relative : `./${relative}`;
    return `import * as actionModule${index} from ${JSON.stringify(specifier)};`;
  });
  const modules = discovered.files.map((_file, index) => `actionModule${index}`).join(", ");
  await fs.writeFile(
    entryPath,
    [
      ...imports,
      `export const projectActionModules = [${modules}];`,
      "export default projectActionModules;",
      "",
    ].join("\n"),
    "utf8",
  );
  await build({
    entryPoints: [entryPath],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.14",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    nodePaths: dependencySearchPaths(discovered.projectRoot),
  });
  const cacheKey = `openpond_action_build=${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const loaded = await import(`${pathToFileURL(bundlePath).href}?${cacheKey}`) as {
    projectActionModules?: unknown[];
    default?: unknown[];
  };
  const actions = collectProjectActions(loaded.projectActionModules ?? loaded.default ?? []);
  for (const action of actions) {
    await validateProjectActionStaticSetup(discovered.projectRoot, action.setup);
  }
  const registry = createProjectActionRegistry(actions);
  await fs.writeFile(registryPath, canonicalJson(registry), "utf8");
  await fs.writeFile(runnerPath, runtimeSource(), { encoding: "utf8", mode: 0o755 });

  const bundleHash = sha256(await fs.readFile(bundlePath));
  const registryHash = sha256(canonicalJson(registry));
  const manifest: ProjectActionBuildManifest = {
    schemaVersion: "openpond.projectActionBuild.v1",
    sourceDirectory: path.relative(discovered.projectRoot, discovered.sourceRoot).split(path.sep).join("/"),
    sourceFiles: discovered.files,
    bundleFile: path.basename(bundlePath),
    runnerFile: path.basename(runnerPath),
    registryFile: path.basename(registryPath),
    bundleHash,
    registryHash,
  };
  await fs.writeFile(manifestPath, canonicalJson(manifest), "utf8");
  await fs.rm(entryPath, { force: true });
  return {
    projectRoot: discovered.projectRoot,
    outputDirectory,
    bundlePath,
    runnerPath,
    registryPath,
    manifestPath,
    registry,
    manifest,
  };
}

function dependencySearchPaths(projectRoot: string): string[] {
  const candidates: string[] = [];
  let current = projectRoot;
  while (true) {
    candidates.push(path.join(current, "node_modules"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../node_modules"));
  return [...new Set(candidates)];
}

export async function loadBuiltProjectActions(
  bundlePath: string,
): Promise<ProjectActionDefinition[]> {
  const stats = await fs.stat(bundlePath).catch(() => null);
  if (!stats?.isFile()) throw new Error(`Project Action bundle does not exist: ${bundlePath}`);
  const loaded = await import(`${pathToFileURL(bundlePath).href}?openpond_action_load=${Date.now()}`) as {
    projectActionModules?: unknown[];
    default?: unknown[];
  };
  return collectProjectActions(loaded.projectActionModules ?? loaded.default ?? []);
}

function assertWithinProject(projectRoot: string, target: string): void {
  const relative = path.relative(projectRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Project Action output directory must stay inside the Project root.");
  }
}

function runtimeSource(): string {
  return `#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { stdin } from "node:process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let requestText = "";
stdin.setEncoding("utf8");
for await (const chunk of stdin) requestText += chunk;
const request = JSON.parse(requestText);
const bundlePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "bundle.mjs");
const loaded = await import(pathToFileURL(bundlePath).href);
const values = [];
const seen = new Set();
const visit = (value) => {
  if (seen.has(value)) return;
  if (value && (typeof value === "object" || typeof value === "function")) seen.add(value);
  if (value?.kind === "openpond-project-action" && typeof value.run === "function") { values.push(value); return; }
  if (Array.isArray(value)) { value.forEach(visit); return; }
  if (value && typeof value === "object") Object.values(value).forEach(visit);
};
(loaded.projectActionModules ?? loaded.default ?? []).forEach(visit);
const action = values.find((candidate) => candidate.id === request.actionId);
if (!action) throw new Error(\`Unknown Project Action: \${request.actionId}\`);
const controller = new AbortController();
const timeoutMs = Math.min(request.timeoutMs ?? action.timeoutMs, action.timeoutMs);
const timer = setTimeout(() => controller.abort(new Error(\`Project Action timed out after \${timeoutMs}ms.\`)), timeoutMs);
const traces = [];
const outputs = [];
const env = request.environment ?? {};
const connections = request.connections ?? {};
const context = {
  runId: request.runId,
  actionId: action.id,
  idempotencyKey: request.idempotencyKey ?? null,
  projectRoot: request.projectRoot,
  outputDirectory: request.outputDirectory,
  signal: controller.signal,
  env(name) { return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined; },
  connection(name) {
    if (!Object.prototype.hasOwnProperty.call(connections, name)) throw new Error(\`Project Action connection is not configured: \${name}\`);
    return connections[name];
  },
  trace(name, payload) { traces.push({ name, ...(payload ? { payload } : {}), timestamp: new Date().toISOString() }); },
  output(value) {
    if (!value || typeof value.path !== "string" || !value.path.trim()) throw new Error("Project Action output requires a path.");
    const outputPath = path.resolve(request.outputDirectory, value.path);
    const relative = path.relative(request.outputDirectory, outputPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Project Action output must stay inside the run output directory.");
    outputs.push({ ...value, path: relative.split(path.sep).join("/") });
  },
};
try {
  const input = action.inputSchema.parse(request.input ?? {});
  const result = await Promise.race([
    Promise.resolve(action.run(context, input)),
    new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
  ]);
  const output = action.outputSchema.parse(result);
  for (const artifact of outputs) {
    const stats = await fs.stat(path.resolve(request.outputDirectory, artifact.path)).catch(() => null);
    if (!stats?.isFile()) throw new Error(\`Project Action output does not exist: \${artifact.path}\`);
  }
  await fs.writeFile(request.responseFile, JSON.stringify({ ok: true, output, traces, outputs }), "utf8");
} finally {
  clearTimeout(timer);
}
`;
}
