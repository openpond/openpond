import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  loadGlobalConfig,
  saveGlobalConfig,
  type LocalOpenPondProfileCheckStatus,
  type LocalOpenPondProfileConfig,
  type LocalOpenPondProfilePushStatus,
} from "../config.js";
import { openPondConfigDirectory } from "../private-json-file.js";
import {
  emptyProfileCatalogState,
  emptyProfileDiffSummary,
  emptyProfileSetupGate,
  emptyProfileSummary,
  emptyProfileSkillCatalogState,
  type OpenPondProfileActionCatalogEntry,
  type OpenPondProfileAgent,
  type OpenPondProfileCatalogState,
  type OpenPondProfileDiffSummary,
  type OpenPondProfileEval,
  type OpenPondProfileGitFileChange,
  type OpenPondProfileGitState,
  type OpenPondProfileHostedBinding,
  type OpenPondProfileState,
  type OpenPondProfileSummary,
} from "./local-profile-types.js";
import { loadProfileActionCatalog } from "./profile-catalog.js";
import { loadProfileActionCatalogForSources } from "./profile-catalog.js";
import { loadProfileSkills } from "./profile-skills.js";
import {
  assertOpenPondProfileActionReady,
  buildOpenPondProfileSetupGate,
} from "./profile-setup-gate.js";
import {
  commitProfileChanges,
  ensureProfileGitRepo,
  loadProfileGitState,
  profileGitHead,
} from "./profile-git.js";

export const PROFILE_REPO_MANIFEST = "openpond-profile.json";
export const PROFILE_MANIFEST = "settings/profile.yaml";
export const DEFAULT_LOCAL_PROFILE = "default";
export const DEFAULT_PROFILE_AGENT = "default";

export type ProfileRepoManifest = {
  schema: "openpond.profileRepo.v1";
  defaultProfile: string;
  profiles: Record<
    string,
    {
      path: string;
      defaultAgent?: string;
      enabledAgents?: string[];
      agentNames?: Record<string, string>;
    }
  >;
};

export type {
  OpenPondProfileActionCatalogEntry,
  OpenPondProfileAgent,
  OpenPondProfileCatalogState,
  OpenPondProfileDiffSummary,
  OpenPondProfileEval,
  OpenPondProfileGitFileChange,
  OpenPondProfileGitState,
  OpenPondProfileHostedBinding,
  OpenPondProfileSetupGate,
  OpenPondProfileSetupRequirement,
  OpenPondProfileSkill,
  OpenPondProfileSkillCatalogState,
  OpenPondProfileState,
  OpenPondProfileSummary,
} from "./local-profile-types.js";
export {
  OpenPondProfileSetupRequiredError,
  assertOpenPondProfileActionReady,
  buildOpenPondProfileSetupGate,
  formatOpenPondProfileSetupRequirement,
} from "./profile-setup-gate.js";
export type {
  LocalOpenPondProfileCheckStatus,
  LocalOpenPondProfilePushStatus,
} from "../config.js";
export {
  collectProfileSourceUploadEntries,
  type OpenPondProfileSourceUpload,
  type OpenPondProfileSourceUploadEntry,
} from "./profile-source-upload.js";
export {
  hostedPublishStatusFromPayload,
  hostedRunStatusFromRunSummary,
  hostedRunSummaryFromPayload,
  hostedSourceCheckStatusFromPayload,
} from "./profile-promotion.js";

export type InitLocalProfileInput = {
  repoPath?: string;
  profile?: string;
  template?: string;
  force?: boolean;
};

export function mergeProfileRepoManifestEntry(
  existing: ProfileRepoManifest["profiles"][string] | undefined,
  profilePath: string
): ProfileRepoManifest["profiles"][string] {
  const defaultAgent = existing?.defaultAgent ?? DEFAULT_PROFILE_AGENT;
  const enabledAgents =
    existing?.enabledAgents && existing.enabledAgents.length > 0
      ? existing.enabledAgents
      : [defaultAgent];
  return {
    ...(existing ?? {}),
    path: profilePath,
    defaultAgent,
    enabledAgents,
  };
}

export function mergeActiveLocalProfileConfig(
  existing: LocalOpenPondProfileConfig | undefined,
  repoPath: string,
  profile: string
): LocalOpenPondProfileConfig {
  const next: LocalOpenPondProfileConfig = {
    repoPath,
    profile,
    mode: "local",
  };
  if (!existing) return next;
  if (
    path.resolve(existing.repoPath) !== path.resolve(repoPath) ||
    existing.profile !== profile
  ) {
    return next;
  }
  return {
    ...existing,
    ...next,
  };
}

