import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listPackage } from "@electron/asar";
import type { RuntimeInventory, RuntimeInventoryEntry } from "./desktop-runtime-inventory";

type PlatformBudget = {
  maxArtifactBytes: number;
  maxUnpackedBytes: number;
};

const MIB = 1024 * 1024;
const MAX_ASAR_BYTES = 2 * MIB;
const MAX_RESOURCES_BYTES = 32 * MIB;
const MAX_STAGED_RUNTIME_BYTES = 24 * MIB;
const PLATFORM_BUDGETS: Record<NodeJS.Platform, PlatformBudget | undefined> = {
  linux: { maxArtifactBytes: 125 * MIB, maxUnpackedBytes: 325 * MIB },
  darwin: { maxArtifactBytes: 150 * MIB, maxUnpackedBytes: 400 * MIB },
  win32: { maxArtifactBytes: 150 * MIB, maxUnpackedBytes: 400 * MIB },
  aix: undefined,
  android: undefined,
  freebsd: undefined,
  haiku: undefined,
  openbsd: undefined,
  sunos: undefined,
  cygwin: undefined,
  netbsd: undefined,
};

const execFileAsync = promisify(execFile);

export async function checkDesktopPackageBudgets(input: {
  root: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): Promise<Record<string, unknown>> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const budget = PLATFORM_BUDGETS[platform];
  if (!budget) throw new Error(`Desktop package budgets are not defined for ${platform}.`);
  const releaseRoot = path.join(input.root, "release");
  const unpackedRoot = await resolveUnpackedRoot(releaseRoot, platform, arch);
  const resourcesRoot = resourcesPath(unpackedRoot, platform);
  const asarPath = path.join(resourcesRoot, "app.asar");
  const artifactPath = await resolveArtifact(releaseRoot, platform, arch);
  const stageInventory = await readInventory(path.join(input.root, "apps", "desktop", "stage", "runtime", "runtime-inventory.json"));
  const packagedInventory = await readInventory(path.join(resourcesRoot, "runtime-inventory.json"));

  const metrics = {
    platform,
    artifact: { path: path.relative(input.root, artifactPath), bytes: (await fs.stat(artifactPath)).size },
    unpacked: { path: path.relative(input.root, unpackedRoot), bytes: await directoryBytes(unpackedRoot) },
    resources: { path: path.relative(input.root, resourcesRoot), bytes: await directoryBytes(resourcesRoot) },
    asar: { path: path.relative(input.root, asarPath), bytes: (await fs.stat(asarPath)).size },
    stagedRuntime: { bytes: stageInventory.totalBytes, files: stageInventory.fileCount },
    packagedRuntime: { bytes: packagedInventory.totalBytes, files: packagedInventory.fileCount },
  };

  assertBudget("compressed artifact", metrics.artifact.bytes, budget.maxArtifactBytes);
  assertBudget("unpacked application", metrics.unpacked.bytes, budget.maxUnpackedBytes);
  assertBudget("packaged resources", metrics.resources.bytes, MAX_RESOURCES_BYTES);
  assertBudget("app.asar", metrics.asar.bytes, MAX_ASAR_BYTES);
  assertBudget("staged runtime", metrics.stagedRuntime.bytes, MAX_STAGED_RUNTIME_BYTES);
  assertMinimalAsar(asarPath);
  await verifyRuntimeInventory(resourcesRoot, packagedInventory, platform);
  if (JSON.stringify(stageInventory.files) !== JSON.stringify(packagedInventory.files)) {
    throw new Error("Packaged runtime inventory differs from the staged runtime inventory.");
  }
  return metrics;
}

function assertMinimalAsar(asarPath: string): void {
  const entries = listPackage(asarPath, { isPack: false });
  const forbidden = entries.filter((entry) =>
    entry.startsWith("/node_modules/") || /\.(?:d\.ts|map|pdb)$/.test(entry),
  );
  if (forbidden.length > 0) {
    throw new Error(`app.asar contains forbidden dependency/development files: ${forbidden.slice(0, 20).join(", ")}`);
  }
  for (const required of ["/dist/main.js", "/dist/preload.js", "/package.json"]) {
    if (!entries.includes(required)) throw new Error(`app.asar is missing ${required}.`);
  }
}

