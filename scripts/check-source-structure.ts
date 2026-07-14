import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionRoots = [path.join(root, "apps"), path.join(root, "packages")];
const handwrittenRoots = [...productionRoots, path.join(root, "tests"), path.join(root, "scripts")];
const cycleRoots = [
  path.join(root, "apps/server/src/runtime"),
  path.join(root, "apps/server/src/openpond"),
];
const maxRuntimeCycles = 0;
const maxHandwrittenLines = 1_999;
const maxNewProductionLines = 999;
const productionLineLimitAllowlist = new Set([
  "apps/cli/src/cli/profile.ts",
  "apps/cli/src/cli/project-source-upload.ts",
  "apps/desktop/src/desktop-browser-sidebar.ts",
  "apps/server/src/api/routes/sandbox-routes.ts",
  "apps/server/src/api/server-payloads.ts",
  "apps/server/src/codex-history.ts",
  "apps/server/src/index.ts",
  "apps/server/src/insights/create-edit-insights.ts",
  "apps/server/src/openpond/model-tool-registry.ts",
  "apps/server/src/openpond/openai-compatible-provider.ts",
  "apps/server/src/openpond/resources.ts",
  "apps/server/src/openpond/sandboxes.ts",
  "apps/server/src/runtime/codex-bridge.ts",
  "apps/server/src/runtime/subagent-lifecycle-watcher.ts",
  "apps/server/src/runtime/turn-runner.ts",
  "apps/server/src/store/store.ts",
  "apps/server/src/workspace/workspace-lsp.ts",
  "apps/server/src/workspace-tools/workspace-tool-app-handlers.ts",
  "apps/server/src/workspace-tools/workspace-tool-sandbox-actions.ts",
  "apps/web/src/api.ts",
  "apps/web/src/App.tsx",
  "apps/web/src/components/app-shell/MainPane.tsx",
  "apps/web/src/components/chat/Composer.tsx",
  "apps/web/src/components/chat/WorkspaceEnvironmentMenu.tsx",
  "apps/web/src/components/settings/ProfileSettingsSection.tsx",
  "apps/web/src/components/sidebar/SidebarRows.tsx",
  "apps/web/src/components/workspace-diff/WorkspaceDiffPanel.tsx",
  "apps/web/src/hooks/useChatActions.ts",
  "apps/web/src/hooks/useTeamChat.ts",
  "apps/web/src/styles/chat/chat.css",
  "apps/web/src/styles/chat/composer.css",
  "apps/web/src/styles/settings/settings-forms.css",
  "apps/web/src/styles/sidebar/sidebar.css",
  "packages/cloud/src/api.ts",
  "packages/cloud/src/config.ts",
  "packages/cloud/src/profile/local-profile.ts",
  "packages/cloud/src/sandbox/client.ts",
  "packages/cloud/src/sandbox-template/manifest.ts",
]);
const extractedTurnDomains = ["turns", "hosted-turn", "subagents", "goals", "create-pipeline"];