export type RunProfileCommandInput = {
  command: "inspect" | "build" | "validate" | "eval" | "run";
  args?: string[];
  cwd?: string;
  inherit?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

type ProfileCheckCommand = Exclude<RunProfileCommandInput["command"], "run">;

const require = createRequire(import.meta.url);

export function defaultLocalProfileRepoPath(): string {
  return path.join(openPondConfigDirectory(), "profiles", "default-repo");
}

export function emptyProfileState(
  error: string | null = null
): OpenPondProfileState {
  return {
    mode: "none",
    repoPath: null,
    activeProfile: null,
    sourcePath: null,
    manifestPath: null,
    agents: [],
    skills: [],
    evals: [],
    git: null,
    catalog: emptyProfileCatalogState(error),
    skillCatalog: emptyProfileSkillCatalogState(error),
    actionCatalog: [],
    sourceSetupRequirements: [],
    setupGate: emptyProfileSetupGate(),
    diff: emptyProfileDiffSummary(),
    hosted: null,
    summary: emptyProfileSummary(error),
    lastCheck: null,
    error,
  };
}

export async function initLocalProfileRepo(
  input: InitLocalProfileInput = {}
): Promise<OpenPondProfileState> {
  const repoPath = path.resolve(
    input.repoPath ?? defaultLocalProfileRepoPath()
  );
  const profile = normalizeProfileName(input.profile);
  const profilePath = path.join("profiles", profile);
  const profileSourcePath = path.join(repoPath, profilePath);

  await mkdir(repoPath, { recursive: true });
  const manifest = await readProfileManifest(repoPath).catch(() =>
    defaultProfileManifest(profile, profilePath)
  );
  manifest.defaultProfile = manifest.defaultProfile || profile;
  manifest.profiles[profile] = mergeProfileRepoManifestEntry(
    manifest.profiles[profile],
    profilePath
  );

  await ensureProfileSource(
    profileSourcePath,
    input.template ?? "blank-agent",
    Boolean(input.force)
  );
  await ensureProfileDependencies(profileSourcePath);
  await ensureProfileScaffoldFiles(repoPath, profileSourcePath, profile);
  await writeProfileManifest(repoPath, manifest);
  await ensureProfileGitRepo(repoPath);
  const currentConfig = (await loadGlobalConfig()).openpondProfile;
  await saveGlobalConfig({
    openpondProfile: mergeActiveLocalProfileConfig(
      currentConfig,
      repoPath,
      profile
    ),
  });
  return loadOpenPondProfileState();
}

export async function loadLocalProfileRepo(
  repoPathInput: string,
  profileInput?: string
): Promise<OpenPondProfileState> {
  const repoPath = path.resolve(repoPathInput);
  const manifest = await readProfileManifest(repoPath);
  const profile = normalizeProfileName(profileInput ?? manifest.defaultProfile);
  profileSourcePath(manifest, repoPath, profile);
  const currentConfig = (await loadGlobalConfig()).openpondProfile;
  await saveGlobalConfig({
    openpondProfile: mergeActiveLocalProfileConfig(
      currentConfig,
      repoPath,
      profile
    ),
  });
  return loadOpenPondProfileState();
}

export async function renameActiveProfileAgent(
  agentIdInput: string,
  nameInput: string
): Promise<OpenPondProfileState> {
  const agentId = agentIdInput.trim();
  const name = normalizeAgentDisplayName(nameInput);
  if (!agentId) throw new Error("Agent ID is required.");

  const config = await loadGlobalConfig();
  const active = config.openpondProfile;
  if (!active) throw new Error("No active local Profile.");

  const manifest = await readProfileManifest(active.repoPath);
  const profileConfig = manifest.profiles[active.profile];
  if (!profileConfig) {
    throw new Error(`Profile "${active.profile}" was not found.`);
  }
  const defaultAgent = profileConfig.defaultAgent ?? DEFAULT_PROFILE_AGENT;
  const enabledAgents = profileConfig.enabledAgents ?? [defaultAgent];
  if (!enabledAgents.includes(agentId)) {
    throw new Error(
      `Agent "${agentId}" was not found in Profile "${active.profile}".`
    );
  }

  const agentNames = { ...(profileConfig.agentNames ?? {}) };
  if (name === agentId) delete agentNames[agentId];
  else agentNames[agentId] = name;
  if (Object.keys(agentNames).length) profileConfig.agentNames = agentNames;
  else delete profileConfig.agentNames;
  await writeProfileManifest(active.repoPath, manifest);
  return loadOpenPondProfileState();
}

export async function loadOpenPondProfileState(): Promise<OpenPondProfileState> {
  const config = await loadGlobalConfig();
  const active = config.openpondProfile;
  if (!active) return emptyProfileState();
  try {
    const manifest = await readProfileManifest(active.repoPath);
    const sourcePath = profileSourcePath(
      manifest,
      active.repoPath,
      active.profile
    );
    const agents = await listProfileAgents(manifest, active.profile);
    const catalogSources = profileCatalogSources({
      manifest,
      profile: active.profile,
      profileSourcePath: sourcePath,
      agents,
    });
    const [git, catalogResult, skillResult, evals] = await Promise.all([
      loadProfileGitState(active.repoPath),
      loadProfileActionCatalogForSources(catalogSources),
      loadProfileSkills(sourcePath),
      loadProfileEvals(sourcePath, catalogSources),
    ]);
    const hosted = hostedBindingFromConfig(active);
    const diff = summarizeProfileDiff(git, active.profile);
    const setupGate = buildOpenPondProfileSetupGate({
      actionCatalog: catalogResult.actionCatalog,
      sourceSetupRequirements: catalogResult.sourceSetupRequirements,
    });
    const summary = summarizeProfileState({
      agents,
      actionCatalog: catalogResult.actionCatalog,
      catalog: catalogResult.catalog,
      diff,
      git,
      hosted,
      lastCheck: active.lastCheck ?? null,
      error: null,
    });
    return {
      mode: "local",
      repoPath: active.repoPath,
      activeProfile: active.profile,
      sourcePath,
      manifestPath: path.join(active.repoPath, PROFILE_REPO_MANIFEST),
      agents,
      skills: skillResult.skills,
      evals,
      git,
      catalog: catalogResult.catalog,
      skillCatalog: skillResult.skillCatalog,
      actionCatalog: catalogResult.actionCatalog,
      sourceSetupRequirements: catalogResult.sourceSetupRequirements,
      setupGate,
      diff,
      hosted,
      summary,
      lastCheck: active.lastCheck ?? null,
      error: null,
    };
  } catch (error) {
    const git = await loadProfileGitState(active.repoPath).catch(() => null);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      mode: "local",
      repoPath: active.repoPath,
      activeProfile: active.profile,
      sourcePath: null,
      manifestPath: path.join(active.repoPath, PROFILE_REPO_MANIFEST),
      agents: [],
      skills: [],
      evals: [],
      git,
      catalog: emptyProfileCatalogState(errorMessage),
      skillCatalog: emptyProfileSkillCatalogState(errorMessage),
      actionCatalog: [],
      sourceSetupRequirements: [],
      setupGate: emptyProfileSetupGate(),
      diff: emptyProfileDiffSummary(),
      hosted: hostedBindingFromConfig(active),
      summary: emptyProfileSummary(errorMessage),
      lastCheck: active.lastCheck ?? null,
      error: errorMessage,
    };
  }
}

