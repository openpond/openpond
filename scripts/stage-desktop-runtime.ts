import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runtimeInventoryVerification,
  type RuntimeInventoryEntry,
} from "./desktop-runtime-inventory";

type DesktopRuntimeStageOptions = {
  root: string;
  stageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
};

const FORBIDDEN_RUNTIME_SUFFIXES = [".a", ".cc", ".gyp", ".h", ".map", ".pdb", ".ts"];

export async function stageDesktopRuntime(
  options: DesktopRuntimeStageOptions,
): Promise<{ stageRoot: string; files: RuntimeInventoryEntry[]; totalBytes: number }> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const stageRoot = options.stageRoot ?? path.join(options.root, "apps", "desktop", "stage");
  const appRoot = path.join(stageRoot, "app");
  const runtimeRoot = path.join(stageRoot, "runtime");
  await fs.rm(stageRoot, { recursive: true, force: true });
  await fs.mkdir(stageRoot, { recursive: true, mode: 0o755 });

  await stageDesktopApp(options.root, appRoot);
  await copyRequired(
    path.join(options.root, "apps", "server", "dist", "index.js"),
    path.join(runtimeRoot, "server", "index.js"),
  );
  await copyTree(
    path.join(options.root, "apps", "cli", "skills", "openpond-taskset-authoring"),
    path.join(runtimeRoot, "server", "skills", "openpond-taskset-authoring"),
  );
  await copyTree(path.join(options.root, "apps", "web", "dist"), path.join(runtimeRoot, "web"));
  await stageSqliteRuntime(options.root, runtimeRoot);
  await stageNodePtyRuntime(options.root, runtimeRoot, platform, arch);
  await stageSmallDependency(options.root, runtimeRoot, "bindings", ["bindings.js"]);
  await stageSmallDependency(options.root, runtimeRoot, "file-uri-to-path", ["index.js"]);

  const files = await inventoryFiles(runtimeRoot, runtimeRoot, platform);
  const forbidden = files.filter((entry) =>
    FORBIDDEN_RUNTIME_SUFFIXES.some((suffix) => entry.path.toLowerCase().endsWith(suffix)),
  );
  if (forbidden.length > 0) {
    throw new Error(`Desktop runtime stage contains development artifacts: ${forbidden.map((entry) => entry.path).join(", ")}`);
  }
  const totalBytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
  const inventory = {
    schemaVersion: 1,
    platform,
    arch,
    generatedAt: new Date().toISOString(),
    totalBytes,
    fileCount: files.length,
    files,
  };
  await fs.writeFile(
    path.join(runtimeRoot, "runtime-inventory.json"),
    `${JSON.stringify(inventory, null, 2)}\n`,
    { mode: 0o644 },
  );
  return { stageRoot, files, totalBytes };
}

