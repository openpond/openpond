import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import {
  HarnessSourceManifestSchema,
  HarnessWorkspaceSchema,
  type OpenPondProfileState,
  type HarnessSourceManifest,
  type HarnessWorkspace,
} from "@openpond/contracts";
import {
  AgentSnapshotSchema,
  HarnessReleaseSchema,
  canonicalJson,
  contentHash,
  createAgentSnapshot,
  createHarnessRelease,
  sha256,
  type AgentSnapshot,
  type HarnessRelease,
  type ImmutableAssetRef,
} from "@openpond/harness";

import type { SqliteStore } from "../store/store.js";
import {
  LocalHarnessReleaseRecordSchema,
  type LocalHarnessReleaseRecord,
} from "../store/store-harness-workspaces.js";

const HARNESS_SOURCE_MANIFEST = "harness.json";
const MAX_SOURCE_FILE_BYTES = 250_000_000;

export type CompiledLocalHarnessSource = {
  manifest: HarnessSourceManifest;
  sourceRevision: string;
  agentSnapshot: AgentSnapshot;
  harnessRelease: HarnessRelease;
  sourceFiles: Array<{ path: string; bytes: Uint8Array; asset: ImmutableAssetRef }>;
};

export type LocalHarnessWorkspacePaths = {
  root: string;
  source: string;
};

export function localHarnessWorkspacePaths(
  storeDir: string,
  workspaceId: string,
): LocalHarnessWorkspacePaths {
  const segment = `${safeSegment(workspaceId)}-${contentHash(workspaceId).slice(0, 16)}`;
  const root = path.join(storeDir, "library", "harnesses", "workspaces", segment);
  return { root, source: path.join(root, "source") };
}

export async function createLocalHarnessWorkspace(input: {
  store: SqliteStore;
  storeDir: string;
  id: string;
  ownerId: string;
  name: string;
  now?: () => string;
}): Promise<{ workspace: HarnessWorkspace; release: LocalHarnessReleaseRecord }> {
  return createLocalHarnessWorkspaceFromInitializer({
    ...input,
    initializeSource: (sourceDir) => writeDefaultHarnessSource(sourceDir, input.name),
  });
}

export async function importProfileIntoLocalHarnessWorkspace(input: {
  store: SqliteStore;
  storeDir: string;
  id: string;
  ownerId: string;
  name: string;
  profile: OpenPondProfileState;
  now?: () => string;
}): Promise<{ workspace: HarnessWorkspace; release: LocalHarnessReleaseRecord }> {
  if (input.profile.mode !== "local" || !input.profile.sourcePath) {
    throw new Error("Only a loaded local Profile with a source path can be imported.");
  }
  return createLocalHarnessWorkspaceFromInitializer({
    ...input,
    initializeSource: (sourceDir) => writeImportedProfileSource(sourceDir, input.name, input.profile),
  });
}

export async function forkLocalHarnessWorkspaceFromRelease(input: {
  store: SqliteStore;
  storeDir: string;
  id: string;
  ownerId: string;
  name: string;
  sourceRelease: { id: string; contentHash: string };
  now?: () => string;
}): Promise<{ workspace: HarnessWorkspace; release: LocalHarnessReleaseRecord }> {
  const source = await input.store.getHarnessReleaseRecord(
    input.sourceRelease.contentHash,
  );
  if (
    !source ||
    source.harnessRelease.id !== input.sourceRelease.id
  ) {
    throw new Error("Harness workspace fork source release is unavailable.");
  }
  return createLocalHarnessWorkspaceFromInitializer({
    ...input,
    initializeSource: async (sourceDir) => {
      await fs.cp(path.join(source.bundlePath, "source"), sourceDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: false,
      });
      await ensureHarnessInstructionSurface(sourceDir, input.name);
    },
  });
}