export async function requireActiveLocalProfile(): Promise<{
  config: LocalOpenPondProfileConfig;
  state: OpenPondProfileState;
}> {
  const config = (await loadGlobalConfig()).openpondProfile;
  if (!config) {
    throw new Error(
      "No active OpenPond profile. Run `openpond init` or `openpond profile load --path <dir>`."
    );
  }
  const state = await loadOpenPondProfileState();
  if (state.error) throw new Error(state.error);
  if (!state.sourcePath)
    throw new Error("Active OpenPond profile has no source path.");
  return { config, state };
}

export async function runProfileSdkCommand(
  input: RunProfileCommandInput
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const active = await requireActiveLocalProfile();
  const requestedRunArgs = input.command === "run" ? input.args ?? [] : [];
  const selectedAction =
    input.command === "run"
      ? active.state.actionCatalog.find(
          (action) => action.id === requestedRunArgs[0]
        )
      : null;
  const cwd = path.resolve(
    input.cwd ?? selectedAction?.sourcePath ?? active.state.sourcePath!
  );
  const runArgs =
    input.command === "run"
      ? runCommandArgs(
          cwd,
          input.args ?? [],
          selectedAction?.sourceActionId ?? null
        )
      : null;
  if (input.command === "run" && runArgs) {
    const actionId = runArgs[0]!;
    const catalog =
      path.resolve(active.state.sourcePath!) === cwd
        ? {
            actionCatalog: active.state.actionCatalog,
            sourceSetupRequirements: active.state.sourceSetupRequirements,
          }
        : await loadProfileActionCatalog(cwd);
    assertOpenPondProfileActionReady(
      actionId,
      buildOpenPondProfileSetupGate({
        actionCatalog: catalog.actionCatalog,
        sourceSetupRequirements: catalog.sourceSetupRequirements,
        actionId,
      })
    );
  }
  const result = await runAgentSdkProjectCommand({
    command: input.command,
    args:
      input.command === "run"
        ? runArgs ?? runCommandArgs(cwd, input.args ?? [])
        : input.args,
    cwd,
    inherit: input.inherit,
    throwOnFailure: false,
  });
  await saveProfileCheckStatus(input.command, result.code);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      detail ||
        `${input.command} failed with exit code ${result.code ?? "unknown"}`
    );
  }
  return result;
}

export async function runAgentSdkProjectCommand(
  input: RunProfileCommandInput & {
    cwd: string;
    throwOnFailure?: boolean;
  }
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}> {
  const cwd = path.resolve(input.cwd);
  const cli = resolveAgentSdkCliLaunch();
  const args =
    input.command === "run"
      ? [...cli.args, input.command, ...(input.args ?? [])]
      : [...cli.args, input.command, "--cwd", cwd, ...(input.args ?? [])];
  const result = await spawnCommand(cli.command, args, {
    cwd,
    inherit: input.inherit,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
  });
  if (input.throwOnFailure !== false && result.code !== 0) {
    const detail = commandFailureDetail(result, input.command);
    throw new Error(
      detail ||
        `${input.command} failed with exit code ${result.code ?? "unknown"}`
    );
  }
  return result;
}