async function stageDesktopApp(root: string, appRoot: string): Promise<void> {
  const rootPackage = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
    version?: string;
  };
  const packageJson = {
    name: "openpond",
    version: rootPackage.version ?? "0.0.0",
    private: true,
    type: "module",
    main: "dist/main.js",
    description: "OpenPond local-first desktop application",
    author: "OpenPond",
  };
  await fs.mkdir(appRoot, { recursive: true, mode: 0o755 });
  await fs.writeFile(path.join(appRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  for (const entry of ["main.js", "preload.js"]) {
    const source = path.join(root, "apps", "desktop", "dist", entry);
    await assertStandaloneDesktopBundle(source);
    await copyRequired(
      source,
      path.join(appRoot, "dist", entry),
    );
  }
}

export async function assertStandaloneDesktopBundle(filePath: string): Promise<void> {
  const source = await fs.readFile(filePath, "utf8").catch(() => null);
  if (source === null) {
    throw new Error(`Required desktop bundle is missing: ${filePath}. Run bun run build:desktop.`);
  }
  const localImport = source.match(/\bfrom\s*["'](\.{1,2}\/[^"']+)/)
    ?? source.match(/\bimport\s*["'](\.{1,2}\/[^"']+)/)
    ?? source.match(/\b(?:import|require)\s*\(\s*["'](\.{1,2}\/[^"']+)/);
  if (localImport) {
    throw new Error(
      `Desktop entrypoint is not a standalone bundle (${localImport[1]}): ${filePath}. Run bun run build:desktop.`,
    );
  }
}

async function stageSqliteRuntime(root: string, stageRoot: string): Promise<void> {
  const source = path.join(root, "node_modules", "sqlite3");
  const target = packageTarget(stageRoot, "sqlite3");
  await copyPackageMetadata(source, target);
  await copyTree(path.join(source, "lib"), path.join(target, "lib"), (file) =>
    file.endsWith(".js") || file.endsWith(".json"),
  );
  await copyRequired(
    path.join(source, "build", "Release", "node_sqlite3.node"),
    path.join(target, "build", "Release", "node_sqlite3.node"),
  );
}

async function stageNodePtyRuntime(
  root: string,
  stageRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<void> {
  const source = path.join(root, "node_modules", "node-pty");
  const target = packageTarget(stageRoot, "node-pty");
  await copyPackageMetadata(source, target);
  await copyTree(path.join(source, "lib"), path.join(target, "lib"), (file) =>
    file.endsWith(".js") && !file.endsWith(".test.js"),
  );

  const prebuildName = `${platform}-${arch}`;
  const prebuildSource = path.join(source, "prebuilds", prebuildName);
  if (await exists(prebuildSource)) {
    const allowed = nodePtyPrebuildFiles(platform);
    for (const name of allowed) {
      const sourcePath = path.join(prebuildSource, name);
      if (!(await exists(sourcePath))) continue;
      const targetPath = path.join(target, "prebuilds", prebuildName, name);
      await copyRequired(sourcePath, targetPath);
      if (name === "spawn-helper") await fs.chmod(targetPath, 0o755);
    }
    await assertAnyNativeFile(path.join(target, "prebuilds", prebuildName));
    return;
  }

  const releaseSource = path.join(source, "build", "Release");
  for (const name of nodePtyBuildFiles(platform)) {
    const sourcePath = path.join(releaseSource, name);
    if (!(await exists(sourcePath))) continue;
    const targetPath = path.join(target, "build", "Release", name);
    await copyRequired(sourcePath, targetPath);
    if (name === "spawn-helper") await fs.chmod(targetPath, 0o755);
  }
  await assertAnyNativeFile(path.join(target, "build", "Release"));
}

export function nodePtyPrebuildFiles(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return ["pty.node", "conpty.node", "conpty_console_list.node", "winpty-agent.exe", "winpty.dll"];
  }
  return platform === "darwin" ? ["pty.node", "spawn-helper"] : ["pty.node"];
}

function nodePtyBuildFiles(platform: NodeJS.Platform): string[] {
  return nodePtyPrebuildFiles(platform);
}

async function stageSmallDependency(
  root: string,
  stageRoot: string,
  packageName: string,
  runtimeFiles: string[],
): Promise<void> {
  const source = path.join(root, "node_modules", packageName);
  const target = packageTarget(stageRoot, packageName);
  await copyPackageMetadata(source, target);
  for (const runtimeFile of runtimeFiles) {
    await copyRequired(path.join(source, runtimeFile), path.join(target, runtimeFile));
  }
}

async function copyPackageMetadata(source: string, target: string): Promise<void> {
  await copyRequired(path.join(source, "package.json"), path.join(target, "package.json"));
  for (const name of await fs.readdir(source)) {
    if (!/^licen[cs]e(?:\..+)?$/i.test(name)) continue;
    await copyRequired(path.join(source, name), path.join(target, name));
  }
}

async function copyTree(
  source: string,
  target: string,
  include: (filePath: string) => boolean = () => true,
): Promise<void> {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Required desktop runtime directory is missing: ${source}`);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, targetPath, include);
    } else if (entry.isFile() && include(sourcePath)) {
      await copyRequired(sourcePath, targetPath);
    }
  }
}

async function copyRequired(source: string, target: string): Promise<void> {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Required desktop runtime file is missing: ${source}`);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  await fs.copyFile(source, target);
  await fs.chmod(target, stat.mode & 0o777);
}

async function inventoryFiles(
  root: string,
  baseRoot: string,
  platform: NodeJS.Platform,
): Promise<RuntimeInventoryEntry[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<RuntimeInventoryEntry[]> => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return inventoryFiles(fullPath, baseRoot, platform);
    if (!entry.isFile()) return [];
    const content = await fs.readFile(fullPath);
    const relativePath = path.relative(baseRoot, fullPath).replaceAll(path.sep, "/");
    return [{
      path: relativePath,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      verification: runtimeInventoryVerification(platform, relativePath),
    }];
  }));
  return nested.flat().sort((left, right) => left.path.localeCompare(right.path));
}

async function assertAnyNativeFile(directory: string): Promise<void> {
  const names = await fs.readdir(directory).catch(() => []);
  if (!names.some((name) => name.endsWith(".node"))) {
    throw new Error(`No node-pty native binary was staged from ${directory}`);
  }
}

function packageTarget(stageRoot: string, packageName: string): string {
  return path.join(stageRoot, "server", "node_modules", packageName);
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = await stageDesktopRuntime({ root });
  console.log(`Staged desktop runtime: ${result.files.length} files, ${(result.totalBytes / 1024 / 1024).toFixed(2)} MiB`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