async function verifyRuntimeInventory(
  resourcesRoot: string,
  inventory: RuntimeInventory,
  platform: NodeJS.Platform,
): Promise<void> {
  let declaredBytes = 0;
  for (const entry of inventory.files) {
    const filePath = path.join(resourcesRoot, entry.path);
    const content = await fs.readFile(filePath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (entry.verification === "darwin-code-signature") {
      if (platform !== "darwin") {
        throw new Error(`Darwin code-signature verification is invalid on ${platform}: ${entry.path}`);
      }
      if (content.byteLength !== entry.bytes || sha256 !== entry.sha256) {
        await verifyDarwinCodeSignature(filePath, entry);
      }
    } else if (content.byteLength !== entry.bytes || sha256 !== entry.sha256) {
      throw new Error(`Packaged runtime file failed inventory verification: ${entry.path}`);
    }
    declaredBytes += entry.bytes;
  }
  if (declaredBytes !== inventory.totalBytes || inventory.files.length !== inventory.fileCount) {
    throw new Error("Packaged runtime inventory totals are inconsistent.");
  }
}

async function verifyDarwinCodeSignature(filePath: string, entry: RuntimeInventoryEntry): Promise<void> {
  if (!filePath.endsWith(".node") && !filePath.endsWith("/spawn-helper")) {
    throw new Error(`Unsupported Darwin signed runtime entry: ${entry.path}`);
  }
  try {
    await execFileAsync("codesign", ["--verify", "--strict", filePath]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Packaged runtime code signature failed verification: ${entry.path}: ${detail}`);
  }
}

async function resolveUnpackedRoot(
  releaseRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<string> {
  const candidates = unpackedPackageCandidates(releaseRoot, platform, arch);
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`No unpacked ${platform} desktop package found in ${releaseRoot}.`);
}

export function unpackedPackageCandidates(
  releaseRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  if (platform === "darwin") {
    return arch === "arm64"
      ? [path.join(releaseRoot, "mac-arm64"), path.join(releaseRoot, "mac"), path.join(releaseRoot, "mac-universal")]
      : [path.join(releaseRoot, "mac"), path.join(releaseRoot, `mac-${arch}`), path.join(releaseRoot, "mac-universal")];
  }
  if (platform === "win32") {
    return arch === "x64"
      ? [path.join(releaseRoot, "win-unpacked"), path.join(releaseRoot, "win-x64-unpacked")]
      : [path.join(releaseRoot, `win-${arch}-unpacked`), path.join(releaseRoot, "win-unpacked")];
  }
  return arch === "x64"
    ? [path.join(releaseRoot, "linux-unpacked"), path.join(releaseRoot, "linux-x64-unpacked")]
    : [path.join(releaseRoot, `linux-${arch}-unpacked`), path.join(releaseRoot, "linux-unpacked")];
}

function resourcesPath(unpackedRoot: string, platform: NodeJS.Platform): string {
  if (platform !== "darwin") return path.join(unpackedRoot, "resources");
  return path.join(unpackedRoot, firstAppBundle(unpackedRoot), "Contents", "Resources");
}

function firstAppBundle(unpackedRoot: string): string {
  const names = requireDirectoryNames(unpackedRoot);
  const app = names.find((name) => name.endsWith(".app"));
  if (!app) throw new Error(`No .app bundle found in ${unpackedRoot}.`);
  return app;
}

function requireDirectoryNames(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

async function resolveArtifact(releaseRoot: string, platform: NodeJS.Platform, arch: string): Promise<string> {
  const suffix = platform === "linux" ? ".AppImage" : platform === "darwin" ? ".zip" : ".exe";
  const platformName = platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux";
  const artifactArch = artifactArchitectureLabel(platform, arch);
  const architectureSuffix = `-${platformName}-${artifactArch}${suffix}`;
  const entries = await fs.readdir(releaseRoot, { withFileTypes: true });
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(architectureSuffix))
    .map(async (entry) => {
      const filePath = path.join(releaseRoot, entry.name);
      return { filePath, modified: (await fs.stat(filePath)).mtimeMs };
    }));
  candidates.sort((left, right) => right.modified - left.modified);
  if (!candidates[0]) throw new Error(`No ${platformName}-${artifactArch}${suffix} desktop artifact found in ${releaseRoot}.`);
  return candidates[0].filePath;
}

export function artifactArchitectureLabel(platform: NodeJS.Platform, arch: string): string {
  return platform === "linux" && arch === "x64" ? "x86_64" : arch;
}

async function readInventory(filePath: string): Promise<RuntimeInventory> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as RuntimeInventory;
}

async function directoryBytes(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(filePath);
    else if (entry.isFile()) total += (await fs.stat(filePath)).size;
  }
  return total;
}

function assertBudget(label: string, actual: number, maximum: number): void {
  if (actual <= maximum) return;
  throw new Error(`${label} is ${(actual / MIB).toFixed(2)} MiB; maximum is ${(maximum / MIB).toFixed(2)} MiB.`);
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  console.log(JSON.stringify(await checkDesktopPackageBudgets({ root }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