function runCommandArgs(
  cwd: string,
  args: string[],
  sourceActionId: string | null = null
): string[] {
  const [actionName, ...rest] = args;
  if (!actionName || actionName.startsWith("--")) {
    throw new Error("run requires an action name");
  }
  return [sourceActionId ?? actionName, "--cwd", cwd, ...rest];
}

export async function runProfileCheck(kind: string | undefined): Promise<void> {
  const checks =
    !kind || kind === "all"
      ? (["inspect", "build", "validate", "eval"] as ProfileCheckCommand[])
      : ([kind] as ProfileCheckCommand[]);
  const active = await requireActiveLocalProfile();
  const manifest = await readProfileManifest(active.config.repoPath);
  const sources = profileCatalogSources({
    manifest,
    profile: active.config.profile,
    profileSourcePath: active.state.sourcePath!,
    agents: active.state.agents,
  });
  for (const command of checks) {
    if (
      command !== "inspect" &&
      command !== "build" &&
      command !== "validate" &&
      command !== "eval"
    ) {
      throw new Error(
        "check kind must be one of inspect, build, validate, eval, all"
      );
    }
    for (const source of sources) {
      await runProfileCheckForSource({
        command,
        source,
        profileSourcePath: active.state.sourcePath!,
        sourceCount: sources.length,
      });
    }
  }
}

async function runProfileCheckForSource(input: {
  command: ProfileCheckCommand;
  source: ReturnType<typeof profileCatalogSources>[number];
  profileSourcePath: string;
  sourceCount: number;
}): Promise<void> {
  const args =
    input.command === "inspect" ||
    input.command === "validate" ||
    input.command === "eval"
      ? ["--json"]
      : [];
  if (input.sourceCount > 1) {
    const label =
      path.relative(input.profileSourcePath, input.source.sourcePath) || ".";
    console.log(
      `\n[profile:${input.source.agentId}] ${input.command} ${label}`
    );
  }
  const result = await runAgentSdkProjectCommand({
    command: input.command,
    args,
    cwd: input.source.sourcePath,
    inherit: false,
    throwOnFailure: false,
  });
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
  await saveProfileCheckStatus(input.command, result.code);
  if (result.code !== 0) {
    const detail = commandFailureDetail(result, input.command);
    throw new Error(
      [
        `Profile check failed for enabled agent ${input.source.agentId} at ${input.source.sourcePath}.`,
        detail ||
          `${input.command} failed with exit code ${result.code ?? "unknown"}`,
      ].join("\n")
    );
  }
}

export async function commitActiveProfileChanges(message?: string): Promise<{
  committed: boolean;
  stdout: string;
  stderr: string;
  state: OpenPondProfileState;
}> {
  const active = await requireActiveLocalProfile();
  if (!active.state.repoPath) {
    throw new Error("Active OpenPond profile has no repo path.");
  }
  const result = await commitProfileChanges(
    active.state.repoPath,
    message?.trim() ||
      `Update OpenPond profile ${
        active.state.activeProfile ?? DEFAULT_LOCAL_PROFILE
      }`
  );
  return {
    committed: result.committed,
    stdout: result.stdout,
    stderr: result.stderr,
    state: await loadOpenPondProfileState(),
  };
}

export async function saveProfilePushStatus(
  status: LocalOpenPondProfilePushStatus
): Promise<void> {
  const config = (await loadGlobalConfig()).openpondProfile;
  if (!config) return;
  await saveGlobalConfig({
    openpondProfile: {
      ...config,
      lastPush: status,
    },
  });
}

async function saveProfileCheckStatus(
  command: LocalOpenPondProfileCheckStatus["command"],
  exitCode: number | null
): Promise<void> {
  const config = (await loadGlobalConfig()).openpondProfile;
  if (!config) return;
  const sourceHead = await profileGitHead(config.repoPath).catch(() => null);
  await saveGlobalConfig({
    openpondProfile: {
      ...config,
      lastCheck: {
        command,
        status: exitCode === 0 ? "passed" : "failed",
        checkedAt: new Date().toISOString(),
        exitCode,
        sourceHead,
      },
    },
  });
}

async function ensureProfileSource(
  profileSourcePath: string,
  template: string,
  force: boolean
): Promise<void> {
  await mkdir(profileSourcePath, { recursive: true });
  const entries = await readdir(profileSourcePath);
  if (entries.length > 0 && !force) return;
  const sdkRoot = resolveAgentSdkRoot();
  const templateDir = path.join(sdkRoot, "templates", template);
  if (!existsSync(templateDir)) {
    throw new Error(`Unknown agent template "${template}".`);
  }
  await cp(templateDir, profileSourcePath, {
    recursive: true,
    force,
    errorOnExist: false,
  });
  await rewriteTemplateSdkDependency(profileSourcePath, sdkRoot);
}

