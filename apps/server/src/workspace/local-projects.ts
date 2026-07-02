import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CreateLocalProjectRequestSchema,
  LocalProjectSchema,
  OPENPOND_MANIFEST_FILE_NAME,
  UpdateLocalProjectAgentSetupRequestSchema,
  validateSandboxTemplateYaml,
  type CreateLocalProjectRequest,
  type LocalProject,
  type LocalProjectSandboxTemplate,
  type OpenPondApp,
} from "@openpond/contracts";
import type { SqliteStore } from "../store/store.js";
import { now } from "../utils.js";
import { detectProjectAgentSdk } from "./project-agent-sdk.js";
import { normalizeProjectDirectory } from "./project-directories.js";
import { runWorkspaceCommand, type WorkspacePaths } from "./workspaces.js";

const LOCAL_PROJECTS_CACHE_TYPE = "local.projects";
const LOCAL_PROJECTS_CACHE_KEY = "v1";
const SYSTEM_LOCAL_PROJECT_SOURCE = "folder" as const;
const SANDBOX_TEMPLATE_SCAN_DEPTH = 2;
const SANDBOX_TEMPLATE_MANIFEST_NAME = OPENPOND_MANIFEST_FILE_NAME;
const IGNORED_PACKAGE_SCAN_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const LocalProjectListSchema = z.array(LocalProjectSchema);

function localProjectId(workspacePath: string): string {
  return `local_${createHash("sha256").update(workspacePath).digest("hex").slice(0, 20)}`;
}

function defaultProjectName(workspacePath: string): string {
  return path.basename(workspacePath) || "Local project";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function detectSandboxTemplateAt(rootPath: string): Promise<LocalProjectSandboxTemplate | null> {
  const manifestPath = path.join(rootPath, SANDBOX_TEMPLATE_MANIFEST_NAME);
  if (!(await fileExists(manifestPath))) return null;
  const manifestContent = await fs.readFile(manifestPath, "utf8");
  const validation = validateSandboxTemplateYaml(manifestContent);
  return {
    detected: true,
    rootPath,
    manifestPath,
    manifestHash: createHash("sha256").update(manifestContent).digest("hex"),
    manifest: validation.ok ? validation.manifest : null,
    normalizedManifest: validation.ok ? validation.manifest : null,
    valid: validation.ok,
    diagnostics: validation.diagnostics,
  };
}

function addCandidate(candidates: string[], seen: Set<string>, candidate: string) {
  if (seen.has(candidate)) return;
  seen.add(candidate);
  candidates.push(candidate);
}

async function collectSandboxTemplateCandidates(
  basePath: string,
  candidates: string[],
  seen: Set<string>,
  depth: number
): Promise<void> {
  if (depth <= 0 || !(await directoryExists(basePath))) return;
  if (await fileExists(path.join(basePath, SANDBOX_TEMPLATE_MANIFEST_NAME))) {
    addCandidate(candidates, seen, basePath);
  }
  const entries = await fs.readdir(basePath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || IGNORED_PACKAGE_SCAN_DIRS.has(entry.name)) continue;
    await collectSandboxTemplateCandidates(path.join(basePath, entry.name), candidates, seen, depth - 1);
  }
}

async function detectLocalProjectSandboxTemplate(input: {
  selectedPath: string;
  workspacePath: string;
}): Promise<LocalProjectSandboxTemplate | null> {
  const candidates: string[] = [];
  const seen = new Set<string>();
  addCandidate(candidates, seen, input.selectedPath);
  addCandidate(candidates, seen, input.workspacePath);
  await collectSandboxTemplateCandidates(
    input.selectedPath,
    candidates,
    seen,
    SANDBOX_TEMPLATE_SCAN_DEPTH,
  );
  if (input.workspacePath !== input.selectedPath) {
    await collectSandboxTemplateCandidates(
      input.workspacePath,
      candidates,
      seen,
      SANDBOX_TEMPLATE_SCAN_DEPTH,
    );
  }
  for (const candidate of candidates) {
    const detected = await detectSandboxTemplateAt(candidate);
    if (detected) return detected;
  }
  return null;
}

