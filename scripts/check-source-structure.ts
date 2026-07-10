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
const extractedTurnDomains = ["turns", "hosted-turn", "subagents", "goals", "create-pipeline"];

async function main(): Promise<void> {
  const handwrittenFiles = (await Promise.all(handwrittenRoots.map(walk))).flat().filter(isHandwrittenCode);
  const files = handwrittenFiles.filter(isProductionSource);
  const errors: string[] = [];
  const cycleFiles = files.filter((file) => cycleRoots.some((cycleRoot) => isWithin(file, cycleRoot)));
  const graph = await buildImportGraph(cycleFiles);
  const cycles = findCycles(graph);

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
  if (!/\.(?:ts|tsx)$/.test(file) || /\.d\.ts$/.test(file)) return false;
  if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(file)) return false;
  return file.includes(`${path.sep}src${path.sep}`);
}

function isHandwrittenCode(file: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/.test(file) && !/\.d\.(?:ts|mts|cts)$/.test(file);
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