async function ensureProfileScaffoldFiles(
  repoPath: string,
  profileSourcePath: string,
  profile: string
): Promise<void> {
  await mkdir(path.join(repoPath, "profiles"), { recursive: true });
  for (const dir of [
    "agents",
    "skills",
    "actions",
    "extensions",
    "prompts",
    "goals",
    "evals",
    "settings",
    "traces",
  ]) {
    await mkdir(path.join(profileSourcePath, dir), { recursive: true });
  }
  const profileManifestPath = path.join(profileSourcePath, PROFILE_MANIFEST);
  if (!existsSync(profileManifestPath)) {
    await writeFile(
      profileManifestPath,
      [
        "schema: openpond.profile.v1",
        `profile: ${profile}`,
        "agents:",
        `  - id: ${DEFAULT_PROFILE_AGENT}`,
        "    path: agent/agent.ts",
        "    enabled: true",
        "",
      ].join("\n"),
      "utf8"
    );
  }
  const lockPath = path.join(profileSourcePath, "openpond.lock");
  if (!existsSync(lockPath)) {
    await writeFile(
      lockPath,
      "# OpenPond profile lockfile placeholder\n",
      "utf8"
    );
  }
}

async function rewriteTemplateSdkDependency(
  profileSourcePath: string,
  sdkRoot: string
): Promise<void> {
  const packageJsonPath = path.join(profileSourcePath, "package.json");
  const raw = await readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
  };
  packageJson.dependencies = {
    ...(packageJson.dependencies ?? {}),
    "openpond-agent-sdk": `file:${sdkRoot}`,
  };
  await writeFile(
    packageJsonPath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8"
  );
}

async function ensureProfileDependencies(
  profileSourcePath: string
): Promise<void> {
  if (!existsSync(path.join(profileSourcePath, "package.json"))) return;
  const sdkRoot = resolveAgentSdkRoot();
  await ensureAgentSdkBuilt(sdkRoot);
  const nodeModulesPath = path.join(profileSourcePath, "node_modules");
  const sdkLinkPath = path.join(nodeModulesPath, "openpond-agent-sdk");
  await mkdir(nodeModulesPath, { recursive: true });
  if (!existsSync(sdkLinkPath)) {
    await symlink(sdkRoot, sdkLinkPath, "dir");
  }
}

async function ensureAgentSdkBuilt(sdkRoot: string): Promise<void> {
  if (
    existsSync(path.join(sdkRoot, "dist", "cli.js")) &&
    existsSync(path.join(sdkRoot, "dist", "primitives", "index.js"))
  ) {
    return;
  }
  const buildScript = path.join(sdkRoot, "scripts", "build.ts");
  if (!existsSync(buildScript)) {
    throw new Error(
      `Resolved openpond-agent-sdk at ${sdkRoot}, but built SDK files are missing.`
    );
  }
  const result = await spawnCommand(
    process.execPath,
    [resolveTsxCli(sdkRoot), buildScript],
    { cwd: sdkRoot }
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      detail ||
        `openpond-agent-sdk build failed with exit code ${
          result.code ?? "unknown"
        }`
    );
  }
}

async function listProfileAgents(
  manifest: ProfileRepoManifest,
  profile: string
): Promise<OpenPondProfileAgent[]> {
  const profileConfig = manifest.profiles[profile];
  if (!profileConfig) return [];
  const defaultAgent = profileConfig.defaultAgent ?? DEFAULT_PROFILE_AGENT;
  const enabled = new Set(profileConfig.enabledAgents ?? [defaultAgent]);
  return Array.from(enabled).map((id) => ({
    id,
    name: profileConfig.agentNames?.[id]?.trim() || id,
    path: id === DEFAULT_PROFILE_AGENT ? "agent/agent.ts" : `agents/${id}`,
    enabled: true,
  }));
}

function profileCatalogSources(input: {
  manifest: ProfileRepoManifest;
  profile: string;
  profileSourcePath: string;
  agents: OpenPondProfileAgent[];
}) {
  const defaultAgent =
    input.manifest.profiles[input.profile]?.defaultAgent ??
    DEFAULT_PROFILE_AGENT;
  const agents =
    input.agents.length > 0
      ? input.agents
      : [
          {
            id: DEFAULT_PROFILE_AGENT,
            name: DEFAULT_PROFILE_AGENT,
            path: "agent/agent.ts",
            enabled: true,
          },
        ];
  return agents.map((agent) => ({
    agentId: agent.id,
    sourcePath:
      agent.id === DEFAULT_PROFILE_AGENT
        ? input.profileSourcePath
        : path.join(input.profileSourcePath, "agents", agent.id),
    preferred: agent.id === defaultAgent,
  }));
}