async function main(): Promise<void> {
  const handwrittenFiles = (await Promise.all(handwrittenRoots.map(walk))).flat().filter(isHandwrittenCode);
  const files = handwrittenFiles.filter(isProductionSource);
  const errors: string[] = [];
  const cycleFiles = files.filter((file) => cycleRoots.some((cycleRoot) => isWithin(file, cycleRoot)));
  const graph = await buildImportGraph(cycleFiles);
  const cycles = findCycles(graph);

  errors.push(...await checkFileLineLimits(handwrittenFiles, files));

  if (cycles.length > maxRuntimeCycles) {
    errors.push(`runtime/openpond module cycles increased: ${cycles.length} found, maximum is ${maxRuntimeCycles}`);
  }
  for (const cycle of cycles) console.log(`[module-cycle] ${cycle.map(relative).join(" -> ")}`);
  errors.push(...checkTurnDomainDirection(graph));

  if (errors.length > 0) {
    for (const error of errors) console.error(`[structure-error] ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Source structure check passed: ${files.length} production modules, ${handwrittenFiles.length} hand-written code files, ${cycles.length} runtime/openpond cycles.`,
  );
}

async function checkFileLineLimits(handwrittenFiles: string[], productionFiles: string[]): Promise<string[]> {
  const production = new Set(productionFiles);
  const errors: string[] = [];
  for (const file of handwrittenFiles) {
    const lineCount = physicalLineCount(await readFile(file, "utf8"));
    const fileName = relative(file);
    if (lineCount > maxHandwrittenLines) {
      errors.push(`${fileName}: ${lineCount} lines exceeds the repository maximum of ${maxHandwrittenLines}`);
    }
    if (
      production.has(file) &&
      lineCount > maxNewProductionLines &&
      !productionLineLimitAllowlist.has(fileName)
    ) {
      errors.push(`${fileName}: ${lineCount} lines exceeds the new-production-module maximum of ${maxNewProductionLines}`);
    }
  }
  return errors;
}

function physicalLineCount(source: string): number {
  if (!source) return 0;
  const lines = source.split(/\r\n|\r|\n/).length;
  return /(?:\r\n|\r|\n)$/.test(source) ? lines - 1 : lines;
}

async function buildImportGraph(files: string[]): Promise<Map<string, Set<string>>> {
  const known = new Set(files.map(path.normalize));
  const graph = new Map<string, Set<string>>();
  const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;
  for (const file of files) {
    const targets = new Set<string>();
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier?.startsWith(".")) continue;
      const target = resolveSourceImport(file, specifier, known);
      if (target) targets.add(target);
    }
    graph.set(file, targets);
  }
  return graph;
}

function findCycles(graph: Map<string, Set<string>>): string[][] {
  const cycles = new Map<string, string[]>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (node: string): void => {
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      if (visiting.has(next)) {
        const cycle = stack.slice(stack.indexOf(next));
        const key = cycle.map(relative).sort().join("|");
        cycles.set(key, [...cycle, next]);
      } else {
        visit(next);
      }
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
  return [...cycles.values()].sort((left, right) => relative(left[0]).localeCompare(relative(right[0])));
}

function checkTurnDomainDirection(graph: Map<string, Set<string>>): string[] {
  const errors: string[] = [];
  const runtimeRoot = path.join(root, "apps/server/src/runtime");
  const coordinator = path.join(runtimeRoot, "turn-runner.ts");
  const compositionRoot = path.join(root, "apps/server/src/index.ts");
  for (const [file, targets] of graph) {
    const domain = extractedTurnDomains.find((name) => isWithin(file, path.join(runtimeRoot, name)));
    if (!domain) continue;
    if (targets.has(coordinator)) errors.push(`${relative(file)}: ${domain} domain imports the turn-runner coordinator`);
    if (targets.has(compositionRoot)) errors.push(`${relative(file)}: ${domain} domain imports the server composition root`);
  }
  return errors;
}

function resolveSourceImport(from: string, specifier: string, known: Set<string>): string | null {
  const base = path.resolve(path.dirname(from), specifier.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    const normalized = path.normalize(candidate);
    if (known.has(normalized)) return normalized;
  }
  return null;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (["dist", "build", "stage", "coverage", "node_modules"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else files.push(target);
  }
  return files;
}

function isProductionSource(file: string): boolean {
  if (!/\.(?:css|[cm]?[jt]sx?)$/.test(file) || /\.d\.(?:ts|mts|cts)$/.test(file)) return false;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) return false;
  return file.includes(`${path.sep}src${path.sep}`);
}

function isHandwrittenCode(file: string): boolean {
  return /\.(?:css|[cm]?[jt]sx?)$/.test(file) && !/\.d\.(?:ts|mts|cts)$/.test(file);
}

function relative(file: string): string {
  return path.relative(root, file).replace(/\\/g, "/");
}

function isWithin(file: string, directory: string): boolean {
  const relation = path.relative(directory, file);
  return relation !== "" && !relation.startsWith("..") && !path.isAbsolute(relation);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
