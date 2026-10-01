import {promises as fs} from "node:fs";
import path from "node:path";
import {HarnessSourceManifestSchema,type HarnessSourceManifest,type OpenPondProfileState} from "@openpond/contracts";
import {canonicalJson,contentHash,compileProfileWorkflowPackages,validateProfileWorkflowCatalog} from "@openpond/harness";
import {validateTaskSchema} from "@openpond/evals/task-schema";
import {ProfileEvaluationDefinitionSchema,ProfileEvaluationSuiteSchema,validateProfileEvaluationCatalog} from "@openpond/evals";
import {validateTasksetPackage} from "openpond-sdk/taskset-packages";
import {createProfileSourceBindings,isProfilePrivateEvaluationPath} from "./profile-source-bindings.js";
import {listRegularFiles,mediaTypeForPath,resolveContainedRegularFile,safeSegment,selectAgentPrimaryFile,sourceFilesForImport} from "./local-harness-workspace-files.js";
import {inspectReleasedProfileActionDependencies} from "./released-profile-action-dependencies.js";
const HARNESS_SOURCE_MANIFEST="harness.json";

export async function writeImportedProfileSource(
  sourceDir: string,
  name: string,
  profile: OpenPondProfileState,
  sourceRevision?: string,
  repositoryId?: string,
): Promise<void> {
  const profileSource = path.resolve(profile.sourcePath!);
  const declarations: HarnessSourceManifest["files"] = [];
  const sourceBindings=createProfileSourceBindings(profileSource,sourceDir),copyProfileFile=sourceBindings.copy;
  const privateEvaluationPaths = new Set((await listRegularFiles(profileSource)).filter(isProfilePrivateEvaluationPath));

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
  const originalInstructions=path.join(profileSource,"instructions","system.md"),instructionStat=await fs.lstat(originalInstructions).catch(error=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;});
  if(instructionStat){if(!instructionStat.isFile()||instructionStat.isSymbolicLink())throw new Error("Profile instructions require an actual regular source file.");await copyProfileFile(originalInstructions,path.join(sourceDir,"instructions","system.md"));addDeclaration({id:"instruction-system",kind:"instruction",path:"instructions/system.md",parentId:null,mediaType:"text/markdown",visibility:"policy",portability:"portable"});}

  for (const skill of profile.skills.filter((candidate) => candidate.enabled)) {
    if (skill.validationStatus !== "valid") {
      throw new Error(`Cannot import invalid Profile Skill ${skill.name}: ${skill.validationMessages.join(" ")}`);
    }
    const packageRoot = path.dirname(path.join(profileSource, skill.path));
    const skillTarget = `skills/${safeSegment(skill.name)}/SKILL.md`;
    await copyProfileFile(path.join(packageRoot, "SKILL.md"), path.join(sourceDir, ...skillTarget.split("/")));
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
      await copyProfileFile(
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
    const sourceReal = await fs.realpath(source), profileReal = await fs.realpath(profileSource);
    const sourceRelative = path.relative(profileReal, sourceReal);
    if (sourceRelative.startsWith("..") || path.isAbsolute(sourceRelative)) throw new Error("Profile Agent source escapes its admitted Profile root.");
    const sourceStats = await fs.lstat(source);
    const relativeFiles = (await sourceFilesForImport(source)).filter(relativeFile => {
      const absolute = sourceStats.isDirectory() ? path.join(sourceReal, ...relativeFile.split("/")) : sourceReal;
      return !privateEvaluationPaths.has(path.relative(profileReal, absolute).split(path.sep).join("/"));
    });
    if (relativeFiles.length === 0) throw new Error(`Profile Agent ${agent.id} has no source files.`);
    const primaryRelative = selectAgentPrimaryFile(relativeFiles);
    for (const relativeFile of relativeFiles) {
      const target = `agents/${safeSegment(agent.id)}/${relativeFile}`;
      const sourceFile = (await fs.stat(source)).isDirectory()
        ? path.join(source, ...relativeFile.split("/"))
        : source;
      await copyProfileFile(sourceFile, path.join(sourceDir, ...target.split("/")));
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
    await inspectReleasedProfileActionDependencies(path.join(sourceDir, "agents", safeSegment(agent.id)));
  }

  const workflowIds = new Set<string>();
  const enabledAgentIds = new Set(profile.agents.filter((agent) => agent.enabled).map((agent) => agent.id));
  const workflowActions = profile.actionCatalog
    .filter((action) => action.agentId && enabledAgentIds.has(action.agentId))
    .map((action) => ({ id: action.id, agentId: safeSegment(action.agentId!),
      sourceActionId: action.sourceActionId ?? action.id,
      inputSchema: typeof action.inputSchema === "object" && action.inputSchema !== null
        ? action.inputSchema : { type: "object", additionalProperties: true } }));
  const actionIds = new Set(workflowActions.map((action) => action.id));
  const workflowCatalogPath = path.join(profileSource, "workflows", "catalog.json");
  const workflowCatalogStat = await fs.lstat(workflowCatalogPath).catch(() => null);
  const workflowSourcePaths = (await listRegularFiles(profileSource)).filter((file) => file.startsWith("workflows/"));
  const hasWorkflowPackages = workflowSourcePaths.some((file) => /^workflows\/[^/]+\/(PROMPT\.md|ACTION\.json)$/.test(file));
  if (hasWorkflowPackages && workflowCatalogStat) {
    throw new Error("Authored Workflow packages and legacy workflows/catalog.json cannot coexist; migrate the catalog first.");
  }
  if (workflowCatalogStat || hasWorkflowPackages || workflowActions.length) {
    if (workflowCatalogStat && (!workflowCatalogStat.isFile() || workflowCatalogStat.isSymbolicLink())) {
      throw new Error("Profile workflow catalog must be a regular file.");
    }
    const packages = hasWorkflowPackages
      ? compileProfileWorkflowPackages({
          files: new Map(await Promise.all(workflowSourcePaths.map(async (file) => [
            file, await fs.readFile(await resolveContainedRegularFile(profileSource, file), "utf8"),
          ] as const))),
          skillPaths: new Set(declarations.filter((file) => file.kind === "skill").map((file) => file.path)),
          actionIds,
        })
      : null;
    const catalogBytes = packages
      ? Buffer.from(canonicalJson(packages.catalog))
      : workflowCatalogStat
        ? await fs.readFile(workflowCatalogPath)
        : Buffer.from(canonicalJson({ schemaVersion: "openpond.profileWorkflows.v1", workflows: [] }));
    if(workflowCatalogStat)sourceBindings.add("workflows/catalog.json","workflows/catalog.json");
    const catalog = validateProfileWorkflowCatalog({
      catalog: JSON.parse(catalogBytes.toString("utf8")),
      sourcePaths: new Set(declarations.filter((file) => file.kind === "skill").map((file) => file.path)),
      actionIds: new Set(workflowActions.map((action) => action.id)),
    });
    for (const workflow of catalog.workflows) workflowIds.add(workflow.id);
    assertProfileWorkflowInputSchemas(catalog);
    const target = "workflows/catalog.json";
    await fs.mkdir(path.join(sourceDir, "workflows"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "workflows", "catalog.json"), catalogBytes, { flag: "wx" });
    for (const file of packages?.referencedPaths ?? []) {
      await copyProfileFile(path.join(profileSource, ...file.split("/")), path.join(sourceDir, ...file.split("/")));
      addDeclaration({
        id: `profile-workflow-source-${contentHash(file).slice(0, 16)}`,
        kind: "asset", path: file, parentId: null, mediaType: mediaTypeForPath(file),
        visibility: "policy", portability: "portable",
      });
    }
    addDeclaration({
      id: "profile-workflows",
      kind: "workflow",
      path: target,
      parentId: null,
      mediaType: "application/json",
      visibility: "policy",
      portability: "portable",
    });
  }
  if (workflowCatalogStat || hasWorkflowPackages || workflowActions.length) {
    await fs.writeFile(path.join(sourceDir, "workflows", "actions.json"), canonicalJson({
      schemaVersion: "openpond.profileWorkflowActions.v1",
      actions: workflowActions,
    }), { flag: "wx" });
    addDeclaration({
      id: "profile-workflow-actions",
      kind: "asset",
      path: "workflows/actions.json",
      parentId: null,
      mediaType: "application/json",
      visibility: "policy",
      portability: "portable",
    });
  }

  const evaluationCatalogPath = path.join(profileSource, "evals", "catalog.json");
  const evaluationCatalogStat = await fs.lstat(evaluationCatalogPath).catch(() => null);
  const evaluationSourcePaths = (await listRegularFiles(profileSource)).filter((file) =>
    /^workflows\/[^/]+\/evals\/[^/]+\.json$/.test(file)
    || /^evals\/(definitions|suites)\/[^/]+\.json$/.test(file));
  if (evaluationCatalogStat && evaluationSourcePaths.length) {
    throw new Error("Authored evaluation definitions and legacy evals/catalog.json cannot coexist; migrate the catalog first.");
  }
  if (evaluationCatalogStat || evaluationSourcePaths.length) {
    if (evaluationCatalogStat && (!evaluationCatalogStat.isFile() || evaluationCatalogStat.isSymbolicLink())) {
      throw new Error("Profile evaluation catalog must be a regular file.");
    }
    const authoredDefinitions = [];
    const authoredSuites = [];
    for (const file of evaluationSourcePaths) {
      const value = JSON.parse(await fs.readFile(await resolveContainedRegularFile(profileSource, file), "utf8"));
      if (file.startsWith("evals/suites/")) {
        authoredSuites.push(ProfileEvaluationSuiteSchema.parse(value));
      } else {
        const definition = ProfileEvaluationDefinitionSchema.parse(value);
        const owner = /^workflows\/([^/]+)\/evals\//.exec(file)?.[1];
        if (owner && (definition.target.kind !== "workflow" || definition.target.workflowId !== owner)) {
          throw new Error(`Profile evaluation ${definition.id} must target its containing Workflow ${owner}.`);
        }
        authoredDefinitions.push(definition);
      }
    }
    const evaluationBytes = evaluationSourcePaths.length
      ? Buffer.from(canonicalJson({ schemaVersion: "openpond.profileEvaluations.v1", definitions: authoredDefinitions.sort((a, b) => a.id.localeCompare(b.id)), suites: authoredSuites.sort((a, b) => a.id.localeCompare(b.id)) }))
      : await fs.readFile(evaluationCatalogPath);
    const { catalog } = validateProfileEvaluationCatalog({
      catalog: JSON.parse(evaluationBytes.toString("utf8")),
      workflowIds,
      skillPaths: new Set(declarations.filter((file) => file.kind === "skill").map((file) => file.path)),
      actionIds,
    });
    await fs.mkdir(path.join(sourceDir, "evals"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "evals", "catalog.json"), evaluationBytes, { flag: "wx" });
    for (const file of evaluationSourcePaths) {
      await copyProfileFile(path.join(profileSource, ...file.split("/")), path.join(sourceDir, ...file.split("/")));
      addDeclaration({
        id: `profile-evaluation-source-${contentHash(file).slice(0, 16)}`,
        kind: "asset", path: file, parentId: null, mediaType: "application/json",
        visibility: "verifier", portability: "portable",
      });
    }
    addDeclaration({
      id: "profile-evaluations",
      kind: "asset",
      path: "evals/catalog.json",
      parentId: null,
      mediaType: "application/json",
      visibility: "verifier",
      portability: "portable",
    });
    const packageHashes = new Set(catalog.definitions.map((definition) => definition.tasksetRelease.contentHash));
    const packageSourceDir = path.join(profileSource, "evals", "tasksets");
    const packageDirStat = await fs.lstat(packageSourceDir).catch(() => null);
    if (packageDirStat && (!packageDirStat.isDirectory() || packageDirStat.isSymbolicLink())) {
      throw new Error("Profile evaluation Taskset directory must be a regular directory.");
    }
    for (const packageHash of packageHashes) {
      const packagePath = path.join(packageSourceDir, `${packageHash}.json`);
      const packageStat = await fs.lstat(packagePath).catch(() => null);
      if (!packageStat) throw new Error(`Profile evaluation Taskset package ${packageHash} is missing.`);
      if (!packageStat.isFile() || packageStat.isSymbolicLink()) {
        throw new Error("Profile evaluation Taskset package must be a regular file.");
      }
      const packageValue = validateTasksetPackage(JSON.parse(await fs.readFile(packagePath, "utf8")));
      if (packageValue.taskset.contentHash !== packageHash
        || !catalog.definitions.some((definition) =>
          definition.tasksetRelease.contentHash === packageHash
          && definition.tasksetRelease.id === packageValue.taskset.id)) {
        throw new Error("Profile evaluation Taskset package differs from its catalog reference.");
      }
      const target = `evals/tasksets/${packageHash}.json`;
      await copyProfileFile(packagePath, path.join(sourceDir, ...target.split("/")));
      addDeclaration({
        id: `profile-evaluation-taskset-${packageHash.slice(0, 16)}`,
        kind: "asset",
        path: target,
        parentId: null,
        mediaType: "application/json",
        visibility: "verifier",
        portability: "portable",
      });
    }
  }

  const dependency = await importedDependencyLock(profile, sourceRevision);
  const dependencyTarget = `dependency-lock/${dependency.name}`;
  await fs.mkdir(path.join(sourceDir, "dependency-lock"), { recursive: true });
  if (dependency.sourcePath) {
    await copyProfileFile(dependency.sourcePath, path.join(sourceDir, ...dependencyTarget.split("/")));
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
      ...(repositoryId ? { profileRepositoryId: repositoryId } : {}),
      profileGitHead: sourceRevision ?? profile.git?.head ?? null,
      profileSourceBindings: sourceBindings.policy(declarations),
      profileInstructionSourcePath:"instructions/system.md",
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

export function assertProfileWorkflowInputSchemas(catalog: import("@openpond/harness").ProfileWorkflowCatalog): void {
  for (const workflow of catalog.workflows) {
    const result = validateTaskSchema(workflow.inputSchema);
    if (!result.valid) {
      throw new Error(`Profile workflow ${workflow.id} has an invalid input schema: ${result.issues[0]?.message ?? "schema mismatch"}`);
    }
  }
}

export async function ensureHarnessInstructionSurface(
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

async function importedDependencyLock(profile: OpenPondProfileState, sourceRevision?: string): Promise<
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
      profileGitHead: sourceRevision ?? profile.git?.head ?? null,
      dependenciesResolved: false,
    },
  };
}