async function loadProfileEvals(
  profileSourcePath: string,
  sources: ReturnType<typeof profileCatalogSources>
): Promise<OpenPondProfileEval[]> {
  const evals = new Map<string, OpenPondProfileEval>();
  const roots = [
    {
      root: path.join(profileSourcePath, "evals"),
      agentId: null as string | null,
    },
    ...sources.flatMap((source) => [
      {
        root: path.join(source.sourcePath, "agent", "evals"),
        agentId: source.agentId,
      },
      { root: path.join(source.sourcePath, "evals"), agentId: source.agentId },
    ]),
  ];
  for (const entry of roots) {
    for (const sourcePath of await listEvalSourceFiles(entry.root)) {
      const relativePath = path
        .relative(profileSourcePath, sourcePath)
        .split(path.sep)
        .join("/");
      if (evals.has(relativePath)) continue;
      evals.set(relativePath, {
        id: relativePath,
        name: path
          .basename(sourcePath)
          .replace(/\.eval\.[^.]+$/i, "")
          .replace(/\.[^.]+$/i, ""),
        path: relativePath,
        agentId: entry.agentId,
        sourcePath,
      });
    }
  }
  return [...evals.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.path.localeCompare(right.path)
  );
}

async function listEvalSourceFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const sourcePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listEvalSourceFiles(sourcePath)));
    } else if (
      entry.isFile() &&
      /\.eval\.(?:[cm]?[jt]sx?)$/i.test(entry.name)
    ) {
      files.push(sourcePath);
    }
  }
  return files;
}

function hostedBindingFromConfig(
  config: LocalOpenPondProfileConfig
): OpenPondProfileHostedBinding | null {
  const push = config.lastPush;
  if (!push) return null;
  return {
    teamId: push.teamId ?? null,
    projectId: push.projectId ?? null,
    sourceRef: push.sourceRef ?? null,
    sourceCommitSha: push.hostedHead ?? null,
    lastPushedAt: push.pushedAt,
    lastPushedLocalHead: push.localHead ?? null,
    lastPushedHostedHead: push.hostedHead ?? null,
    promotionStatus: push.promotionStatus ?? null,
    hostedRunStatus: push.hostedRunStatus ?? null,
    hostedRunAgentId: push.hostedRunAgentId ?? null,
    hostedRunId: push.hostedRunId ?? null,
    hostedRunAt: push.hostedRunAt ?? null,
    hostedSourceMaterialization: push.hostedSourceMaterialization ?? null,
    hostedSourceCheck: push.hostedSourceCheck ?? null,
    hostedPublish: push.hostedPublish ?? null,
    hostedRun: push.hostedRun ?? null,
  };
}

function summarizeProfileState(input: {
  agents: OpenPondProfileAgent[];
  actionCatalog: OpenPondProfileActionCatalogEntry[];
  catalog: OpenPondProfileCatalogState;
  diff: OpenPondProfileDiffSummary;
  git: OpenPondProfileGitState;
  hosted: OpenPondProfileHostedBinding | null;
  lastCheck: LocalOpenPondProfileCheckStatus | null;
  error: string | null;
}): OpenPondProfileSummary {
  const defaultAction =
    input.actionCatalog.find((action) => action.id === "chat")?.id ??
    input.actionCatalog.find((action) => action.name === "chat")?.id ??
    input.actionCatalog.find((action) => action.id.endsWith(".chat"))?.id ??
    null;
  const checkFresh = Boolean(
    input.lastCheck &&
      input.lastCheck.status === "passed" &&
      input.lastCheck.sourceHead &&
      input.lastCheck.sourceHead === input.git.head &&
      !input.git.dirty &&
      !input.catalog.stale
  );
  const checkStaleReason = profileCheckStaleReason({
    catalog: input.catalog,
    git: input.git,
    lastCheck: input.lastCheck,
  });

  if (input.error) {
    return {
      state: "error",
      message: input.error,
      agentCount: input.agents.length,
      actionCount: input.actionCatalog.length,
      defaultAction,
      checkFresh,
      checkStaleReason,
      localHead: input.git.head,
      hostedHead: input.hosted?.sourceCommitSha ?? null,
    };
  }
  if (!input.git.isRepo) {
    return {
      state: "error",
      message: "Profile source is not Git-backed.",
      agentCount: input.agents.length,
      actionCount: input.actionCatalog.length,
      defaultAction,
      checkFresh: false,
      checkStaleReason: "Profile source is not Git-backed.",
      localHead: null,
      hostedHead: input.hosted?.sourceCommitSha ?? null,
    };
  }
  if (!input.git.head) {
    return {
      state: "pending_commit",
      message: "Profile source is ready for its first commit.",
      agentCount: input.agents.length,
      actionCount: input.actionCatalog.length,
      defaultAction,
      checkFresh: false,
      checkStaleReason: "Profile source has no committed head.",
      localHead: null,
      hostedHead: input.hosted?.sourceCommitSha ?? null,
    };
  }
  if (input.git.dirty) {
    return {
      state: "dirty",
      message: profileDirtyMessage(input.diff),
      agentCount: input.agents.length,
      actionCount: input.actionCatalog.length,
      defaultAction,
      checkFresh,
      checkStaleReason,
      localHead: input.git.head,
      hostedHead: input.hosted?.sourceCommitSha ?? null,
    };
  }
  return {
    state: "ready",
    message: input.catalog.stale
      ? "Profile source is clean; action catalog needs inspect/build."
      : "Profile source is clean.",
    agentCount: input.agents.length,
    actionCount: input.actionCatalog.length,
    defaultAction,
    checkFresh,
    checkStaleReason,
    localHead: input.git.head,
    hostedHead: input.hosted?.sourceCommitSha ?? null,
  };
}