async function detectLocalProjectCapabilities(input: {
  selectedPath: string;
  workspacePath: string;
}): Promise<{
  sandboxTemplate: LocalProjectSandboxTemplate | null;
  agentSdk: LocalProject["agentSdk"] | null;
}> {
  const [sandboxTemplate, agentSdk] = await Promise.all([
    detectLocalProjectSandboxTemplate(input),
    detectProjectAgentSdk(input),
  ]);
  return {
    sandboxTemplate,
    agentSdk,
  };
}

async function resolveProjectPath(
  inputPath: string,
  options: { detectGitRoot: boolean }
): Promise<{
  selectedPath: string;
  workspacePath: string;
  repoPath: string | null;
  source: LocalProject["source"];
}> {
  const absolutePath = path.resolve(inputPath);
  let realInputPath: string;
  try {
    realInputPath = await fs.realpath(absolutePath);
  } catch (error) {
    throw new Error(`Project folder was not found: ${absolutePath}`);
  }

  const stat = await fs.stat(realInputPath);
  if (!stat.isDirectory()) throw new Error("Project path must be a folder.");

  if (!options.detectGitRoot) {
    return {
      selectedPath: realInputPath,
      workspacePath: realInputPath,
      repoPath: null,
      source: "folder",
    };
  }

  const result = await runWorkspaceCommand("git", ["rev-parse", "--show-toplevel"], realInputPath);
  const repoRoot = result.stdout.trim();
  if (result.code === 0 && repoRoot) {
    const realRepoPath = await fs.realpath(path.resolve(repoRoot));
    return {
      selectedPath: realInputPath,
      workspacePath: realInputPath,
      repoPath: realRepoPath,
      source: "git",
    };
  }

  return {
    selectedPath: realInputPath,
    workspacePath: realInputPath,
    repoPath: null,
    source: "folder",
  };
}

function projectFolderName(projectName: string): string {
  const cleaned = projectName
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 80)
    .trim();
  return cleaned || "New project";
}

