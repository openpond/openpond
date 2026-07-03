import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, promises as fs, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import yaml from "js-yaml";
import {
  materializeSourceUploadFile,
  readSourceUploadCache,
  writeSourceUploadCache,
  type SourceUploadCacheFile,
} from "@openpond/cloud/profile/source-upload-cache";

import {
  formatSandboxTemplateDiagnostics,
  validateSandboxTemplateYaml,
} from "../sandbox-template/manifest";
import { optionString, runCommand } from "./common";
import { resolveLocalAgentSdkCommand } from "./agent-sdk-command";

export const PROJECT_SOURCE_UPLOAD_MAX_FILES = 1500;
export const PROJECT_SOURCE_UPLOAD_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const PROJECT_SOURCE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const PROJECT_SOURCE_UPLOAD_CONCURRENCY = 8;
export const PROJECT_SOURCE_UPLOAD_LIMITS = {
  maxFiles: PROJECT_SOURCE_UPLOAD_MAX_FILES,
  maxFileBytes: PROJECT_SOURCE_UPLOAD_MAX_FILE_BYTES,
  maxTotalBytes: PROJECT_SOURCE_UPLOAD_MAX_BYTES,
  concurrency: PROJECT_SOURCE_UPLOAD_CONCURRENCY,
};
export const PROJECT_SOURCE_UPLOAD_TRANSPORT = {
  mode: "single_json_payload" as const,
  chunkingSupported: false as const,
};
const AGENT_SDK_SOURCE_UPLOAD_METADATA_PATH =
  ".openpond/source-upload-metadata.json";
const AGENT_SDK_VENDOR_TARBALL_PATH =
  ".openpond/vendor/openpond-agent-sdk.tgz";
const AGENT_SDK_VENDOR_NPM_DEPENDENCY_DIR = ".openpond/vendor/npm";
const AGENT_SDK_MATERIALIZED_DEPENDENCY_SPEC =
  `file:${AGENT_SDK_VENDOR_TARBALL_PATH}`;
const AGENT_SDK_SYNTHESIZED_OPENPOND_YAML_SENTINEL =
  "# openpond-agent-sdk-source-upload: synthesized-openpond-yaml";
const AGENT_SDK_GENERATED_SKILLS_DIR = ".openpond/skills";
const AGENT_SDK_GENERATED_ARTIFACTS = [
  ".openpond/agent-inspect.json",
  ".openpond/agent-manifest.json",
  ".openpond/action-registry.json",
  ".openpond/openpond-manifest.preview.yaml",
  ".openpond/runtime-bridge.mjs",
  ".openpond/validator-report.md",
];

type ProjectSourceUploadEntry = { path: string; type: "file"; contentsBase64: string };

type ProjectSourceUpload = {
  entries: ProjectSourceUploadEntry[];
  fileCount: number;
  totalBytes: number;
  limits: typeof PROJECT_SOURCE_UPLOAD_LIMITS;
  transport: typeof PROJECT_SOURCE_UPLOAD_TRANSPORT;
};

type ProjectSourceUploadFile = {
  path: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
};

function isSafeProjectSourcePath(filePath: string): boolean {
  return (
    filePath.length > 0 &&
    !filePath.includes("\0") &&
    !path.isAbsolute(filePath) &&
    !filePath.split(/[\\/]+/).some((part) => !part || part === "." || part === "..")
  );
}

function shouldSkipProjectSourcePath(filePath: string): boolean {
  return filePath.split(/[\\/]+/).some((segment) => {
    const lower = segment.toLowerCase();
    return (
      lower === ".git" ||
      lower === ".openpond" ||
      lower === "node_modules" ||
      lower === ".next" ||
      lower === ".turbo" ||
      lower.startsWith(".env")
    );
  });
}

export async function resolveProjectSourceUploadBranch(
  projectPath: string,
  options: Record<string, string | boolean>
): Promise<string | null> {
  const explicit = optionString(options, "branch");
  if (explicit) return explicit;
  const branch = await runCommand("git", ["branch", "--show-current"], {
    cwd: projectPath,
  });
  if (branch.code !== 0) return null;
  return branch.stdout.trim() || null;
}