function profileCheckStaleReason(input: {
  catalog: OpenPondProfileCatalogState;
  git: OpenPondProfileGitState;
  lastCheck: LocalOpenPondProfileCheckStatus | null;
}): string | null {
  if (input.catalog.error) return `Catalog error: ${input.catalog.error}`;
  if (input.catalog.stale)
    return "Action catalog artifacts are missing or stale.";
  if (!input.lastCheck) return "Profile checks have not run.";
  if (input.lastCheck.status !== "passed")
    return `Last ${input.lastCheck.command} check failed.`;
  if (!input.lastCheck.sourceHead)
    return "Last check did not record a source head.";
  if (input.git.head && input.lastCheck.sourceHead !== input.git.head) {
    return "Profile source changed since the last check.";
  }
  if (input.git.dirty) return "Profile has uncommitted source changes.";
  return null;
}

function profileDirtyMessage(diff: OpenPondProfileDiffSummary): string {
  const parts: string[] = [];
  if (diff.changedAgents.length > 0)
    parts.push(`${diff.changedAgents.length} changed agent(s)`);
  if (diff.newAgents.length > 0)
    parts.push(`${diff.newAgents.length} new agent(s)`);
  if (diff.deletedAgents.length > 0)
    parts.push(`${diff.deletedAgents.length} deleted agent(s)`);
  if (diff.changedSkills.length > 0)
    parts.push(`${diff.changedSkills.length} changed skill(s)`);
  if (diff.changedActions.length > 0)
    parts.push(`${diff.changedActions.length} changed action(s)`);
  if (diff.changedExtensions.length > 0)
    parts.push(`${diff.changedExtensions.length} changed extension(s)`);
  if (diff.setupChanges.length > 0)
    parts.push(`${diff.setupChanges.length} setup change(s)`);
  if (diff.envRequirementChanges.length > 0)
    parts.push(
      `${diff.envRequirementChanges.length} env requirement change(s)`
    );
  return parts.length > 0
    ? `Profile has ${parts.join(", ")}.`
    : "Profile has uncommitted source changes.";
}

function summarizeProfileDiff(
  git: OpenPondProfileGitState,
  profile: string
): OpenPondProfileDiffSummary {
  const diff = emptyProfileDiffSummary();
  diff.files = git.files;
  const profileRoot = `profiles/${profile}/`;
  for (const file of git.files) {
    const normalized = file.path.replace(/\\/g, "/");
    if (normalized === PROFILE_REPO_MANIFEST || normalized === ".gitignore") {
      addUnique(diff.setupChanges, normalized);
      continue;
    }
    if (!normalized.startsWith(profileRoot)) continue;
    const relative = normalized.slice(profileRoot.length);
    classifyProfileFileChange(diff, file, relative);
  }
  return diff;
}

function classifyProfileFileChange(
  diff: OpenPondProfileDiffSummary,
  file: OpenPondProfileGitFileChange,
  relativePath: string
): void {
  const firstSegment = relativePath.split("/")[0] ?? "";
  if (firstSegment === "agent") {
    addAgentChange(diff, DEFAULT_PROFILE_AGENT, file.category);
  } else if (firstSegment === "agents") {
    const agentId = relativePath.split("/")[1];
    if (agentId) addAgentChange(diff, agentId, file.category);
  } else if (firstSegment === "skills") {
    addUnique(diff.changedSkills, relativePath.split("/")[1] ?? relativePath);
  } else if (firstSegment === "actions") {
    addUnique(diff.changedActions, relativePath.split("/")[1] ?? relativePath);
  } else if (firstSegment === "extensions") {
    addUnique(
      diff.changedExtensions,
      relativePath.split("/")[1] ?? relativePath
    );
  } else if (
    firstSegment === "settings" ||
    relativePath === "package.json" ||
    relativePath === "openpond.yaml" ||
    relativePath === "openpond.lock"
  ) {
    addUnique(diff.setupChanges, relativePath);
  }

  if (relativePath.toLowerCase().includes("env")) {
    addUnique(diff.envRequirementChanges, relativePath);
  }
  if (relativePath.startsWith(".openpond/")) {
    addUnique(diff.changedActions, "catalog");
  }
}

function addAgentChange(
  diff: OpenPondProfileDiffSummary,
  agentId: string,
  category: OpenPondProfileGitFileChange["category"]
): void {
  if (category === "added" || category === "untracked") {
    addUnique(diff.newAgents, agentId);
    return;
  }
  if (category === "deleted") {
    addUnique(diff.deletedAgents, agentId);
    return;
  }
  addUnique(diff.changedAgents, agentId);
}

function addUnique(values: string[], value: string): void {
  if (!value || values.includes(value)) return;
  values.push(value);
}

