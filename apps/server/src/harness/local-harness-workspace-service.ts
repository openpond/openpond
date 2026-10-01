import {writeImportedProfileSource,ensureHarnessInstructionSurface,assertProfileWorkflowInputSchemas} from "./imported-profile-source.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
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
  ProfileWorkflowActionsSchema,
  sha256,
  validateProfileWorkflowCatalog,
  type AgentSnapshot,
  type HarnessRelease,
  type ImmutableAssetRef,
} from "@openpond/harness";
import { validateTaskSchema } from "@openpond/evals/task-schema";
import { listRegularFiles, resolveContainedRegularFile, safeSegment } from "./local-harness-workspace-files.js";

import type { HarnessStateStore } from "../store/harness-state-store.js";
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
  store: HarnessStateStore;
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
  store: HarnessStateStore;
  storeDir: string;
  id: string;
  ownerId: string;
  name: string;
  profile: OpenPondProfileState;
  sourceRevision?: string;
  repositoryId?: string;
  selectionEligible?: boolean;
  /** Trusted server materialization only; never accepted from a renderer request. */
  originOwnerScope?: HarnessWorkspace["ownerScope"];
  originMetadata?: HarnessWorkspace["metadata"];
  now?: () => string;
}): Promise<{ workspace: HarnessWorkspace; release: LocalHarnessReleaseRecord }> {
  if (input.profile.mode !== "local" || !input.profile.sourcePath) {
    throw new Error("Only a loaded local Profile with a source path can be imported.");
  }
  return createLocalHarnessWorkspaceFromInitializer({
    ...input,
    compilationWorkspaceId: input.repositoryId
      ? profileCompilationWorkspaceId(input.repositoryId, input.name) : input.id,
    initializeSource: (sourceDir) => writeImportedProfileSource(sourceDir, input.name, input.profile, input.sourceRevision, input.repositoryId),
  });
}

function profileCompilationWorkspaceId(repositoryId: string, name: string): string {
  return `profile-source-${contentHash([repositoryId, name]).slice(0, 24)}`;
}

/** Compile Profile source without changing workspace selection or durable
 * state. This also checks a restarted explicit binding against fresh bytes. */
export async function compileProfileHarnessSource(input: {
  storeDir: string;
  workspaceId: string;
  name: string;
  profile: OpenPondProfileState;
  sourceRevision?: string;
  repositoryId?: string;
}): Promise<CompiledLocalHarnessSource> {
  if (input.profile.mode !== "local" || !input.profile.sourcePath) {
    throw new Error("Only a loaded Profile source can be compiled.");
  }
  const root = path.join(input.storeDir, "library", "harnesses", "profile-previews");
  await fs.mkdir(root, { recursive: true });
  const sourceDir = path.join(root, randomUUID());
  try {
    await writeImportedProfileSource(sourceDir, input.name, input.profile, input.sourceRevision, input.repositoryId);
    // A discovery child and an owner's hosted child compile the same published
    // Profile in different workspaces. The immutable release must be identical
    // so the discovery binding can be admitted by that owner's workspace.
    const sourceWorkspaceId = input.repositoryId
      ? profileCompilationWorkspaceId(input.repositoryId, input.name) : input.workspaceId;
    return await compileLocalHarnessSource({ workspaceId: sourceWorkspaceId, sourceDir });
  } finally {
    await fs.rm(sourceDir, { recursive: true, force: true });
  }
}

/** Install a trusted, immutable source snapshot without exposing persistence internals. */
export async function importLocalHarnessWorkspaceSource(input: {
  store: HarnessStateStore; storeDir: string; sourceDir: string;
  id: string; ownerId: string; name: string;
}): Promise<void> {
  const compiled = await compileLocalHarnessSource({ workspaceId: input.id, sourceDir: input.sourceDir });
  const existing = await input.store.getHarnessWorkspace(input.id);
  if (existing) {
    const release = existing.currentChannel.release
      ? await input.store.getHarnessReleaseRecord(existing.currentChannel.release.contentHash)
      : null;
    if (existing.ownerScope.id !== input.ownerId || existing.sourceRevision !== compiled.sourceRevision ||
        release?.harnessRelease.contentHash !== compiled.harnessRelease.contentHash) {
      throw new Error("Configured Harness source changed; use a new workspace ID for the new release.");
    }
    return;
  }
  await createLocalHarnessWorkspaceFromInitializer({
    ...input,
    initializeSource: async sourceDir => {
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, HARNESS_SOURCE_MANIFEST), canonicalJson(compiled.manifest));
      for (const file of compiled.sourceFiles) {
        const destination = path.join(sourceDir, file.path);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, file.bytes);
      }
    },
  });
}

