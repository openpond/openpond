import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, promises as fs, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import yaml from "js-yaml";
import { runProcessCommand } from "../process-runner.js";
import {
  agentSdkDependencyInstallCommand,
  detectAgentSdkPackageManager,
  type AgentSdkPackageManager,
} from "./project-source-upload-bun-compat.js";

const OPENPOND_PNPM_PACKAGE_MANAGER = "pnpm@11.13.0";
const AGENT_SDK_VENDOR_TARBALL_PATH =
  ".openpond/vendor/openpond-agent-sdk.tgz";
const AGENT_SDK_VENDOR_NPM_DEPENDENCY_DIR = ".openpond/vendor/npm";
const AGENT_SDK_MATERIALIZED_DEPENDENCY_SPEC =
  `file:${AGENT_SDK_VENDOR_TARBALL_PATH}`;
const AGENT_SDK_SYNTHESIZED_OPENPOND_YAML_SENTINEL =
  "# openpond-agent-sdk-source-upload: synthesized-openpond-yaml";

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
) {
  return runProcessCommand(command, args, { cwd: options.cwd });
}

function readOpenPondAgentSdkVersionSpec(
  packageJson: Record<string, unknown>,
): string | null {
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const dependencies = packageJson[key];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }
    const value = (dependencies as Record<string, unknown>)["openpond-agent-sdk"];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export async function buildAgentSdkMaterializedDependency(
  projectPath: string,
  packageJson: Record<string, unknown>
): Promise<{
  rewrittenPackageJson: Record<string, unknown>;
  pnpmWorkspaceSource: string | null;
  tarballs: AgentSdkMaterializedTarball[];
  dependencySetup: Record<string, unknown>;
} | null> {
  const sdkSource = resolveLocalOpenPondAgentSdkMaterializationSource(
    projectPath,
    packageJson
  );
  if (!sdkSource) return null;

  const tempDir = await fs.mkdtemp(path.join(tmpdir(), "openpond-agent-sdk-pack-"));
  try {
    const sdkContents =
      sdkSource.kind === "package_root"
        ? await packOpenPondAgentSdkPackageRoot(sdkSource.packageRoot, tempDir)
        : sdkSource.tarballContents;
    const sdkDependencyTarballs = await packAgentSdkRuntimeDependencyTarballs({
      sdkPackageJson: sdkSource.packageJson,
      dependencyBaseDir: sdkSource.dependencyBaseDir,
      tempDir,
    });
    const packageManager = detectAgentSdkPackageManager(projectPath, packageJson);
    const rewrittenPackageJson = rewriteAgentSdkPackageJsonForMaterialization(
      packageJson,
      sdkDependencyTarballs,
      packageManager,
    );
    const pnpmWorkspaceSource =
      packageManager === "pnpm" || packageManager === "unknown"
        ? buildAgentSdkPnpmWorkspaceSource(projectPath, sdkDependencyTarballs)
        : null;
    const installCommand = agentSdkDependencyInstallCommand(packageManager);
    const sdkPackage: Omit<AgentSdkMaterializedTarball, "contents"> = {
      packageName: "openpond-agent-sdk",
      source: "uploaded_tarball",
      path: AGENT_SDK_VENDOR_TARBALL_PATH,
      sha256: sha256Hex(sdkContents),
      sizeBytes: sdkContents.byteLength,
    };
    return {
      rewrittenPackageJson,
      pnpmWorkspaceSource,
      tarballs: [
        {
          ...sdkPackage,
          contents: sdkContents,
        },
        ...sdkDependencyTarballs,
      ],
      dependencySetup: {
        required: true,
        packageManager,
        installCommand,
        commands: [installCommand],
        packageJsonPath: "package.json",
        expectedBinaryPath: "node_modules/.bin/openpond-agent",
        generatedArtifactDirectory: ".openpond",
        sdkPackage,
        dependencyPackages: sdkDependencyTarballs.map((tarball) => ({
          packageName: tarball.packageName,
          source: tarball.source,
          versionSpec: tarball.versionSpec,
          path: tarball.path,
          sha256: tarball.sha256,
          sizeBytes: tarball.sizeBytes,
        })),
      },
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

type AgentSdkMaterializedTarball = {
  packageName: string;
  source: "uploaded_tarball" | "npm_dependency_tarball";
  versionSpec?: string;
  path: string;
  contents: Buffer;
  sha256: string;
  sizeBytes: number;
};

async function packOpenPondAgentSdkPackageRoot(
  sdkPackageRoot: string,
  tempDir: string
): Promise<Buffer> {
  const pack = await runCommand(
    "npm",
    ["pack", "--silent", "--pack-destination", tempDir, sdkPackageRoot],
    { cwd: sdkPackageRoot }
  );
  if (pack.code !== 0) {
    const details = [pack.stderr.trim(), pack.stdout.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `failed to pack openpond-agent-sdk for source upload${details ? `:\n${details}` : ""}`
    );
  }
  const tarballName = pack.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!tarballName) {
    throw new Error("failed to pack openpond-agent-sdk for source upload: npm pack did not return a tarball name");
  }
  return fs.readFile(path.join(tempDir, tarballName));
}

async function packAgentSdkRuntimeDependencyTarballs(params: {
  sdkPackageJson: Record<string, unknown>;
  dependencyBaseDir: string;
  tempDir: string;
}): Promise<AgentSdkMaterializedTarball[]> {
  const dependencies = recordStringMap(params.sdkPackageJson.dependencies);
  const pending = Object.entries(dependencies)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([packageName, versionSpec]) => ({ packageName, versionSpec }));
  const seen = new Set<string>();
  const tarballs: AgentSdkMaterializedTarball[] = [];
  while (pending.length > 0) {
    const { packageName, versionSpec } = pending.shift()!;
    if (seen.has(packageName)) continue;
    seen.add(packageName);
    const packTarget = npmPackTargetForDependency({
      packageName,
      versionSpec,
      dependencyBaseDir: params.dependencyBaseDir,
    });
    const pack = await runCommand(
      "npm",
      ["pack", "--silent", "--pack-destination", params.tempDir, packTarget],
      { cwd: params.dependencyBaseDir }
    );
    if (pack.code !== 0) {
      const details = [pack.stderr.trim(), pack.stdout.trim()]
        .filter(Boolean)
        .join("\n");
      throw new Error(
        `failed to pack openpond-agent-sdk dependency ${packageName}${details ? `:\n${details}` : ""}`
      );
    }
    const tarballName = pack.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    if (!tarballName) {
      throw new Error(
        `failed to pack openpond-agent-sdk dependency ${packageName}: npm pack did not return a tarball name`
      );
    }
    const contents = await fs.readFile(path.join(params.tempDir, tarballName));
    const packedPackageJson = readPackageJsonFromNpmTarball(contents);
    tarballs.push({
      packageName,
      source: "npm_dependency_tarball",
      versionSpec,
      path: `${AGENT_SDK_VENDOR_NPM_DEPENDENCY_DIR}/${sanitizeNpmPackageNameForVendor(
        packageName
      )}.tgz`,
      contents,
      sha256: sha256Hex(contents),
      sizeBytes: contents.byteLength,
    });
    for (const [dependencyName, dependencySpec] of Object.entries(
      recordStringMap(packedPackageJson.dependencies),
    )) {
      pending.push({ packageName: dependencyName, versionSpec: dependencySpec });
    }
    for (const [dependencyName, dependencySpec] of Object.entries(
      recordStringMap(packedPackageJson.optionalDependencies),
    )) {
      if (!isSupportedSandboxOptionalDependency(dependencyName)) continue;
      pending.push({ packageName: dependencyName, versionSpec: dependencySpec });
    }
  }
  return tarballs.sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function isSupportedSandboxOptionalDependency(packageName: string): boolean {
  if (packageName === "fsevents") return false;
  if (packageName.startsWith("@esbuild/")) {
    return packageName === "@esbuild/linux-x64" || packageName === "@esbuild/linux-arm64";
  }
  return true;
}

function npmPackTargetForDependency(params: {
  packageName: string;
  versionSpec: string;
  dependencyBaseDir: string;
}): string {
  if (params.versionSpec.startsWith("file:")) {
    return path.resolve(
      params.dependencyBaseDir,
      params.versionSpec.slice("file:".length)
    );
  }
  return `${params.packageName}@${params.versionSpec}`;
}

function sanitizeNpmPackageNameForVendor(packageName: string): string {
  return packageName
    .replace(/^@/, "")
    .replace(/[\/\\]/g, "__")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

type OpenPondAgentSdkMaterializationSource =
  | {
      kind: "package_root";
      packageRoot: string;
      dependencyBaseDir: string;
      packageJson: Record<string, unknown>;
    }
  | {
      kind: "tarball";
      tarballPath: string;
      tarballContents: Buffer;
      dependencyBaseDir: string;
      packageJson: Record<string, unknown>;
    };

function resolveLocalOpenPondAgentSdkMaterializationSource(
  projectPath: string,
  packageJson: Record<string, unknown>
): OpenPondAgentSdkMaterializationSource | null {
  const versionSpec = readOpenPondAgentSdkVersionSpec(packageJson);
  if (versionSpec?.startsWith("file:")) {
    const candidate = path.resolve(projectPath, versionSpec.slice("file:".length));
    if (isOpenPondAgentSdkPackageRoot(candidate)) {
      return {
        kind: "package_root",
        packageRoot: candidate,
        dependencyBaseDir: candidate,
        packageJson: JSON.parse(
          readFileSyncUtf8(path.join(candidate, "package.json"))
        ) as Record<string, unknown>,
      };
    }
    if (isLocalNpmTarball(candidate)) {
      const tarballContents = readFileSync(candidate);
      const tarballPackageJson =
        readPackageJsonFromNpmTarball(tarballContents);
      if (tarballPackageJson.name === "openpond-agent-sdk") {
        return {
          kind: "tarball",
          tarballPath: candidate,
          tarballContents,
          dependencyBaseDir: path.dirname(candidate),
          packageJson: tarballPackageJson,
        };
      }
    }
  }
  if (versionSpec?.startsWith("workspace:")) {
    const candidate = findOpenPondAgentSdkPackageRootInAncestors(projectPath);
    if (candidate) {
      return {
        kind: "package_root",
        packageRoot: candidate,
        dependencyBaseDir: candidate,
        packageJson: JSON.parse(
          readFileSyncUtf8(path.join(candidate, "package.json"))
        ) as Record<string, unknown>,
      };
    }
  }
  return null;
}

function findOpenPondAgentSdkPackageRootInAncestors(projectPath: string): string | null {
  let current = path.resolve(projectPath);
  while (true) {
    if (isOpenPondAgentSdkPackageRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isOpenPondAgentSdkPackageRoot(candidate: string): boolean {
  const packageJsonPath = path.join(candidate, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  try {
    const parsed = JSON.parse(readFileSyncUtf8(packageJsonPath)) as {
      name?: unknown;
    };
    return parsed.name === "openpond-agent-sdk";
  } catch {
    return false;
  }
}

function isLocalNpmTarball(candidate: string): boolean {
  if (!existsSync(candidate)) return false;
  try {
    return (
      statSync(candidate).isFile() &&
      (candidate.endsWith(".tgz") || candidate.endsWith(".tar.gz"))
    );
  } catch {
    return false;
  }
}

function readPackageJsonFromNpmTarball(
  tarballContents: Buffer
): Record<string, unknown> {
  const tarContents = gunzipSync(tarballContents);
  let offset = 0;
  while (offset + 512 <= tarContents.length) {
    const header = tarContents.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error("failed to read openpond-agent-sdk tarball: invalid entry size");
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (entryPath === "package/package.json") {
      return JSON.parse(
        tarContents.subarray(dataStart, dataEnd).toString("utf8")
      ) as Record<string, unknown>;
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error("failed to read openpond-agent-sdk tarball: missing package.json");
}

function readTarString(
  header: Buffer,
  start: number,
  length: number
): string {
  const field = header.subarray(start, start + length);
  const nullIndex = field.indexOf(0);
  return field
    .subarray(0, nullIndex === -1 ? field.length : nullIndex)
    .toString("utf8");
}

function rewriteAgentSdkPackageJsonForMaterialization(
  packageJson: Record<string, unknown>,
  dependencyTarballs: AgentSdkMaterializedTarball[],
  packageManager: AgentSdkPackageManager,
): Record<string, unknown> {
  const rewritten: Record<string, unknown> = { ...packageJson };
  const dependencies = recordCopy(rewritten.dependencies);
  const overrides = recordCopy(rewritten.overrides);
  dependencies["openpond-agent-sdk"] = AGENT_SDK_MATERIALIZED_DEPENDENCY_SPEC;
  for (const tarball of dependencyTarballs) {
    const dependencySpec = `file:${tarball.path}`;
    dependencies[tarball.packageName] = dependencySpec;
    overrides[tarball.packageName] = dependencySpec;
  }
  rewritten.dependencies = dependencies;
  if (Object.keys(overrides).length > 0) {
    rewritten.overrides = overrides;
  }
  if (packageManager === "unknown") {
    rewritten.packageManager = OPENPOND_PNPM_PACKAGE_MANAGER;
  }

  for (const key of ["devDependencies", "peerDependencies"]) {
    const entries = recordCopy(rewritten[key]);
    delete entries["openpond-agent-sdk"];
    if (Object.keys(entries).length > 0) {
      rewritten[key] = entries;
    } else {
      delete rewritten[key];
    }
  }

  return rewritten;
}

function buildAgentSdkPnpmWorkspaceSource(
  projectPath: string,
  dependencyTarballs: AgentSdkMaterializedTarball[],
): string {
  const workspacePath = path.join(projectPath, "pnpm-workspace.yaml");
  let workspace: Record<string, unknown> = {};
  if (existsSync(workspacePath)) {
    const parsed = yaml.load(readFileSyncUtf8(workspacePath));
    workspace = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  }
  if (!Array.isArray(workspace.packages)) workspace.packages = [];
  const overrides = recordCopy(workspace.overrides);
  for (const tarball of dependencyTarballs) {
    overrides[tarball.packageName] = `file:${tarball.path}`;
  }
  workspace.overrides = overrides;
  const allowBuilds = recordCopy(workspace.allowBuilds);
  allowBuilds.esbuild = true;
  const vendoredEsbuild = dependencyTarballs.find(
    (tarball) => tarball.packageName === "esbuild",
  );
  if (vendoredEsbuild) {
    allowBuilds[`esbuild@file:${vendoredEsbuild.path}`] = true;
  }
  workspace.allowBuilds = allowBuilds;
  workspace.supportedArchitectures = {
    os: ["linux"],
    cpu: ["x64", "arm64"],
    libc: ["glibc", "musl"],
  };
  return yaml.dump(workspace, { lineWidth: 120, noRefs: true });
}

function recordStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string" && entryValue.trim()) {
      entries[key] = entryValue.trim();
    }
  }
  return entries;
}

function recordCopy(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

export function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    : [];
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function sha256Hex(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function dependencySetupCommands(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.commands)) {
    return record.commands.filter(
      (command): command is string =>
        typeof command === "string" && command.trim() !== ""
    );
  }
  return typeof record.installCommand === "string" && record.installCommand.trim()
    ? [record.installCommand.trim()]
    : [];
}

function mergeManifestSetupCommands(
  manifest: Record<string, unknown>,
  commands: string[]
): Record<string, unknown> {
  if (commands.length === 0) return manifest;
  const setup =
    manifest.setup && typeof manifest.setup === "object" && !Array.isArray(manifest.setup)
      ? recordCopy(manifest.setup)
      : {};
  const existingCommands = Array.isArray(setup.commands)
    ? setup.commands.filter(
        (command): command is string =>
          typeof command === "string" && command.trim() !== ""
      )
    : [];
  const mergedCommands = [...commands];
  for (const command of existingCommands) {
    if (!mergedCommands.includes(command)) mergedCommands.push(command);
  }
  return {
    ...manifest,
    setup: {
      ...setup,
      commands: mergedCommands,
    },
  };
}

export function sanitizeAgentSdkRuntimeManifestForOpenPondYaml(
  source: string,
  dependencySetup: Record<string, unknown> | null
): string {
  const parsed = yaml.load(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `${AGENT_SDK_SYNTHESIZED_OPENPOND_YAML_SENTINEL}\n${source}`;
  }
  const manifest = mergeManifestSetupCommands(
    { ...(parsed as Record<string, unknown>) },
    dependencySetupCommands(dependencySetup)
  );
  delete manifest.schema;
  sanitizeGeneratedManifestNamedCommands(manifest, "actions");
  sanitizeGeneratedManifestNamedCommands(manifest, "services");
  return `${AGENT_SDK_SYNTHESIZED_OPENPOND_YAML_SENTINEL}\n${yaml.dump(manifest, { lineWidth: -1, noRefs: true })}`;
}

function sanitizeGeneratedManifestNamedCommands(
  manifest: Record<string, unknown>,
  key: "actions" | "services"
): void {
  if (!Array.isArray(manifest[key])) return;
  manifest[key] = manifest[key].map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    const sanitized = { ...(entry as Record<string, unknown>) };
    delete sanitized.id;
    delete sanitized.label;
    return sanitized;
  });
}

export function isAgentSdkProject(projectPath: string): boolean {
  if (!existsSync(path.join(projectPath, "agent", "agent.ts"))) return false;
  const packageJsonPath = path.join(projectPath, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  try {
    const parsed = JSON.parse(readFileSyncUtf8(packageJsonPath)) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
    };
    return Boolean(
      parsed.dependencies?.["openpond-agent-sdk"] ||
        parsed.devDependencies?.["openpond-agent-sdk"] ||
        parsed.peerDependencies?.["openpond-agent-sdk"]
    );
  } catch {
    return false;
  }
}

export function readFileSyncUtf8(filePath: string): string {
  return readFileSync(filePath, "utf8");
}