async function createNewProjectPath(input: CreateLocalProjectRequest, defaultNewProjectDirectory?: string | null): Promise<string> {
  if (!input.name?.trim()) throw new Error("Project name is required.");
  const baseDirectory = normalizeProjectDirectory(input.baseDirectory ?? defaultNewProjectDirectory);
  await fs.mkdir(baseDirectory, { recursive: true });
  const baseStat = await fs.stat(baseDirectory);
  if (!baseStat.isDirectory()) throw new Error(`Default project directory is not a folder: ${baseDirectory}`);

  const baseName = projectFolderName(input.name);
  for (let index = 1; index <= 1000; index += 1) {
    const suffix = index === 1 ? "" : ` ${index}`;
    const candidateName = `${baseName.slice(0, 120 - suffix.length)}${suffix}`;
    const candidatePath = path.join(baseDirectory, candidateName);
    try {
      await fs.mkdir(candidatePath);
      await initializeNewProjectGit(candidatePath);
      return candidatePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not create a unique project folder in ${baseDirectory}.`);
}

async function initializeNewProjectGit(projectPath: string): Promise<void> {
  let init = await runWorkspaceCommand("git", ["init", "-b", "master"], projectPath);
  if (init.code === 0) return;
  init = await runWorkspaceCommand("git", ["init"], projectPath);
  if (init.code !== 0) {
    throw new Error(init.stderr.trim() || init.stdout.trim() || "git init failed");
  }
  const rename = await runWorkspaceCommand("git", ["branch", "-M", "master"], projectPath);
  if (rename.code !== 0) {
    throw new Error(rename.stderr.trim() || rename.stdout.trim() || "git branch setup failed");
  }
}

function sortLocalProjects(projects: LocalProject[]): LocalProject[] {
  return [...projects].sort((left, right) => {
    const leftUpdated = new Date(left.updatedAt).getTime();
    const rightUpdated = new Date(right.updatedAt).getTime();
    if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;
    return left.name.localeCompare(right.name);
  });
}

function normalizeGitHost(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return trimmed.toLowerCase().replace(/^www\./, "");
  }
}

function normalizeGitRepo(value?: string | null): string | null {
  const trimmed = value?.trim().replace(/\.git$/i, "");
  return trimmed ? trimmed.toLowerCase() : null;
}

function openPondAppRemoteKey(app: OpenPondApp): string | null {
  const host = normalizeGitHost(app.gitHost);
  const owner = app.gitOwner?.trim().toLowerCase();
  const repo = normalizeGitRepo(app.gitRepo);
  return host && owner && repo ? `${host}/${owner}/${repo}` : null;
}

function remoteUrlKey(remoteUrl: string): string | null {
  const sshMatch = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i.exec(remoteUrl.trim());
  if (sshMatch) {
    const host = normalizeGitHost(sshMatch[1]);
    const owner = sshMatch[2]?.trim().toLowerCase();
    const repo = normalizeGitRepo(sshMatch[3]);
    return host && owner && repo ? `${host}/${owner}/${repo}` : null;
  }
  try {
    const parsed = new URL(remoteUrl);
    const [owner, repo] = parsed.pathname.replace(/^\/+/, "").split("/");
    const host = normalizeGitHost(parsed.hostname);
    const normalizedRepo = normalizeGitRepo(repo);
    return host && owner && normalizedRepo ? `${host}/${owner.toLowerCase()}/${normalizedRepo}` : null;
  } catch {
    return null;
  }
}

async function readOriginRemote(repoPath: string | null): Promise<string | null> {
  if (!repoPath) return null;
  const result = await runWorkspaceCommand("git", ["remote", "get-url", "origin"], repoPath);
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

export async function inferLocalProjectOpenPondLinks(
  projects: LocalProject[],
  apps: OpenPondApp[],
): Promise<LocalProject[]> {
  const appsByRemote = new Map<string, OpenPondApp>();
  const appIds = new Set(apps.map((app) => app.id));
  for (const app of apps) {
    const key = openPondAppRemoteKey(app);
    if (key) appsByRemote.set(key, app);
  }
  if (appsByRemote.size === 0) return projects;

  return Promise.all(
    projects.map(async (project) => {
      if (project.linkedOpenPondApp?.appId && appIds.has(project.linkedOpenPondApp.appId)) {
        return project;
      }
      const remoteUrl = await readOriginRemote(project.repoPath ?? project.workspacePath);
      const app = remoteUrl ? appsByRemote.get(remoteUrlKey(remoteUrl) ?? "") : null;
      if (!app) return project;
      return {
        ...project,
        linkedOpenPondApp: {
          appId: app.id,
          appName: app.name,
          gitOwner: app.gitOwner ?? null,
          gitRepo: app.gitRepo ?? null,
          gitHost: app.gitHost ?? null,
          defaultBranch: app.defaultBranch ?? null,
          linkedAt: project.linkedOpenPondApp?.linkedAt ?? project.updatedAt,
        },
      };
    }),
  );
}

async function saveLocalProjects(store: SqliteStore, projects: LocalProject[]): Promise<void> {
  await store.setCacheEntry(LOCAL_PROJECTS_CACHE_TYPE, LOCAL_PROJECTS_CACHE_KEY, sortLocalProjects(projects));
}

export async function listLocalProjects(store: SqliteStore): Promise<LocalProject[]> {
  const entry = await store.getCacheEntry<unknown>(LOCAL_PROJECTS_CACHE_TYPE, LOCAL_PROJECTS_CACHE_KEY);
  const parsed = LocalProjectListSchema.safeParse(entry?.payload);
  if (!parsed.success) return [];
  return sortLocalProjects(
    await Promise.all(
      parsed.data.map(async (project) => {
        const capabilities = await detectLocalProjectCapabilities({
          selectedPath: project.path,
          workspacePath: project.workspacePath,
        });
        return {
          ...project,
          sandboxTemplate: capabilities.sandboxTemplate,
          agentSdk: capabilities.agentSdk,
        };
      })
    )
  );
}

export async function ensureSystemLocalProject(
  store: SqliteStore,
  input: {
    id: string;
    name: string;
    workspacePath: string;
    systemKind: NonNullable<LocalProject["systemKind"]>;
    hiddenFromDefaultSidebar?: boolean;
  },
): Promise<LocalProject> {
  await fs.mkdir(input.workspacePath, { recursive: true });
  const projects = await listLocalProjects(store);
  const existing = projects.find((project) => project.id === input.id || project.systemKind === input.systemKind);
  const timestamp = now();
  const project: LocalProject = {
    id: existing?.id ?? input.id,
    name: existing?.name || input.name,
    path: input.workspacePath,
    workspacePath: input.workspacePath,
    repoPath: null,
    source: SYSTEM_LOCAL_PROJECT_SOURCE,
    systemKind: input.systemKind,
    hiddenFromDefaultSidebar: existing?.hiddenFromDefaultSidebar ?? input.hiddenFromDefaultSidebar ?? true,
    sandboxTemplate: null,
    agentSdk: null,
    linkedOpenPondApp: null,
    linkedSandboxProject: null,
    preferredSandboxAgentId: null,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: existing?.updatedAt ?? timestamp,
  };
  const unchanged =
    existing &&
    existing.path === project.path &&
    existing.workspacePath === project.workspacePath &&
    existing.systemKind === project.systemKind &&
    existing.hiddenFromDefaultSidebar === project.hiddenFromDefaultSidebar;
  if (!unchanged) {
    await saveLocalProjects(store, [project, ...projects.filter((candidate) => candidate.id !== project.id)]);
  }
  return unchanged ? existing : project;
}

export async function upsertLocalProject(
  store: SqliteStore,
  payload: unknown,
  options: { defaultNewProjectDirectory?: string | null } = {}
): Promise<{ project: LocalProject; created: boolean }> {
  const input: CreateLocalProjectRequest = CreateLocalProjectRequestSchema.parse(payload);
  const createdProjectPath = input.createNew
    ? await createNewProjectPath(input, options.defaultNewProjectDirectory)
    : null;
  const selectedPath = createdProjectPath ?? input.path;
  if (!selectedPath) throw new Error("Project path is required.");
  const resolved = await resolveProjectPath(selectedPath, { detectGitRoot: true });
  const { sandboxTemplate, agentSdk } = await detectLocalProjectCapabilities(resolved);
  const projects = await listLocalProjects(store);
  const existing = projects.find((project) => project.workspacePath === resolved.workspacePath);
  const timestamp = now();
  const project: LocalProject = {
    id: existing?.id ?? localProjectId(resolved.workspacePath),
    name: input.name?.trim() || existing?.name || defaultProjectName(resolved.workspacePath),
    path: resolved.selectedPath,
    workspacePath: resolved.workspacePath,
    repoPath: resolved.repoPath,
    source: resolved.source,
    sandboxTemplate,
    agentSdk,
    linkedOpenPondApp: existing?.linkedOpenPondApp ?? null,
    linkedSandboxProject: existing?.linkedSandboxProject ?? null,
    preferredSandboxAgentId: existing?.preferredSandboxAgentId ?? null,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  await saveLocalProjects(store, [project, ...projects.filter((candidate) => candidate.id !== project.id)]);
  return { project, created: !existing };
}

export async function findLocalProject(store: SqliteStore, projectId: string): Promise<LocalProject | null> {
  return (await listLocalProjects(store)).find((project) => project.id === projectId) ?? null;
}

export async function refreshLocalProjectGitMetadata(store: SqliteStore, projectId: string): Promise<LocalProject> {
  const projects = await listLocalProjects(store);
  const existing = projects.find((project) => project.id === projectId);
  if (!existing) throw new Error("Project workspace not found");
  const resolved = await resolveProjectPath(existing.path, { detectGitRoot: true });
  const capabilities = await detectLocalProjectCapabilities(resolved);
  const updated: LocalProject = {
    ...existing,
    path: resolved.selectedPath,
    workspacePath: resolved.workspacePath,
    repoPath: resolved.repoPath,
    source: resolved.source,
    sandboxTemplate: capabilities.sandboxTemplate,
    agentSdk: capabilities.agentSdk,
    updatedAt: now(),
  };
  await saveLocalProjects(store, [updated, ...projects.filter((project) => project.id !== projectId)]);
  return updated;
}

export async function updateLocalProjectAgentSetup(
  store: SqliteStore,
  projectId: string,
  payload: unknown,
): Promise<LocalProject> {
  const input = UpdateLocalProjectAgentSetupRequestSchema.parse(payload);
  const projects = await listLocalProjects(store);
  const existing = projects.find((project) => project.id === projectId);
  if (!existing) throw new Error("Project workspace not found");
  const updated: LocalProject = {
    ...existing,
    ...(Object.hasOwn(input, "linkedSandboxProject")
      ? { linkedSandboxProject: input.linkedSandboxProject ?? null }
      : {}),
    ...(Object.hasOwn(input, "preferredSandboxAgentId")
      ? { preferredSandboxAgentId: input.preferredSandboxAgentId ?? null }
      : {}),
    ...(Object.hasOwn(input, "hiddenFromDefaultSidebar")
      ? { hiddenFromDefaultSidebar: input.hiddenFromDefaultSidebar ?? false }
      : {}),
    updatedAt: now(),
  };
  await saveLocalProjects(store, [updated, ...projects.filter((project) => project.id !== projectId)]);
  return updated;
}

export async function deleteLocalProject(store: SqliteStore, projectId: string): Promise<void> {
  const projects = await listLocalProjects(store);
  await saveLocalProjects(store, projects.filter((project) => project.id !== projectId));
}

export async function linkLocalProjectOpenPondApp(
  store: SqliteStore,
  projectId: string,
  app: OpenPondApp,
  options: { repoPath?: string | null } = {}
): Promise<LocalProject> {
  const projects = await listLocalProjects(store);
  const existing = projects.find((project) => project.id === projectId);
  if (!existing) throw new Error("Project workspace not found");
  const timestamp = now();
  const repoPath = options.repoPath ?? existing.repoPath ?? existing.workspacePath;
  const updated: LocalProject = {
    ...existing,
    repoPath,
    source: "git",
    linkedOpenPondApp: {
      appId: app.id,
      appName: app.name,
      gitOwner: app.gitOwner ?? null,
      gitRepo: app.gitRepo ?? null,
      gitHost: app.gitHost ?? null,
      defaultBranch: app.defaultBranch ?? null,
      linkedAt: timestamp,
    },
    updatedAt: timestamp,
  };
  await saveLocalProjects(store, [updated, ...projects.filter((project) => project.id !== projectId)]);
  return updated;
}

export function localProjectWorkspacePaths(project: LocalProject): WorkspacePaths {
  return {
    workspacePath: project.workspacePath,
    repoPath: project.workspacePath,
  };
}

export function localProjectSandboxTemplateRootPath(project: LocalProject): string {
  return project.sandboxTemplate?.rootPath ?? project.workspacePath;
}

export function localProjectWorkspaceApp(project: LocalProject): OpenPondApp {
  const linked = project.linkedOpenPondApp;
  if (linked) {
    return {
      id: linked.appId,
      name: linked.appName,
      description: null,
      visibility: "private",
      gitOwner: linked.gitOwner,
      gitRepo: linked.gitRepo,
      gitHost: linked.gitHost,
      defaultBranch: linked.defaultBranch,
      sandbox: false,
      updatedAt: project.updatedAt,
      latestDeployment: null,
    };
  }
  return {
    id: project.id,
    name: project.name,
    description: null,
    visibility: "private",
    gitOwner: null,
    gitRepo: null,
    gitHost: null,
    defaultBranch: null,
    sandbox: false,
    updatedAt: project.updatedAt,
    latestDeployment: null,
  };
}

export function localProjectStateWorkspace(project: LocalProject): OpenPondApp {
  const linked = project.linkedOpenPondApp;
  return {
    id: project.id,
    name: project.name,
    description: null,
    visibility: "private",
    gitOwner: linked?.gitOwner ?? null,
    gitRepo: linked?.gitRepo ?? null,
    gitHost: linked?.gitHost ?? null,
    defaultBranch: linked?.defaultBranch ?? null,
    sandbox: false,
    updatedAt: project.updatedAt,
    latestDeployment: null,
  };
}
