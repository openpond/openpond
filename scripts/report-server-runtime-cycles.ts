import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [
  path.join(repoRoot, "apps/server/src/runtime"),
  path.join(repoRoot, "apps/server/src/openpond"),
];

const files = (await Promise.all(roots.map(sourceFiles))).flat().sort();
const fileSet = new Set(files);
const graph = new Map<string, string[]>(
  await Promise.all(files.map(async (file) => [file, await localDependencies(file)] as const)),
);
const cycles = stronglyConnectedComponents(graph)
  .filter((component) => component.length > 1 || graph.get(component[0]!)?.includes(component[0]!))
  .map((component) => component.map(relativePath).sort())
  .sort((left, right) => left.join("|").localeCompare(right.join("|")));

console.log(`Server runtime/openpond module graph: ${files.length} modules, ${edgeCount(graph)} local edges.`);
if (cycles.length === 0) {
  console.log("Cycles: 0");
} else {
  console.log(`Cycles: ${cycles.length}`);
  for (const [index, cycle] of cycles.entries()) {
    console.log(`${index + 1}. ${cycle.join(" -> ")}`);
  }
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && /\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [absolute]
      : [];
  }));
  return nested.flat();
}

async function localDependencies(file: string): Promise<string[]> {
  const source = await readFile(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const dependencies = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
    const resolved = resolveSourceImport(file, specifier.text);
    if (resolved && fileSet.has(resolved)) dependencies.add(resolved);
  }
  return [...dependencies].sort();
}

function resolveSourceImport(importer: string, specifier: string): string | null {
  const absolute = path.resolve(path.dirname(importer), specifier);
  const candidates = /\.[cm]?js$/.test(absolute)
    ? [absolute.replace(/\.[cm]?js$/, ".ts"), absolute.replace(/\.[cm]?js$/, ".tsx")]
    : [absolute, `${absolute}.ts`, `${absolute}.tsx`, path.join(absolute, "index.ts")];
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function stronglyConnectedComponents(graph: Map<string, string[]>): string[][] {
  let index = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  function visit(node: string): void {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indexes.get(dependency)!));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component);
  }

  for (const node of graph.keys()) {
    if (!indexes.has(node)) visit(node);
  }
  return components;
}

function edgeCount(graph: Map<string, string[]>): number {
  return [...graph.values()].reduce((sum, dependencies) => sum + dependencies.length, 0);
}

function relativePath(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}