async function createLocalHarnessWorkspaceFromInitializer(input: {
  store: SqliteStore;
  storeDir: string;
  id: string;
  ownerId: string;
  name: string;
  initializeSource: (sourceDir: string) => Promise<void>;
  now?: () => string;
}): Promise<{ workspace: HarnessWorkspace; release: LocalHarnessReleaseRecord }> {
  const now = input.now ?? (() => new Date().toISOString());
  const paths = localHarnessWorkspacePaths(input.storeDir, input.id);
  const parent = path.dirname(paths.root);
  await fs.mkdir(parent, { recursive: true });
  const temporaryRoot = path.join(parent, `.${path.basename(paths.root)}.creating-${randomUUID()}`);
  const temporarySource = path.join(temporaryRoot, "source");
  try {
    await input.initializeSource(temporarySource);
    await fs.rename(temporaryRoot, paths.root);
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  try {
    const compiled = await compileLocalHarnessSource({
      workspaceId: input.id,
      sourceDir: paths.source,
    });
    const release = await materializeLocalHarnessRelease({
      storeDir: input.storeDir,
      workspaceId: input.id,
      compiled,
      createdAt: now(),
    });
    const timestamp = now();
    const workspace = HarnessWorkspaceSchema.parse({
      schemaVersion: "openpond.harnessWorkspace.v1",
      id: input.id,
      ownerScope: { kind: "personal", id: input.ownerId },
      name: input.name,
      location: "local",
      sourceRevision: compiled.sourceRevision,
      revision: 0,
      dirty: false,
      currentChannel: {
        name: "personal",
        release: {
          id: compiled.harnessRelease.id,
          contentHash: compiled.harnessRelease.contentHash,
        },
        revision: 1,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: { sourceLayout: "openpond.harnessSourceManifest.v1" },
    });
    return await input.store.createHarnessWorkspaceWithRelease({ workspace, release });
  } catch (error) {
    await fs.rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function compileAndRegisterLocalHarnessRelease(input: {
  store: SqliteStore;
  storeDir: string;
  workspaceId: string;
  now?: () => string;
}): Promise<{ workspace: HarnessWorkspace; release: LocalHarnessReleaseRecord }> {
  const workspace = await input.store.getHarnessWorkspace(input.workspaceId);
  if (!workspace) throw new Error(`Harness workspace ${input.workspaceId} does not exist.`);
  if (workspace.location !== "local") throw new Error("Only local Harness workspaces can use the local compiler.");
  const paths = localHarnessWorkspacePaths(input.storeDir, workspace.id);
  const compiled = await compileLocalHarnessSource({
    workspaceId: workspace.id,
    sourceDir: paths.source,
  });
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const release = await materializeLocalHarnessRelease({
    storeDir: input.storeDir,
    workspaceId: workspace.id,
    compiled,
    createdAt: timestamp,
  });
  await input.store.saveHarnessReleaseRecord(release);
  const nextWorkspace = compiled.sourceRevision === workspace.sourceRevision
    ? workspace
    : await input.store.updateHarnessWorkspaceSourceRevisionAtomically({
        workspaceId: workspace.id,
        expectedWorkspaceRevision: workspace.revision,
        expectedSourceRevision: workspace.sourceRevision,
        nextSourceRevision: compiled.sourceRevision,
        updatedAt: timestamp,
      });
  return { workspace: nextWorkspace, release };
}

export async function compileLocalHarnessSource(input: {
  workspaceId: string;
  sourceDir: string;
}): Promise<CompiledLocalHarnessSource> {
  const root = path.resolve(input.sourceDir);
  const manifestPath = path.join(root, HARNESS_SOURCE_MANIFEST);
  const manifest = HarnessSourceManifestSchema.parse(
    JSON.parse(await fs.readFile(manifestPath, "utf8")),
  );
  const declaredPaths = new Set(manifest.files.map((file) => file.path));
  const actualPaths = (await listRegularFiles(root)).filter((file) => file !== HARNESS_SOURCE_MANIFEST);
  const unlisted = actualPaths.filter((file) => !declaredPaths.has(file));
  const missing = [...declaredPaths].filter((file) => !actualPaths.includes(file));
  if (unlisted.length || missing.length) {
    throw new Error(
      `Harness source manifest mismatch. Unlisted: ${unlisted.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}.`,
    );
  }

  const sourceFiles: CompiledLocalHarnessSource["sourceFiles"] = [];
  for (const declaration of manifest.files) {
    const absolutePath = await resolveContainedRegularFile(root, declaration.path);
    const bytes = await fs.readFile(absolutePath);
    if (bytes.byteLength > MAX_SOURCE_FILE_BYTES) {
      throw new Error(`Harness source file ${declaration.path} exceeds ${MAX_SOURCE_FILE_BYTES} bytes.`);
    }
    sourceFiles.push({
      path: declaration.path,
      bytes,
      asset: {
        id: declaration.id,
        path: declaration.path,
        contentHash: sha256(bytes),
        sizeBytes: bytes.byteLength,
        mediaType: declaration.mediaType,
        visibility: declaration.visibility,
      },
    });
  }

  const sourceRevision = contentHash({
    manifest,
    files: sourceFiles.map(({ path: filePath, asset }) => ({
      path: filePath,
      contentHash: asset.contentHash,
      sizeBytes: asset.sizeBytes,
    })),
  });
  const byKind = (kind: HarnessSourceManifest["files"][number]["kind"]) =>
    sourceFiles
      .filter(({ path: filePath }) => manifest.files.find((file) => file.path === filePath)?.kind === kind)
      .map(({ asset }) => asset);
  const dependencyLock = byKind("dependency_lock")[0]!;
  const program = byKind("program")[0]!;
  const localOnlyAssetRefs = manifest.files
    .filter((file) => file.portability === "local_only")
    .map((file) => file.id);
  const hostPrivateAssetRefs = manifest.files
    .filter((file) => file.visibility === "host_private")
    .map((file) => file.id);
  const portabilityBlockers = [
    ...localOnlyAssetRefs.map((id) => `Asset ${id} is local-only.`),
    ...hostPrivateAssetRefs.map((id) => `Asset ${id} is host-private.`),
  ];
  const sourceRelease = {
    id: `harness-source-${sourceRevision.slice(0, 24)}`,
    contentHash: sourceRevision,
  };
  const agentSnapshot = createAgentSnapshot({
    schemaVersion: "openpond.agentSnapshot.v2",
    id: `agent-snapshot-${contentHash([sourceRevision, manifest.toolDeclarations]).slice(0, 24)}`,
    sourceRelease,
    instructions: byKind("instruction"),
    skills: byKind("skill"),
    agents: byKind("agent"),
    toolDeclarations: manifest.toolDeclarations,
    capabilityRequirements: manifest.capabilityRequirements,
    dependencyLock,
    portability: {
      portable: portabilityBlockers.length === 0,
      blockers: portabilityBlockers,
      localOnlyAssetRefs,
      hostPrivateAssetRefs,
    },
    metadata: {
      workspaceId: input.workspaceId,
      sourceRevision,
      sourceLayout: manifest.schemaVersion,
    },
  });
  const harnessRelease = createHarnessRelease({
    schemaVersion: "openpond.harnessRelease.v2",
    id: `harness-${contentHash([agentSnapshot.contentHash, program.contentHash, manifest.lifecycle]).slice(0, 24)}`,
    agentSnapshot: { id: agentSnapshot.id, contentHash: agentSnapshot.contentHash },
    program,
    tools: manifest.toolDeclarations,
    lifecycle: manifest.lifecycle,
    graderInterface: manifest.graderInterface,
    files: sourceFiles.map(({ asset }) => asset),
    metadata: {
      runtimeProtocol: manifest.runtimeProtocol,
      sourceRevision,
      sourceLayout: manifest.schemaVersion,
    },
  });
  return { manifest, sourceRevision, agentSnapshot, harnessRelease, sourceFiles };
}

export async function materializeLocalHarnessRelease(input: {
  storeDir: string;
  workspaceId: string;
  compiled: CompiledLocalHarnessSource;
  createdAt: string;
}): Promise<LocalHarnessReleaseRecord> {
  const releasesRoot = path.join(input.storeDir, "library", "harnesses", "releases");
  const destination = path.join(releasesRoot, input.compiled.harnessRelease.contentHash);
  await fs.mkdir(releasesRoot, { recursive: true });
  const temporary = path.join(releasesRoot, `.${input.compiled.harnessRelease.contentHash}.materializing-${randomUUID()}`);
  try {
    await fs.mkdir(path.join(temporary, "source"), { recursive: true });
    for (const file of input.compiled.sourceFiles) {
      const target = path.join(temporary, "source", ...file.path.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.bytes, { flag: "wx" });
    }
    await fs.writeFile(
      path.join(temporary, "source", HARNESS_SOURCE_MANIFEST),
      canonicalJson(input.compiled.manifest),
      { flag: "wx" },
    );
    await fs.writeFile(
      path.join(temporary, "agent-snapshot.json"),
      canonicalJson(input.compiled.agentSnapshot),
      { flag: "wx" },
    );
    await fs.writeFile(
      path.join(temporary, "harness-release.json"),
      canonicalJson(input.compiled.harnessRelease),
      { flag: "wx" },
    );
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
        throw error;
      }
      await verifyMaterializedRelease(destination, input.compiled);
      await fs.rm(temporary, { recursive: true, force: true });
    }
    await verifyMaterializedRelease(destination, input.compiled);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return LocalHarnessReleaseRecordSchema.parse({
    schemaVersion: "openpond.localHarnessReleaseRecord.v1",
    workspaceId: input.workspaceId,
    sourceRevision: input.compiled.sourceRevision,
    agentSnapshot: input.compiled.agentSnapshot,
    harnessRelease: input.compiled.harnessRelease,
    bundlePath: destination,
    createdAt: input.createdAt,
  });
}

async function writeDefaultHarnessSource(sourceDir: string, name: string): Promise<void> {
  const manifest = HarnessSourceManifestSchema.parse({
    schemaVersion: "openpond.harnessSourceManifest.v1",
    name,
    files: [
      {
        id: "dependency-lock",
        kind: "dependency_lock",
        path: "dependency-lock.json",
        parentId: null,
        mediaType: "application/json",
        visibility: "policy",
        portability: "portable",
      },
      {
        id: "agent-runtime-program",
        kind: "program",
        path: "program.json",
        parentId: null,
        mediaType: "application/json",
        visibility: "policy",
        portability: "portable",
      },
    ],
    toolDeclarations: [],
    capabilityRequirements: [],
    lifecycle: {
      create: true,
      reset: true,
      step: true,
      collect: true,
      destroy: true,
      resetScope: "attempt",
    },
    graderInterface: {
      visibleEvidence: ["output", "runtime_events", "artifacts"],
      privilegedEvidence: ["expected_output", "private_verifier"],
      privateVerifierIsolation: true,
    },
    runtimeProtocol: "openpond.agent-runtime.v1",
    metadata: {},
  });
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "dependency-lock.json"), canonicalJson({ dependencies: {} }), { flag: "wx" });
  await fs.writeFile(path.join(sourceDir, "program.json"), canonicalJson({ runtimeProtocol: "openpond.agent-runtime.v1" }), { flag: "wx" });
  await fs.writeFile(path.join(sourceDir, HARNESS_SOURCE_MANIFEST), canonicalJson(manifest), { flag: "wx" });
  await ensureHarnessInstructionSurface(sourceDir, name);
}

async function writeImportedProfileSource(
  sourceDir: string,
  name: string,
  profile: OpenPondProfileState,
): Promise<void> {
  const profileSource = path.resolve(profile.sourcePath!);
  const declarations: HarnessSourceManifest["files"] = [];
  const declaredIds = new Set<string>();
  const addDeclaration = (
    declaration: HarnessSourceManifest["files"][number],
  ) => {
    let id = declaration.id;
    if (declaredIds.has(id)) id = `${id}-${contentHash(declaration.path).slice(0, 8)}`;
    declaredIds.add(id);
    const value = { ...declaration, id };
    declarations.push(value);
    return value;
  };

  await fs.mkdir(sourceDir, { recursive: true });
  for (const skill of profile.skills.filter((candidate) => candidate.enabled)) {
    if (skill.validationStatus !== "valid") {
      throw new Error(`Cannot import invalid Profile Skill ${skill.name}: ${skill.validationMessages.join(" ")}`);
    }
    const packageRoot = path.dirname(path.join(profileSource, skill.path));
    const skillTarget = `skills/${safeSegment(skill.name)}/SKILL.md`;
    await copyRegularFile(path.join(packageRoot, "SKILL.md"), path.join(sourceDir, ...skillTarget.split("/")));
    const primary = addDeclaration({
      id: `skill-${safeSegment(skill.name)}`,
      kind: "skill",
      path: skillTarget,
      parentId: null,
      mediaType: "text/markdown",
      visibility: "policy",
      portability: "portable",
    });
    for (const resource of skill.resourceFiles) {
      const resourceTarget = `skills/${safeSegment(skill.name)}/${resource.split(path.sep).join("/")}`;
      await copyRegularFile(
        path.join(packageRoot, resource),
        path.join(sourceDir, ...resourceTarget.split("/")),
      );
      addDeclaration({
        id: `skill-resource-${safeSegment(skill.name)}-${contentHash(resource).slice(0, 12)}`,
        kind: "skill_resource",
        path: resourceTarget,
        parentId: primary.id,
        mediaType: mediaTypeForPath(resourceTarget),
        visibility: "policy",
        portability: "portable",
      });
    }
  }

  for (const agent of profile.agents.filter((candidate) => candidate.enabled)) {
    const source = path.resolve(profileSource, agent.path);
    const relativeFiles = await sourceFilesForImport(source);
    if (relativeFiles.length === 0) throw new Error(`Profile Agent ${agent.id} has no source files.`);
    const primaryRelative = selectAgentPrimaryFile(relativeFiles);
    for (const relativeFile of relativeFiles) {
      const target = `agents/${safeSegment(agent.id)}/${relativeFile}`;
      const sourceFile = (await fs.stat(source)).isDirectory()
        ? path.join(source, ...relativeFile.split("/"))
        : source;
      await copyRegularFile(sourceFile, path.join(sourceDir, ...target.split("/")));
      addDeclaration({
        id: relativeFile === primaryRelative
          ? `agent-${safeSegment(agent.id)}`
          : `agent-asset-${safeSegment(agent.id)}-${contentHash(relativeFile).slice(0, 12)}`,
        kind: relativeFile === primaryRelative ? "agent" : "asset",
        path: target,
        parentId: null,
        mediaType: mediaTypeForPath(target),
        visibility: "policy",
        portability: "portable",
      });
    }
  }

  const dependency = await importedDependencyLock(profile);
  const dependencyTarget = `dependency-lock/${dependency.name}`;
  await fs.mkdir(path.join(sourceDir, "dependency-lock"), { recursive: true });
  if (dependency.sourcePath) {
    await copyRegularFile(dependency.sourcePath, path.join(sourceDir, ...dependencyTarget.split("/")));
  } else {
    await fs.writeFile(
      path.join(sourceDir, ...dependencyTarget.split("/")),
      canonicalJson(dependency.generated),
      { flag: "wx" },
    );
  }
  addDeclaration({
    id: "dependency-lock",
    kind: "dependency_lock",
    path: dependencyTarget,
    parentId: null,
    mediaType: mediaTypeForPath(dependencyTarget),
    visibility: "policy",
    portability: "portable",
  });

  await fs.writeFile(
    path.join(sourceDir, "program.json"),
    canonicalJson({ runtimeProtocol: "openpond.agent-runtime.v1" }),
    { flag: "wx" },
  );
  addDeclaration({
    id: "agent-runtime-program",
    kind: "program",
    path: "program.json",
    parentId: null,
    mediaType: "application/json",
    visibility: "policy",
    portability: "portable",
  });

  const manifest = HarnessSourceManifestSchema.parse({
    schemaVersion: "openpond.harnessSourceManifest.v1",
    name,
    files: declarations,
    // Profile actions remain at the temporary authoring edge. They must be
    // converted to explicit runtime tool declarations before Profile removal.
    toolDeclarations: [],
    capabilityRequirements: [],
    lifecycle: {
      create: true,
      reset: true,
      step: true,
      collect: true,
      destroy: true,
      resetScope: "attempt",
    },
    graderInterface: {
      visibleEvidence: ["output", "runtime_events", "artifacts"],
      privilegedEvidence: ["expected_output", "private_verifier"],
      privateVerifierIsolation: true,
    },
    runtimeProtocol: "openpond.agent-runtime.v1",
    metadata: {
      importedFrom: "openpond.profile",
      profileId: profile.activeProfile,
      profileGitHead: profile.git?.head ?? null,
      profileSourcePath: profile.sourcePath,
      excludedEvalCount: profile.evals.length,
      actionConversionPending: profile.actionCatalog.length > 0,
    },
  });
  await fs.writeFile(
    path.join(sourceDir, HARNESS_SOURCE_MANIFEST),
    canonicalJson(manifest),
    { flag: "wx" },
  );
  await ensureHarnessInstructionSurface(sourceDir, name);
}

async function ensureHarnessInstructionSurface(
  sourceDir: string,
  name: string,
): Promise<void> {
  const manifestPath = path.join(sourceDir, HARNESS_SOURCE_MANIFEST);
  const manifest = HarnessSourceManifestSchema.parse(
    JSON.parse(await fs.readFile(manifestPath, "utf8")),
  );
  if (manifest.files.some((file) => file.kind === "instruction")) return;
  const instructionTarget = "instructions/system.md";
  await fs.mkdir(path.join(sourceDir, "instructions"), { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, ...instructionTarget.split("/")),
    `# ${name}\n\nKeep reusable, provider-neutral execution guidance for this Harness here.\n`,
    { flag: "wx" },
  );
  const ids = new Set(manifest.files.map((file) => file.id));
  const id = ids.has("instruction-system")
    ? `instruction-system-${contentHash(instructionTarget).slice(0, 8)}`
    : "instruction-system";
  const normalized = HarnessSourceManifestSchema.parse({
    ...manifest,
    name,
    files: [
      ...manifest.files,
      {
        id,
        kind: "instruction",
        path: instructionTarget,
        parentId: null,
        mediaType: "text/markdown",
        visibility: "policy",
        portability: "portable",
      },
    ],
  });
  await fs.writeFile(manifestPath, canonicalJson(normalized), { flag: "w" });
}

async function importedDependencyLock(profile: OpenPondProfileState): Promise<
  | { name: string; sourcePath: string; generated?: never }
  | { name: string; sourcePath: null; generated: Record<string, unknown> }
> {
  const repoPath = profile.repoPath ? path.resolve(profile.repoPath) : null;
  if (repoPath) {
    for (const name of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
      const sourcePath = path.join(repoPath, name);
      const stats = await fs.lstat(sourcePath).catch(() => null);
      if (stats?.isFile() && !stats.isSymbolicLink()) return { name, sourcePath };
    }
  }
  return {
    name: "profile-import.json",
    sourcePath: null,
    generated: {
      source: "openpond.profile",
      profileId: profile.activeProfile,
      profileGitHead: profile.git?.head ?? null,
      dependenciesResolved: false,
    },
  };
}

async function sourceFilesForImport(source: string): Promise<string[]> {
  const stats = await fs.lstat(source);
  if (stats.isSymbolicLink()) throw new Error(`Profile source cannot be a symlink: ${source}`);
  if (stats.isFile()) return [path.basename(source)];
  if (!stats.isDirectory()) throw new Error(`Profile source is not a file or directory: ${source}`);
  return listRegularFiles(source);
}

function selectAgentPrimaryFile(files: string[]): string {
  for (const candidate of ["agent.ts", "index.ts", "agent/agent.ts", "agent.yaml", "agent.yml", "agent.json"]) {
    if (files.includes(candidate)) return candidate;
  }
  return files[0]!;
}

async function copyRegularFile(source: string, target: string): Promise<void> {
  const stats = await fs.lstat(source);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Harness import source must be a regular non-symlink file: ${source}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
}

function mediaTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if ([".md", ".txt"].includes(extension)) return extension === ".md" ? "text/markdown" : "text/plain";
  if ([".json"].includes(extension)) return "application/json";
  if ([".yaml", ".yml"].includes(extension)) return "application/yaml";
  if ([".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extension)) return "text/javascript";
  if (extension === ".py") return "text/x-python";
  return "application/octet-stream";
}

async function verifyMaterializedRelease(
  destination: string,
  compiled: CompiledLocalHarnessSource,
): Promise<void> {
  const snapshot = AgentSnapshotSchema.parse(
    JSON.parse(await fs.readFile(path.join(destination, "agent-snapshot.json"), "utf8")),
  );
  const release = HarnessReleaseSchema.parse(
    JSON.parse(await fs.readFile(path.join(destination, "harness-release.json"), "utf8")),
  );
  if (
    snapshot.contentHash !== compiled.agentSnapshot.contentHash ||
    release.contentHash !== compiled.harnessRelease.contentHash
  ) {
    throw new Error("Materialized Harness release does not match the compiled immutable objects.");
  }
  for (const file of compiled.sourceFiles) {
    const bytes = await fs.readFile(path.join(destination, "source", ...file.path.split("/")));
    if (sha256(bytes) !== file.asset.contentHash) {
      throw new Error(`Materialized Harness asset ${file.path} failed hash verification.`);
    }
  }
}

async function resolveContainedRegularFile(root: string, relativePath: string): Promise<string> {
  const candidate = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Harness source path escapes its root: ${relativePath}`);
  }
  const stats = await fs.lstat(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Harness source path must be a regular non-symlink file: ${relativePath}`);
  }
  const real = await fs.realpath(candidate);
  const realRelative = path.relative(await fs.realpath(root), real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Harness source path resolves outside its root: ${relativePath}`);
  }
  return candidate;
}

async function listRegularFiles(root: string, directory = root): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Harness source cannot contain symlinks: ${path.relative(root, absolute)}`);
    if (entry.isDirectory()) files.push(...(await listRegularFiles(root, absolute)));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error(`Harness source contains an unsupported entry: ${path.relative(root, absolute)}`);
  }
  return files.sort();
}

function safeSegment(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return result.slice(0, 48) || "harness";
}
