import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files: string[] = [];
for (const directory of [path.join(root, "apps"), path.join(root, "packages")]) walk(directory, files);

const productionFiles = files.filter(
  (file) =>
    file.includes(`${path.sep}src${path.sep}`) &&
    /\.(?:ts|tsx)$/.test(file) &&
    !/\.(?:test|spec)\.(?:ts|tsx)$/.test(file) &&
    !file.endsWith(".d.ts"),
);
const knownFiles = new Set(productionFiles.map(path.normalize));
const graph = new Map(productionFiles.map((file) => [file, sourceImports(file)]));
const entrypoints = new Set<string>();

// Application, package-binary, example, and deliberate browser-proof roots.
for (const relativePath of [
  "apps/desktop/src/main.ts",
  "apps/desktop/src/preload.ts",
  "apps/server/src/index.ts",
  "apps/terminal/src/index.ts",
  "apps/web/src/main.tsx",
  "apps/web/src/test-pages/usage-browser-proof.tsx",
  "apps/cli/src/index.ts",
  "apps/cli/src/cli/main.ts",
  "apps/cli/src/sandbox-template/manifest.ts",
  "apps/cli/examples/sandbox-templates/preview-service/src/server.ts",
  "apps/cli/examples/sandbox-templates/service-with-actions/src/server.ts",
  "packages/taskset-sdk/src/cli.ts",
  "packages/training-sdk/src/cli.ts",
]) {
  addEntrypoint(path.join(root, relativePath));
}

for (const parent of ["apps", "packages"]) {
  for (const directory of readdirSync(path.join(root, parent))) {
    const packageDirectory = path.join(root, parent, directory);
    const manifestPath = path.join(packageDirectory, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        exports?: unknown;
        main?: string;
      };
      const targets: string[] = [];
      collectManifestTargets(manifest.exports, targets);
      if (manifest.main) targets.push(manifest.main);
      for (const target of targets) addManifestTarget(packageDirectory, target);
      addEntrypoint(path.join(packageDirectory, "src/index.ts"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

const reachable = new Set<string>();
const pending = [...entrypoints];
while (pending.length > 0) {
  const file = pending.pop();
  if (!file || reachable.has(file) || !knownFiles.has(file)) continue;
  reachable.add(file);
  for (const imported of graph.get(file) ?? []) pending.push(imported);
}

const unreachable = productionFiles.filter((file) => !reachable.has(file)).map(relative).sort();
if (unreachable.length > 0) {
  for (const file of unreachable) console.error(`[unreachable-production-module] ${file}`);
  process.exitCode = 1;
} else {
  console.log(
    `Production entrypoint check passed: ${productionFiles.length} modules are reachable from ${entrypoints.size} runtime, package, binary, example, or browser-proof roots.`,
  );
}

function walk(directory: string, output: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["dist", "build", "stage", "node_modules", "coverage"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target, output);
    else output.push(target);
  }
}

function sourceImports(file: string): Set<string> {
  const source = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  const patterns = [
    /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g,
    /(?:^|[;\n])\s*import\s*["']([^"']+)["']/g,
    /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) if (match[1]) specifiers.push(match[1]);
  }
  const targets = new Set<string>();
  for (const specifier of specifiers) {
    if (!specifier.startsWith(".")) continue;
    const target = resolveSourceImport(file, specifier);
    if (target) targets.add(target);
  }
  return targets;
}

function resolveSourceImport(from: string, specifier: string): string | null {
  const raw = path.resolve(path.dirname(from), specifier);
  const base = raw.replace(/\.(?:js|jsx|mjs|cjs)$/, "");
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    const normalized = path.normalize(candidate);
    if (knownFiles.has(normalized)) return normalized;
  }
  return null;
}

function collectManifestTargets(value: unknown, output: string[]): void {
  if (typeof value === "string") output.push(value);
  else if (value && typeof value === "object") {
    for (const nested of Object.values(value)) collectManifestTargets(nested, output);
  }
}

function addManifestTarget(packageDirectory: string, target: string): void {
  const normalizedTarget = target.replace(/^\.\//, "").replace(/^dist\//, "src/");
  if (normalizedTarget.includes("*")) {
    const [prefix, suffix = ""] = normalizedTarget.split("*");
    const sourceSuffix = suffix.replace(/\.js$/, ".ts");
    for (const file of productionFiles) {
      const packageRelative = path.relative(packageDirectory, file).replaceAll(path.sep, "/");
      if (packageRelative.startsWith(prefix) && packageRelative.endsWith(sourceSuffix)) addEntrypoint(file);
    }
    return;
  }
  addEntrypoint(resolveManifestTarget(packageDirectory, normalizedTarget));
}

function resolveManifestTarget(packageDirectory: string, target: string): string {
  const raw = path.join(packageDirectory, target);
  const base = raw.replace(/\.(?:js|d\.ts)$/, "");
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    const normalized = path.normalize(candidate);
    if (knownFiles.has(normalized)) return normalized;
  }
  return path.normalize(raw);
}

function addEntrypoint(file: string): void {
  const normalized = path.normalize(file);
  if (knownFiles.has(normalized)) entrypoints.add(normalized);
}

function relative(file: string): string {
  return path.relative(root, file).replaceAll(path.sep, "/");
}
