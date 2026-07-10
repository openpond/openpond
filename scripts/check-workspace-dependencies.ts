import { builtinModules } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PackageManifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  openpondBundledSourceDependencies?: string[];
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtin = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`), "bun", "bun:test"]);
const importPattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

async function main(): Promise<void> {
  const packageDirs = await workspacePackageDirectories();
  const workspaceNames = new Set<string>();
  for (const packageDir of packageDirs) {
    const manifest = await readManifest(packageDir);
    if (manifest.name) workspaceNames.add(manifest.name);
  }

  const errors: string[] = [];
  for (const packageDir of packageDirs) {
    const manifest = await readManifest(packageDir);
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    const development = new Set(Object.keys(manifest.devDependencies ?? {}));
    const bundledSource = new Set(manifest.openpondBundledSourceDependencies ?? []);
    const sourceRoots = await existingDirectories([
      path.join(packageDir, "src"),
      path.join(packageDir, "scripts"),
      path.join(packageDir, "test"),
      path.join(packageDir, "tests"),
    ]);
    const files = (await Promise.all(sourceRoots.map(walkSourceFiles))).flat();
    for (const file of files) {
      const production = file.includes(`${path.sep}src${path.sep}`) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
      const source = await fs.readFile(file, "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || builtin.has(specifier)) continue;
        const packageName = importedPackageName(specifier);
        if (packageName === manifest.name) continue;
        if (declared.has(packageName) || (bundledSource.has(packageName) && development.has(packageName))) continue;
        if (!production && development.has(packageName)) continue;
        const kind = workspaceNames.has(packageName) ? "workspace" : "external";
        errors.push(`${relative(file)} imports ${kind} package ${packageName} without declaring it in ${relative(path.join(packageDir, "package.json"))}${production && development.has(packageName) ? " dependencies (it is currently dev-only)" : ""}`);
      }
    }
  }

  if (errors.length > 0) {
    for (const error of [...new Set(errors)].sort()) console.error(`[dependency-boundary] ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Workspace dependency check passed: ${packageDirs.length} packages declare every direct source import.`);
}

async function workspacePackageDirectories(): Promise<string[]> {
  const directories: string[] = [];
  for (const parent of [path.join(root, "apps"), path.join(root, "packages")]) {
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageDir = path.join(parent, entry.name);
      if (await exists(path.join(packageDir, "package.json"))) directories.push(packageDir);
    }
  }
  return directories.sort();
}

async function readManifest(packageDir: string): Promise<PackageManifest> {
  return JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8")) as PackageManifest;
}

async function existingDirectories(candidates: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isDirectory()) result.push(candidate);
  }
  return result;
}

async function walkSourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (["dist", "build", "coverage", "node_modules"].includes(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkSourceFiles(filePath));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) files.push(filePath);
  }
  return files;
}

function importedPackageName(specifier: string): string {
  if (!specifier.startsWith("@")) return specifier.split("/")[0]!;
  return specifier.split("/").slice(0, 2).join("/");
}

function relative(filePath: string): string {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

await main();