export async function forkLocalHarnessWorkspaceFromRelease(input: {
  store: HarnessStateStore;
  storeDir: string;
  id: string;
  ownerId: string;
  name: string;
  sourceRelease: { id: string; contentHash: string };
  /** Trusted candidate authoring only; candidate workspaces cannot become the selected live owner. */
  selectionEligible?: boolean;
  originMetadata?: HarnessWorkspace["metadata"];
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
  store: HarnessStateStore;
  storeDir: string;
  id: string;
  ownerId: string;
  name: string;
  initializeSource: (sourceDir: string) => Promise<void>;
  compilationWorkspaceId?: string;
  selectionEligible?: boolean;
  /** Trusted server materialization only; never accepted from a renderer request. */
  originOwnerScope?: HarnessWorkspace["ownerScope"];
  originMetadata?: HarnessWorkspace["metadata"];
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
      workspaceId: input.compilationWorkspaceId ?? input.id,
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
      ownerScope: input.originOwnerScope ?? { kind: "personal", id: input.ownerId },
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
      metadata: {
        ...input.originMetadata,
        sourceLayout: "openpond.harnessSourceManifest.v1",
        ...(input.selectionEligible === false ? { selectionEligible: false } : {}),
      },
    });
    return await input.store.createHarnessWorkspaceWithRelease({ workspace, release });
  } catch (error) {
    await fs.rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function compileAndRegisterLocalHarnessRelease(input: {
  store: HarnessStateStore;
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
  const workflowFile = sourceFiles.find(({ path: filePath }) => filePath === "workflows/catalog.json");
  if (workflowFile) {
    const declaration = manifest.files.find((file) => file.path === workflowFile.path);
    if (declaration?.kind !== "workflow" || declaration.visibility !== "policy") {
      throw new Error("Profile workflow catalog requires a policy-visible workflow declaration.");
    }
    const actionsFile = sourceFiles.find(({ path: filePath }) => filePath === "workflows/actions.json");
    const actionsDeclaration = manifest.files.find((file) => file.path === "workflows/actions.json");
    if (!actionsFile || actionsDeclaration?.visibility !== "policy") {
      throw new Error("Profile workflow catalog requires a released action inventory.");
    }
    const actions = ProfileWorkflowActionsSchema.parse(JSON.parse(new TextDecoder().decode(actionsFile.bytes))).actions;
    const actionIds = new Set<string>();
    for (const action of actions) {
      if (actionIds.has(action.id)) throw new Error(`Duplicate Profile workflow action ${action.id}.`);
      actionIds.add(action.id);
      if (!validateTaskSchema(action.inputSchema).valid) {
        throw new Error(`Profile workflow action ${action.id} has an invalid input schema.`);
      }
      if (!manifest.files.some((file) => file.path.startsWith(`agents/${action.agentId}/`))) {
        throw new Error(`Profile workflow action ${action.id} lacks its Agent source.`);
      }
    }
    const catalog = validateProfileWorkflowCatalog({
      catalog: JSON.parse(new TextDecoder().decode(workflowFile.bytes)),
      sourcePaths: new Set(manifest.files.filter((file) => file.kind === "skill").map((file) => file.path)),
      actionIds,
    });
    assertProfileWorkflowInputSchemas(catalog);
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
      ...(manifest.metadata.importedFrom === "openpond.profile" ? {
        profile: {
          id: manifest.metadata.profileId,
          sourceRevision: manifest.metadata.profileGitHead ?? sourceRevision,
          ...(manifest.metadata.profileRepositoryId
            ? { repositoryId: manifest.metadata.profileRepositoryId } : {}),
        },
      } : {}),
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