function normalizeProfileName(value: string | undefined | null): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_LOCAL_PROFILE;
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      "profile name may only contain letters, numbers, dots, underscores, and hyphens"
    );
  }
  return trimmed;
}

function normalizeAgentDisplayName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Agent name is required.");
  if (name.length > 80)
    throw new Error("Agent name must be 80 characters or fewer.");
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Agent name cannot contain control characters.");
  }
  return name;
}

function defaultProfileManifest(
  profile: string,
  profilePath: string
): ProfileRepoManifest {
  return {
    schema: "openpond.profileRepo.v1",
    defaultProfile: profile,
    profiles: {
      [profile]: {
        path: profilePath,
        defaultAgent: DEFAULT_PROFILE_AGENT,
        enabledAgents: [DEFAULT_PROFILE_AGENT],
      },
    },
  };
}

async function readProfileManifest(
  repoPath: string
): Promise<ProfileRepoManifest> {
  const manifestPath = path.join(repoPath, PROFILE_REPO_MANIFEST);
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as ProfileRepoManifest;
  if (
    parsed.schema !== "openpond.profileRepo.v1" ||
    !parsed.profiles ||
    typeof parsed.profiles !== "object"
  ) {
    throw new Error(
      `${manifestPath} is not an OpenPond profile repo manifest.`
    );
  }
  return parsed;
}

async function writeProfileManifest(
  repoPath: string,
  manifest: ProfileRepoManifest
): Promise<void> {
  await writeFile(
    path.join(repoPath, PROFILE_REPO_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
}

function profileSourcePath(
  manifest: ProfileRepoManifest,
  repoPath: string,
  profile: string
): string {
  const profileConfig = manifest.profiles[profile];
  if (!profileConfig) {
    throw new Error(
      `Profile "${profile}" was not found in ${path.join(
        repoPath,
        PROFILE_REPO_MANIFEST
      )}.`
    );
  }
  const sourcePath = path.resolve(repoPath, profileConfig.path);
  if (!existsSync(sourcePath)) {
    throw new Error(`Profile source path does not exist: ${sourcePath}`);
  }
  return sourcePath;
}

function resolveAgentSdkRoot(): string {
  const packageJsonPath = require.resolve("openpond-agent-sdk/package.json");
  return path.dirname(packageJsonPath);
}

function resolveAgentSdkCliLaunch(): { command: string; args: string[] } {
  const sdkRoot = resolveAgentSdkRoot();
  const distCli = path.join(sdkRoot, "dist", "cli.js");
  if (existsSync(distCli))
    return { command: process.execPath, args: [distCli] };
  const sourceCli = path.join(sdkRoot, "src", "cli.ts");
  if (existsSync(sourceCli)) {
    return {
      command: process.execPath,
      args: [resolveTsxCli(sdkRoot), sourceCli],
    };
  }
  throw new Error(`openpond-agent CLI was not found under ${sdkRoot}`);
}

function resolveTsxCli(packageRoot: string): string {
  return createRequire(path.join(packageRoot, "package.json")).resolve(
    "tsx/cli"
  );
}

async function spawnCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    inherit?: boolean;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {}
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.inherit ? "inherit" : "pipe",
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            proc.kill("SIGTERM");
          }, timeoutMs)
        : null;
    const forceKill =
      timeoutMs > 0
        ? setTimeout(() => {
            if (timedOut && proc.exitCode === null) proc.kill("SIGKILL");
          }, timeoutMs + 5000)
        : null;
    if (!options.inherit) {
      proc.stdout?.on("data", (chunk) => {
        const next = appendBoundedOutput(
          stdout,
          String(chunk),
          maxOutputBytes,
          stdoutTruncated
        );
        stdout = next.text;
        stdoutTruncated = next.truncated;
      });
      proc.stderr?.on("data", (chunk) => {
        const next = appendBoundedOutput(
          stderr,
          String(chunk),
          maxOutputBytes,
          stderrTruncated
        );
        stderr = next.text;
        stderrTruncated = next.truncated;
      });
    }
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
    };
    proc.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    proc.on("close", (code) => {
      clearTimers();
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

function appendBoundedOutput(
  current: string,
  chunk: string,
  maxBytes: number,
  alreadyTruncated: boolean
): { text: string; truncated: boolean } {
  if (alreadyTruncated) return { text: current, truncated: true };
  const combined = `${current}${chunk}`;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return { text: combined, truncated: false };
  }
  const text = `${Buffer.from(combined)
    .subarray(0, Math.max(0, maxBytes))
    .toString("utf8")}\n[truncated after ${maxBytes} bytes]\n`;
  return { text, truncated: true };
}

function commandFailureDetail(
  result: {
    stdout: string;
    stderr: string;
    timedOut?: boolean;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
  },
  command: string
): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  const notes = [
    result.timedOut ? `${command} timed out` : "",
    result.stdoutTruncated ? "stdout truncated" : "",
    result.stderrTruncated ? "stderr truncated" : "",
  ].filter(Boolean);
  return [detail, ...notes].filter(Boolean).join("\n");
}
