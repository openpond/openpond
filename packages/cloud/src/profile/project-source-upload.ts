import { Buffer } from "node:buffer";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import {
  materializeSourceUploadFile,
  readSourceUploadCache,
  writeSourceUploadCache,
  type SourceUploadCacheFile,
} from "./source-upload-cache.js";

import {
  formatSandboxTemplateDiagnostics,
  validateSandboxTemplateYaml,
} from "../sandbox-template/manifest.js";
import { runProcessCommand } from "../process-runner.js";
import { resolveLocalAgentSdkCommand } from "./agent-sdk-command.js";
import {
  buildAgentSdkMaterializedDependency,
  isAgentSdkProject,
  readFileSyncUtf8,
  recordArray,
  sanitizeAgentSdkRuntimeManifestForOpenPondYaml,
  sha256Hex,
  text,
} from "./project-source-upload-agent-sdk.js";
import {
  agentSdkRunScriptCommand,
  detectAgentSdkPackageManager,
  type AgentSdkPackageManager,
} from "./project-source-upload-bun-compat.js";

function optionString(
  options: Record<string, string | boolean>,
  key: string,
): string {
  const value = options[key];
  return typeof value === "string" ? value.trim() : "";
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
) {
  return runProcessCommand(command, args, { cwd: options.cwd });
}

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
  ctimeMs: number;
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
        ctimeMs: Math.trunc(stat.ctimeMs),
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
  if (materializedDependency?.pnpmWorkspaceSource) {
    entries.push(
      projectSourceUploadTextEntry(
        "pnpm-workspace.yaml",
        materializedDependency.pnpmWorkspaceSource,
      ),
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

function buildAgentSdkCommandHints(
  packageJson: Record<string, unknown>,
  packageManager: AgentSdkPackageManager
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
  packageManager: AgentSdkPackageManager,
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
  return agentSdkRunScriptCommand(packageManager, scriptName);
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
  const regeneratesPnpmLock = extraEntries.some(
    (entry) => entry.path === "pnpm-workspace.yaml",
  );
  for (const entry of collected.entries) {
    if (regeneratesPnpmLock && entry.path === "pnpm-lock.yaml") continue;
    byPath.set(entry.path, entry);
  }
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