export async function collectProjectSourceUploadEntries(projectPath: string): Promise<ProjectSourceUpload> {
  const sourcePaths = await collectProjectSourceUploadPaths(projectPath);
  if (sourcePaths.length === 0) {
    throw new Error("no source files found to upload");
  }
  if (sourcePaths.length > PROJECT_SOURCE_UPLOAD_MAX_FILES) {
    throw new Error(
      `too many source files to upload: ${sourcePaths.length} > ${PROJECT_SOURCE_UPLOAD_MAX_FILES}`
    );
  }

  const sortedSourcePaths = sourcePaths.sort();
  const filesToUpload = (
    await mapWithConcurrency(sortedSourcePaths, PROJECT_SOURCE_UPLOAD_CONCURRENCY, async (sourcePath) => {
      const absolutePath = path.resolve(projectPath, sourcePath);
      const relative = path.relative(projectPath, absolutePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`source path escapes project: ${sourcePath}`);
      }
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) return null;
      if (stat.size > PROJECT_SOURCE_UPLOAD_MAX_FILE_BYTES) {
        throw new Error(
          `source file is too large: ${sourcePath} (${stat.size} bytes)`
        );
      }
      return {
        path: sourcePath.replace(/\\/g, "/"),
        absolutePath,
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
      } satisfies ProjectSourceUploadFile;
    })
  ).filter((file): file is ProjectSourceUploadFile => file !== null);

  let totalBytes = 0;
  for (const file of filesToUpload) {
    totalBytes += file.size;
    if (totalBytes > PROJECT_SOURCE_UPLOAD_MAX_BYTES) {
      throw new Error(
        `source upload is too large: ${totalBytes} > ${PROJECT_SOURCE_UPLOAD_MAX_BYTES}`
      );
    }
  }

  const cache = await readSourceUploadCache(projectPath);
  const materialized = await mapWithConcurrency(filesToUpload, PROJECT_SOURCE_UPLOAD_CONCURRENCY, async (file) =>
    materializeSourceUploadFile(file as SourceUploadCacheFile, cache)
  );
  await writeSourceUploadCache(projectPath, materialized).catch(() => {});
  const entries = materialized.map((item) => item.entry);

  return {
    entries,
    fileCount: entries.length,
    totalBytes,
    limits: PROJECT_SOURCE_UPLOAD_LIMITS,
    transport: PROJECT_SOURCE_UPLOAD_TRANSPORT,
  };
}

async function mapWithConcurrency<Input, Output>(
  items: Input[],
  concurrency: number,
  mapper: (item: Input, index: number) => Promise<Output>
): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index]!, index);
      }
    })
  );
  return results;
}

async function collectProjectSourceUploadPaths(
  projectPath: string
): Promise<string[]> {
  const files = await runCommand(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: projectPath }
  );
  if (files.code !== 0) {
    if (existsSync(path.join(projectPath, ".git"))) {
      throw new Error(
        `git ls-files failed: ${
          files.stderr.trim() || files.stdout.trim() || "unknown error"
        }`
      );
    }
    return collectFilesystemProjectSourceUploadPaths(projectPath);
  }

  return files.stdout
    .split("\0")
    .map((filePath) => filePath.trim())
    .filter(Boolean)
    .filter((filePath) => {
      const normalized = filePath.replace(/\\/g, "/");
      return (
        isSafeProjectSourcePath(normalized) &&
        !shouldSkipProjectSourcePath(normalized)
      );
    });
}

async function collectFilesystemProjectSourceUploadPaths(
  projectPath: string
): Promise<string[]> {
  const sourcePaths: string[] = [];
  async function visit(relativeDir: string): Promise<void> {
    const absoluteDir = path.join(projectPath, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name).replace(/\\/g, "/");
      if (
        !isSafeProjectSourcePath(relativePath) ||
        shouldSkipProjectSourcePath(relativePath)
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(relativePath);
        continue;
      }
      if (entry.isFile()) sourcePaths.push(relativePath);
    }
  }

  try {
    await visit("");
  } catch (error) {
    throw new Error(
      `filesystem source scan failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return sourcePaths;
}

export async function collectAgentSdkProjectSourceUploadEntries(
  projectPath: string,
  existingEntries: Array<{ path: string }>
): Promise<{
  entries: Array<{ path: string; type: "file"; contentsBase64: string }>;
  generatedManifestPath: string | null;
  synthesizedOpenPondYaml: boolean;
  uploadMetadataPath: string | null;
  uploadMetadata: Record<string, unknown> | null;
  uploadMetadataHash: { sha256: string; sizeBytes: number } | null;
}> {
  if (!isAgentSdkProject(projectPath)) {
    return {
      entries: [],
      generatedManifestPath: null,
      synthesizedOpenPondYaml: false,
      uploadMetadataPath: null,
      uploadMetadata: null,
      uploadMetadataHash: null,
    };
  }

  await runAgentSdkProjectCheck(projectPath, "build");
  await runAgentSdkProjectCheck(projectPath, "validate");
  await runAgentSdkProjectCheck(projectPath, "eval");

  const packageJson = readAgentSdkProjectPackageJson(projectPath);
  const materializedDependency = await buildAgentSdkMaterializedDependency(
    projectPath,
    packageJson
  );
  const manifestPath = ".openpond/openpond-manifest.preview.yaml";
  const manifestSource = await fs.readFile(path.join(projectPath, manifestPath), "utf8");
  const openPondYamlSource = sanitizeAgentSdkRuntimeManifestForOpenPondYaml(
    manifestSource,
    materializedDependency?.dependencySetup ?? null
  );
  const manifestResult = validateSandboxTemplateYaml(openPondYamlSource);
  if (!manifestResult.ok) {
    throw new Error(
      `generated ${manifestPath} failed sandbox-template validation after openpond.yaml sanitization:\n${formatSandboxTemplateDiagnostics(
        manifestResult.diagnostics
      )}`
    );
  }

  const entries: Array<{ path: string; type: "file"; contentsBase64: string }> = [];
  if (materializedDependency?.rewrittenPackageJson) {
    entries.push(
      projectSourceUploadTextEntry(
        "package.json",
        `${JSON.stringify(materializedDependency.rewrittenPackageJson, null, 2)}\n`
      )
    );
  }
  for (const tarball of materializedDependency?.tarballs ?? []) {
    entries.push(
      projectSourceUploadBufferEntry(tarball.path, tarball.contents)
    );
  }
  const generatedArtifactPaths = await collectAgentSdkGeneratedArtifactPaths(projectPath);
  for (const artifactPath of generatedArtifactPaths) {
    entries.push(await projectSourceUploadFileEntry(projectPath, artifactPath));
  }

  const hasAuthoredOpenPondYaml =
    existingEntries.some((entry) => entry.path === "openpond.yaml") ||
    existsSync(path.join(projectPath, "openpond.yaml"));
  if (!hasAuthoredOpenPondYaml) {
    entries.push(projectSourceUploadTextEntry("openpond.yaml", openPondYamlSource));
  } else {
    const authoredSource = await fs.readFile(path.join(projectPath, "openpond.yaml"), "utf8");
    const authoredResult = validateSandboxTemplateYaml(authoredSource);
    if (!authoredResult.ok) {
      throw new Error(
        `authored openpond.yaml failed sandbox-template validation:\n${formatSandboxTemplateDiagnostics(
          authoredResult.diagnostics
        )}`
      );
    }
  }
  const uploadMetadata = await buildAgentSdkSourceUploadMetadata(projectPath, {
    packageJson,
    generatedManifestPath: manifestPath,
    generatedArtifactPaths,
    synthesizedOpenPondYaml: !hasAuthoredOpenPondYaml,
    openPondYamlSource,
    dependencySetup: materializedDependency?.dependencySetup ?? null,
  });
  const uploadMetadataSource = `${JSON.stringify(uploadMetadata, null, 2)}\n`;
  const uploadMetadataHash = {
    sha256: sha256Hex(Buffer.from(uploadMetadataSource, "utf8")),
    sizeBytes: Buffer.byteLength(uploadMetadataSource, "utf8"),
  };
  entries.push(
    projectSourceUploadTextEntry(
      AGENT_SDK_SOURCE_UPLOAD_METADATA_PATH,
      uploadMetadataSource
    )
  );

  return {
    entries,
    generatedManifestPath: manifestPath,
    synthesizedOpenPondYaml: !hasAuthoredOpenPondYaml,
    uploadMetadataPath: AGENT_SDK_SOURCE_UPLOAD_METADATA_PATH,
    uploadMetadata,
    uploadMetadataHash,
  };
}

async function buildAgentSdkSourceUploadMetadata(
  projectPath: string,
  params: {
    packageJson: Record<string, unknown>;
    generatedManifestPath: string;
    generatedArtifactPaths: string[];
    synthesizedOpenPondYaml: boolean;
    openPondYamlSource: string;
    dependencySetup: Record<string, unknown> | null;
  }
): Promise<Record<string, unknown>> {
  const packageManager = detectAgentSdkPackageManager(projectPath, params.packageJson);
  const commandHints = buildAgentSdkCommandHints(params.packageJson, packageManager);
  const setupRequirements = await collectAgentSdkSourceSetupRequirements(projectPath);
  const artifactHashes: Record<
    string,
    { sha256: string; sizeBytes: number }
  > = {};
  for (const artifactPath of params.generatedArtifactPaths) {
    const absolutePath = path.join(projectPath, artifactPath);
    if (!existsSync(absolutePath)) continue;
    const contents = await fs.readFile(absolutePath);
    artifactHashes[artifactPath] = {
      sha256: sha256Hex(contents),
      sizeBytes: contents.byteLength,
    };
  }
  artifactHashes["openpond.yaml"] = {
    sha256: sha256Hex(Buffer.from(params.openPondYamlSource, "utf8")),
    sizeBytes: Buffer.byteLength(params.openPondYamlSource, "utf8"),
  };

  return {
    schema: "openpond.agent.source_upload.v1",
    sourceTreeMode: "typescript_agent_sdk",
    packageManager,
    sdk: {
      packageName: "openpond-agent-sdk",
      versionSpec: readOpenPondAgentSdkVersionSpec(params.packageJson),
    },
    commands: commandHints,
    ...(params.dependencySetup ? { dependencySetup: params.dependencySetup } : {}),
    ...(setupRequirements.length > 0 ? { setupRequirements } : {}),
    generatedManifestPath: params.generatedManifestPath,
    synthesizedOpenPondYaml: params.synthesizedOpenPondYaml,
    openPondYamlMode: params.synthesizedOpenPondYaml ? "synthesized" : "authored",
    artifactHashes,
  };
}

export async function collectAgentSdkGeneratedArtifactPaths(projectPath: string): Promise<string[]> {
  const generatedArtifacts = new Set<string>();
  for (const artifactPath of AGENT_SDK_GENERATED_ARTIFACTS) {
    if (existsSync(path.join(projectPath, artifactPath))) {
      generatedArtifacts.add(artifactPath);
    }
  }
  for (const skillArtifactPath of await collectAgentSdkGeneratedSkillArtifactPaths(projectPath)) {
    generatedArtifacts.add(skillArtifactPath);
  }
  return Array.from(generatedArtifacts).sort((left, right) => left.localeCompare(right));
}

async function collectAgentSdkGeneratedSkillArtifactPaths(projectPath: string): Promise<string[]> {
  const skillsRoot = path.join(projectPath, AGENT_SDK_GENERATED_SKILLS_DIR);
  if (!existsSync(skillsRoot)) return [];

  const results: string[] = [];
  async function visit(relativeDir: string): Promise<void> {
    const absoluteDir = path.join(projectPath, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name).replace(/\\/g, "/");
      if (!isSafeProjectSourcePath(relativePath)) continue;
      if (entry.isDirectory()) {
        await visit(relativePath);
        continue;
      }
      if (entry.isFile()) results.push(relativePath);
    }
  }

  await visit(AGENT_SDK_GENERATED_SKILLS_DIR);
  return results;
}

async function collectAgentSdkSourceSetupRequirements(
  projectPath: string
): Promise<Record<string, unknown>[]> {
  const requirements: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const relativePath of [
    ".openpond/action-registry.json",
    ".openpond/agent-manifest.json",
  ]) {
    const payload = await readJsonFileIfExists(path.join(projectPath, relativePath));
    if (!payload) continue;
    for (const actionRecord of [
      ...recordArray((payload as Record<string, unknown>).actions),
      ...recordArray((payload as Record<string, unknown>).actionCatalog),
    ]) {
      const actionId = text(actionRecord.id) ?? text(actionRecord.name);
      const actionName = text(actionRecord.name) ?? actionId;
      if (!actionId && !actionName) continue;
      for (const setupRecord of recordArray(actionRecord.setupRequirements)) {
        const setupRequirement: Record<string, unknown> = { ...setupRecord };
        if (actionId) setupRequirement.actionId = actionId;
        if (actionName && actionName !== actionId) setupRequirement.actionName = actionName;
        const key = setupRequirementIdentity(setupRequirement);
        if (seen.has(key)) continue;
        seen.add(key);
        requirements.push(setupRequirement);
      }
    }
  }
  return requirements;
}

async function readJsonFileIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function setupRequirementIdentity(record: Record<string, unknown>): string {
  return [
    text(record.actionId) ?? "",
    text(record.actionName) ?? "",
    text(record.kind) ?? text(record.type) ?? "",
    text(record.label) ??
      text(record.name) ??
      text(record.key) ??
      text(record.provider) ??
      text(record.tool) ??
      text(record.command) ??
      text(record.packageName) ??
      "",
  ].join(":");
}

function readAgentSdkProjectPackageJson(
  projectPath: string
): Record<string, unknown> {
  const packageJsonPath = path.join(projectPath, "package.json");
  return JSON.parse(readFileSyncUtf8(packageJsonPath)) as Record<
    string,
    unknown
  >;
}

function detectAgentSdkPackageManager(
  projectPath: string,
  packageJson: Record<string, unknown>
): "bun" | "npm" | "pnpm" | "yarn" | "unknown" {
  const packageManager = packageJson.packageManager;
  if (typeof packageManager === "string") {
    const name = packageManager.split("@")[0];
    if (name === "bun" || name === "npm" || name === "pnpm" || name === "yarn") {
      return name;
    }
  }
  if (
    existsSync(path.join(projectPath, "bun.lock")) ||
    existsSync(path.join(projectPath, "bun.lockb"))
  ) {
    return "bun";
  }
  if (existsSync(path.join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(projectPath, "yarn.lock"))) return "yarn";
  if (
    existsSync(path.join(projectPath, "package-lock.json")) ||
    existsSync(path.join(projectPath, "npm-shrinkwrap.json"))
  ) {
    return "npm";
  }
  return "unknown";
}

function buildAgentSdkCommandHints(
  packageJson: Record<string, unknown>,
  packageManager: "bun" | "npm" | "pnpm" | "yarn" | "unknown"
): Record<string, string> {
  return {
    inspect: buildAgentSdkCommandHint(
      packageJson,
      packageManager,
      "agent:inspect",
      "openpond-agent inspect --json"
    ),
    build: buildAgentSdkCommandHint(
      packageJson,
      packageManager,
      "agent:build",
      "openpond-agent build"
    ),
    validate: buildAgentSdkCommandHint(
      packageJson,
      packageManager,
      "agent:validate",
      "openpond-agent validate"
    ),
    eval: buildAgentSdkCommandHint(
      packageJson,
      packageManager,
      "agent:eval",
      "openpond-agent eval"
    ),
  };
}

function buildAgentSdkCommandHint(
  packageJson: Record<string, unknown>,
  packageManager: "bun" | "npm" | "pnpm" | "yarn" | "unknown",
  scriptName: string,
  fallback: string
): string {
  const scripts = packageJson.scripts;
  const hasScript =
    scripts &&
    typeof scripts === "object" &&
    !Array.isArray(scripts) &&
    typeof (scripts as Record<string, unknown>)[scriptName] === "string";
  if (!hasScript) return fallback;
  if (packageManager === "pnpm") return `pnpm run ${scriptName}`;
  if (packageManager === "yarn") return `yarn ${scriptName}`;
  if (packageManager === "npm") return `npm run ${scriptName}`;
  return `bun run ${scriptName}`;
}

function readOpenPondAgentSdkVersionSpec(
  packageJson: Record<string, unknown>
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

async function buildAgentSdkMaterializedDependency(
  projectPath: string,
  packageJson: Record<string, unknown>
): Promise<{
  rewrittenPackageJson: Record<string, unknown>;
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
    const rewrittenPackageJson = rewriteAgentSdkPackageJsonForMaterialization(
      packageJson,
      sdkDependencyTarballs
    );
    const packageManager = detectAgentSdkPackageManager(projectPath, packageJson);
    const installCommand = agentSdkDependencyInstallCommand(packageManager);
    const sdkPackage = {
      packageName: "openpond-agent-sdk",
      source: "uploaded_tarball",
      path: AGENT_SDK_VENDOR_TARBALL_PATH,
      sha256: sha256Hex(sdkContents),
      sizeBytes: sdkContents.byteLength,
    };
    return {
      rewrittenPackageJson,
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
  const tarballs: AgentSdkMaterializedTarball[] = [];
  for (const [packageName, versionSpec] of Object.entries(dependencies).sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
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
  }
  return tarballs;
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
  dependencyTarballs: AgentSdkMaterializedTarball[]
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

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function agentSdkDependencyInstallCommand(
  packageManager: "bun" | "npm" | "pnpm" | "yarn" | "unknown"
): string {
  if (packageManager === "npm") return "npm install --offline";
  if (packageManager === "pnpm") return "pnpm install --offline";
  if (packageManager === "yarn") return "yarn install --offline";
  return "bun install --offline";
}

function sha256Hex(contents: Buffer): string {
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

function sanitizeAgentSdkRuntimeManifestForOpenPondYaml(
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

function isAgentSdkProject(projectPath: string): boolean {
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

function readFileSyncUtf8(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

async function runAgentSdkProjectCheck(
  projectPath: string,
  commandName: "build" | "validate" | "eval"
): Promise<void> {
  const command = resolveLocalAgentSdkCommand(projectPath);
  const result = await runCommand(command.command, [...command.args, commandName, "--cwd", projectPath], {
    cwd: projectPath,
  });
  if (result.code !== 0) {
    const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(
      `openpond agent ${commandName} failed for ${projectPath}${details ? `:\n${details}` : ""}`
    );
  }
}

async function projectSourceUploadFileEntry(
  projectPath: string,
  relativePath: string
): Promise<{ path: string; type: "file"; contentsBase64: string }> {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!isSafeProjectSourcePath(normalized) || normalized.startsWith(".env")) {
    throw new Error(`unsafe generated source path: ${relativePath}`);
  }
  const absolutePath = path.join(projectPath, normalized);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`generated source path is not a file: ${relativePath}`);
  }
  if (stat.size > PROJECT_SOURCE_UPLOAD_MAX_FILE_BYTES) {
    throw new Error(`generated source file is too large: ${relativePath} (${stat.size} bytes)`);
  }
  return {
    path: normalized,
    type: "file",
    contentsBase64: Buffer.from(await fs.readFile(absolutePath)).toString("base64"),
  };
}

function projectSourceUploadTextEntry(
  relativePath: string,
  contents: string
): { path: string; type: "file"; contentsBase64: string } {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!isSafeProjectSourcePath(normalized) || normalized.startsWith(".env")) {
    throw new Error(`unsafe generated source path: ${relativePath}`);
  }
  const byteLength = Buffer.byteLength(contents, "utf8");
  if (byteLength > PROJECT_SOURCE_UPLOAD_MAX_FILE_BYTES) {
    throw new Error(`generated source file is too large: ${relativePath} (${byteLength} bytes)`);
  }
  return {
    path: normalized,
    type: "file",
    contentsBase64: Buffer.from(contents, "utf8").toString("base64"),
  };
}

function projectSourceUploadBufferEntry(
  relativePath: string,
  contents: Buffer
): { path: string; type: "file"; contentsBase64: string } {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!isSafeProjectSourcePath(normalized) || normalized.startsWith(".env")) {
    throw new Error(`unsafe generated source path: ${relativePath}`);
  }
  if (contents.byteLength > PROJECT_SOURCE_UPLOAD_MAX_FILE_BYTES) {
    throw new Error(
      `generated source file is too large: ${relativePath} (${contents.byteLength} bytes)`
    );
  }
  return {
    path: normalized,
    type: "file",
    contentsBase64: contents.toString("base64"),
  };
}

export function mergeProjectSourceUploadEntries(
  collected: {
    entries: Array<{ path: string; type: "file"; contentsBase64: string }>;
    fileCount: number;
    totalBytes: number;
  },
  extraEntries: Array<{ path: string; type: "file"; contentsBase64: string }>
) {
  const byPath = new Map<string, { path: string; type: "file"; contentsBase64: string }>();
  for (const entry of collected.entries) byPath.set(entry.path, entry);
  for (const entry of extraEntries) byPath.set(entry.path, entry);
  const entries = Array.from(byPath.values()).sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  const totalBytes = entries.reduce(
    (sum, entry) => sum + Buffer.byteLength(entry.contentsBase64, "base64"),
    0
  );
  if (entries.length > PROJECT_SOURCE_UPLOAD_MAX_FILES) {
    throw new Error(`too many source files to upload: ${entries.length} > ${PROJECT_SOURCE_UPLOAD_MAX_FILES}`);
  }
  if (totalBytes > PROJECT_SOURCE_UPLOAD_MAX_BYTES) {
    throw new Error(`source upload is too large: ${totalBytes} > ${PROJECT_SOURCE_UPLOAD_MAX_BYTES}`);
  }
  return {
    entries,
    fileCount: entries.length,
    totalBytes,
    limits: PROJECT_SOURCE_UPLOAD_LIMITS,
    transport: PROJECT_SOURCE_UPLOAD_TRANSPORT,
  };
}
