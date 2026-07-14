import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { stdin as input } from "node:process";

import {
  checkOpenPondApiHealth,
  createHeadlessApps,
  createRepo,
  deployLatestTemplate,
  executeHostedTool,
  getDeploymentDetail,
  getLatestDeploymentForApp,
  getOpenPondAccount,
  getTemplateStatus,
  listTemplateBranches,
  submitBacktestRun,
} from "../api";
import {
  listConfiguredProfiles,
  loadConfig,
  saveProfileApiKey,
  setActiveProfile,
} from "../config";
import {
  compareSemver,
  ensureApiKey,
  fetchAppsWithCache,
  fetchLatestNpmVersion,
  formatTokenizedRepoUrl,
  formatTokenizedRepoUrlForPrint,
  getGitRemoteUrl,
  getInstalledCliVersion,
  normalizeTemplateRepoUrl,
  parseBooleanOption,
  parseJsonOption,
  pollDeploymentLogs,
  promptConfirm,
  promptForApiKey,
  promptForPath,
  redactToken,
  resolveApiBaseUrlOption,
  resolveApiKey,
  resolveAppTarget,
  resolveBaseUrl,
  resolveBaseUrlOption,
  resolveChatApiBaseUrlOption,
  resolvePublicApiBaseUrl,
  resolveRepoUrl,
  resolveTemplateEnvironment,
  runCommand,
  warnOnRepoHostMismatch,
} from "./common";

export async function runTemplateStatus(
  _options: Record<string, string | boolean>,
  target: string
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const { app } = await resolveAppTarget(apiBase, apiKey, target);
  const status = await getTemplateStatus(apiBase, apiKey, app.id);
  console.log(JSON.stringify(status, null, 2));
}

export async function runTemplateBranches(
  _options: Record<string, string | boolean>,
  target: string
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const { app } = await resolveAppTarget(apiBase, apiKey, target);
  const branches = await listTemplateBranches(apiBase, apiKey, app.id);
  console.log(JSON.stringify(branches, null, 2));
}

export async function runTemplateUpdate(
  options: Record<string, string | boolean>,
  target: string
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const { app } = await resolveAppTarget(apiBase, apiKey, target);
  const envRaw =
    typeof options.env === "string"
      ? options.env
      : typeof options.environment === "string"
      ? options.environment
      : undefined;
  const environment = resolveTemplateEnvironment(envRaw);
  const result = await deployLatestTemplate(apiBase, apiKey, app.id, {
    environment,
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function runLogin(
  options: Record<string, string | boolean>
): Promise<void> {
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(config);
  const rawApiKey =
    typeof options.apiKey === "string"
      ? options.apiKey
      : typeof options.key === "string"
      ? options.key
      : null;
  const apiKey = rawApiKey ? rawApiKey.trim() : await promptForApiKey();
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (!apiKey.startsWith("opk_")) {
    console.log("warning: API keys usually start with opk_.");
  }
  await saveProfileApiKey({
    handle: config.activeProfile?.handle || "default",
    apiKey,
    baseUrl,
    apiBaseUrl: config.apiBaseUrl,
    chatApiBaseUrl: config.chatApiBaseUrl,
    setActive: true,
  });
  console.log("saved api key to ~/.openpond/config.json");
}

export async function runProfiles(
  options: Record<string, string | boolean>,
  rest: string[]
): Promise<void> {
  const subcommand = rest[0] || "list";
  if (subcommand === "list") {
    const profiles = await listConfiguredProfiles();
    console.log(JSON.stringify({ profiles }, null, 2));
    return;
  }

  if (subcommand === "use") {
    const handle = rest[1];
    if (!handle) {
      throw new Error("usage: profiles use <name> [--base-url <url>]");
    }
    const profile = await setActiveProfile(handle, {
      baseUrl: resolveBaseUrlOption(options),
    });
    console.log(JSON.stringify({ profile }, null, 2));
    return;
  }

  if (subcommand === "save") {
    const handle = rest[1];
    if (!handle) {
      throw new Error(
        "usage: profiles save <name> --api-key <key> [--base-url <url>] [--api-base-url <url>] [--chat-api-base-url <url>]"
      );
    }
    const rawApiKey =
      typeof options.apiKey === "string"
        ? options.apiKey
        : typeof options.key === "string"
        ? options.key
        : null;
    const apiKey = rawApiKey ? rawApiKey.trim() : await promptForApiKey();
    const environment =
      typeof options.environment === "string"
        ? options.environment
        : typeof options.env === "string"
        ? options.env
        : undefined;
    const profile = await saveProfileApiKey({
      handle,
      apiKey,
      baseUrl: resolveBaseUrlOption(options),
      apiBaseUrl: resolveApiBaseUrlOption(options),
      chatApiBaseUrl: resolveChatApiBaseUrlOption(options),
      environment,
      setActive: true,
    });
    console.log(JSON.stringify({ profile }, null, 2));
    return;
  }

  throw new Error("usage: profiles <list|use|save> [args]");
}

export async function runAccount(): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const account = await getOpenPondAccount(apiBase, apiKey);
  console.log(JSON.stringify(account, null, 2));
}

export async function runHealth(
  _options: Record<string, string | boolean>
): Promise<void> {
  const config = await loadConfig();
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = resolveApiKey(config);
  const health = await checkOpenPondApiHealth(apiBase, apiKey);
  console.log(JSON.stringify(health, null, 2));
}

export async function runToolList(
  options: Record<string, string | boolean>,
  target: string
) {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const { app } = await resolveAppTarget(apiBase, apiKey, target);
  const branch =
    typeof options.branch === "string" ? String(options.branch) : undefined;
  const latest = await getLatestDeploymentForApp(apiBase, apiKey, app.id, {
    branch,
  });
  if (!latest?.id) {
    console.log("no deployments found");
    return;
  }
  const detail = await getDeploymentDetail(apiBase, apiKey, latest.id);
  const toolsRaw =
    (detail && Array.isArray(detail.toolsJson) ? detail.toolsJson : null) ||
    (detail && typeof detail.metadataJson === "object" && detail.metadataJson
      ? (detail.metadataJson as { tools?: unknown }).tools
      : null);
  const tools = Array.isArray(toolsRaw) ? toolsRaw : [];
  if (tools.length === 0) {
    console.log("no tools found");
    return;
  }
  for (const tool of tools) {
    const record = tool as Record<string, unknown>;
    const profile = (record.profile || record.function) as
      | Record<string, unknown>
      | undefined;
    const name =
      (record.name as string | undefined) ||
      (profile?.name as string | undefined) ||
      "unknown";
    const description =
      (record.description as string | undefined) ||
      (profile?.description as string | undefined) ||
      "";
    console.log(description ? `${name} - ${description}` : name);
  }
}

export async function runToolRun(
  options: Record<string, string | boolean>,
  target: string,
  toolName: string
) {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const { app } = await resolveAppTarget(apiBase, apiKey, target);
  const branch =
    typeof options.branch === "string" ? String(options.branch) : undefined;
  const latest = await getLatestDeploymentForApp(apiBase, apiKey, app.id, {
    branch,
  });
  if (!latest?.id) {
    throw new Error("no deployments found");
  }
  let body: unknown = undefined;
  if (typeof options.body === "string") {
    try {
      body = JSON.parse(options.body);
    } catch {
      throw new Error("tool body must be valid JSON");
    }
  }
  const method =
    typeof options.method === "string"
      ? String(options.method).toUpperCase()
      : "POST";
  const result = await executeHostedTool(uiBase, apiKey, {
    appId: app.id,
    deploymentId: latest.id,
    toolName,
    method: method as "GET" | "POST" | "PUT" | "DELETE",
    body,
    headers: apiKey ? { "openpond-api-key": apiKey } : undefined,
  });
  if (!result.ok) {
    throw new Error(result.error || `tool failed (${result.status})`);
  }
  const output = result.data ?? { ok: true };
  console.log(JSON.stringify(output, null, 2));
}

export async function runBacktestRun(
  options: Record<string, string | boolean>,
  target: string,
  toolName: string
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const { app } = await resolveAppTarget(apiBase, apiKey, target);
  const branch =
    typeof options.branch === "string" ? String(options.branch) : undefined;
  const deploymentId =
    typeof options.deploymentId === "string"
      ? String(options.deploymentId)
      : undefined;
  const latest = deploymentId
    ? { id: deploymentId }
    : await getLatestDeploymentForApp(apiBase, apiKey, app.id, { branch });
  if (!latest?.id) {
    throw new Error("no deployments found");
  }

  const bodyRaw =
    typeof options.body === "string"
      ? parseJsonOption(String(options.body), "body")
      : {};
  if (!bodyRaw || typeof bodyRaw !== "object" || Array.isArray(bodyRaw)) {
    throw new Error("body must be a JSON object");
  }

  const method =
    typeof options.method === "string"
      ? String(options.method).toUpperCase()
      : "POST";
  const payload = {
    ...(bodyRaw as Record<string, unknown>),
    appId: app.id,
    deploymentId: latest.id,
    toolName,
    method: method as "GET" | "POST" | "PUT" | "DELETE",
  };
  const result = await submitBacktestRun(apiBase, apiKey, payload);
  console.log(JSON.stringify(result, null, 2));
}

export async function runDeployWatch(
  options: Record<string, string | boolean>,
  target: string
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const { app, handle, repo } = await resolveAppTarget(apiBase, apiKey, target);
  const branch =
    typeof options.branch === "string" ? String(options.branch) : undefined;
  const deploymentId =
    typeof options.deploymentId === "string"
      ? String(options.deploymentId)
      : undefined;
  const latest = deploymentId
    ? { id: deploymentId }
    : await getLatestDeploymentForApp(apiBase, apiKey, app.id, {
        branch,
      });
  if (!latest?.id) {
    console.log("no deployments found");
    return;
  }
  await pollDeploymentLogs({
    baseUrl: apiBase,
    apiKey,
    deploymentId: latest.id,
    prefix: `[${handle}/${repo}] `,
    intervalMs: options.interval ? Number(options.interval) : undefined,
    timeoutMs: options.timeout ? Number(options.timeout) : undefined,
  });
}

export async function runRepoCreate(
  options: Record<string, string | boolean>,
  nameParts: string[]
): Promise<void> {
  const name =
    (typeof options.name === "string" ? options.name : null) ||
    nameParts.join(" ");
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error(
      "usage: repo create --name <name> [--team-id <id>] [--path <dir>] [--template <owner/repo|url>] [--template-branch <branch>] [--empty|--opentool] [--sandbox] [--token] [--auto-schedule-migration <true|false>]"
    );
  }

  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const apiBase = resolvePublicApiBaseUrl(config);
  const teamId =
    typeof options.teamId === "string" && options.teamId.trim()
      ? options.teamId.trim()
      : undefined;

  const templateInput =
    typeof options.template === "string" ? options.template.trim() : "";
  if (
    templateInput &&
    (options.empty === "true" || options.opentool === "true")
  ) {
    throw new Error("choose one: --template or --empty/--opentool");
  }
  if (options.empty === "true" && options.opentool === "true") {
    throw new Error("choose one: --empty or --opentool");
  }

  const description =
    typeof options.description === "string"
      ? options.description.trim()
      : undefined;
  const templateBranch =
    typeof options.templateBranch === "string" &&
    options.templateBranch.trim().length > 0
      ? options.templateBranch.trim()
      : undefined;
  const envVars =
    typeof options.env === "string"
      ? (parseJsonOption(options.env, "env") as Record<string, string>)
      : undefined;
  if (envVars) {
    if (typeof envVars !== "object" || Array.isArray(envVars)) {
      throw new Error("env must be a JSON object");
    }
    for (const [key, value] of Object.entries(envVars)) {
      if (typeof value !== "string") {
        throw new Error(`env value for ${key} must be a string`);
      }
    }
  }

  if (templateInput) {
    if (options.deployOnPush !== undefined) {
      console.warn(
        "deploy-on-push is not used for template create (auto deploys)"
      );
    }
    const templateRepoUrl = normalizeTemplateRepoUrl(templateInput, uiBase);
    const response = await createHeadlessApps(
      apiBase,
      apiKey,
      [
        {
          name: trimmedName,
          ...(description ? { description } : {}),
          templateRepoUrl,
          ...(templateBranch ? { templateBranch } : {}),
          ...(envVars ? { envVars } : {}),
        },
      ],
      teamId
    );
    const item = response.items?.[0];
    if (!item || item.status !== "ok" || !item.appId) {
      throw new Error(item?.error || "Template create failed");
    }
    console.log(`app_id: ${item.appId}`);
    if (item.deploymentId) {
      console.log(`deployment_id: ${item.deploymentId}`);
    }
    if (item.conversationId) {
      console.log(`conversation_id: ${item.conversationId}`);
    }
    return;
  }

  const defaultPath = process.cwd();
  const rawPath =
    typeof options.path === "string"
      ? options.path
      : typeof options.dir === "string"
      ? options.dir
      : null;
  const targetPath =
    rawPath && rawPath.trim().length > 0
      ? rawPath.trim()
      : input.isTTY
      ? await promptForPath(defaultPath)
      : defaultPath;
  const repoPath = path.resolve(targetPath);

  if (existsSync(repoPath)) {
    const stats = await fs.stat(repoPath);
    if (!stats.isDirectory()) {
      throw new Error(`path is not a directory: ${repoPath}`);
    }
  } else {
    await fs.mkdir(repoPath, { recursive: true });
  }

  const entries = await fs.readdir(repoPath);
  const nonGitEntries = entries.filter((entry) => entry !== ".git");
  const isEmpty = nonGitEntries.length === 0;
  const force =
    parseBooleanOption(options.yes) || parseBooleanOption(options.force);
  if (!isEmpty && !force) {
    const proceed = await promptConfirm(
      `Directory is not empty (${repoPath}). Continue?`,
      false
    );
    if (!proceed) {
      console.log("aborted");
      return;
    }
  }

  const gitDir = path.join(repoPath, ".git");
  const hasGit = existsSync(gitDir);
  if (!hasGit) {
    const proceed = force
      ? true
      : await promptConfirm("Initialize git repository here?", true);
    if (!proceed) {
      console.log("aborted");
      return;
    }
    const result = await runCommand("git", ["init"], { cwd: repoPath });
    if (result.code !== 0) {
      throw new Error(
        `git init failed: ${
          result.stderr.trim() || result.stdout.trim() || "unknown error"
        }`
      );
    }
  }

  const originUrl = await getGitRemoteUrl(repoPath, "origin");
  if (originUrl && !force) {
    const proceed = await promptConfirm(
      `Remote "origin" already set (${originUrl}). Replace it?`,
      false
    );
    if (!proceed) {
      console.log("aborted");
      return;
    }
  }

  const repoInit = options.opentool === "true" ? "opentool" : "empty";
  const sandbox = parseBooleanOption(options.sandbox);
  const deployOnPush = parseBooleanOption(options.deployOnPush);
  const autoScheduleMigrationOption = options.autoScheduleMigration;
  const autoScheduleMigrationSpecified =
    typeof autoScheduleMigrationOption === "string" ||
    typeof autoScheduleMigrationOption === "boolean";
  const autoScheduleMigration = autoScheduleMigrationSpecified
    ? parseBooleanOption(autoScheduleMigrationOption)
    : undefined;

  const response = await createRepo(apiBase, apiKey, {
    name: trimmedName,
    ...(teamId ? { teamId } : {}),
    ...(description ? { description } : {}),
    ...(repoInit ? { repoInit } : {}),
    ...(sandbox ? { sandbox: true } : {}),
    ...(envVars ? { envVars } : {}),
    ...(deployOnPush ? { deployOnPush: true } : {}),
    ...(autoScheduleMigrationSpecified ? { autoScheduleMigration } : {}),
  });

  const repoUrl = resolveRepoUrl(response);
  warnOnRepoHostMismatch(repoUrl);
  const useTokenRemote =
    parseBooleanOption(options.token) ||
    parseBooleanOption(options.setRemoteToken);
  const tokenRemote = formatTokenizedRepoUrl(repoUrl, apiKey);
  const remoteUrl = useTokenRemote ? tokenRemote : repoUrl;
  const remoteArgs = originUrl
    ? ["remote", "set-url", "origin", remoteUrl]
    : ["remote", "add", "origin", remoteUrl];
  const remoteResult = await runCommand("git", remoteArgs, { cwd: repoPath });
  if (remoteResult.code !== 0) {
    throw new Error(
      `git remote failed: ${redactToken(
        remoteResult.stderr.trim() ||
          remoteResult.stdout.trim() ||
          "unknown error"
      )}`
    );
  }

  const displayRemote = useTokenRemote
    ? formatTokenizedRepoUrlForPrint(repoUrl)
    : repoUrl;
  console.log(`app_id: ${response.appId}`);
  if (response.gitOwner && response.gitRepo) {
    console.log(`repo: ${response.gitOwner}/${response.gitRepo}`);
  }
  console.log(`remote: ${displayRemote}`);
  console.log('next: git add . && git commit -m "init"');
  const defaultBranch = response.defaultBranch || "master";
  console.log(
    `next: openpond repo push --path ${repoPath} --branch ${defaultBranch}`
  );
  if (!useTokenRemote) {
    console.log(
      `token-remote (non-interactive): git -C ${repoPath} remote set-url origin ${formatTokenizedRepoUrlForPrint(
        repoUrl
      )}`
    );
  }

  try {
    await fetchAppsWithCache({ apiBase, apiKey, forceRefresh: true });
  } catch (error) {
    console.warn("cache refresh failed", error);
  }
}

export async function resolveGitBranch(
  repoPath: string
): Promise<string | null> {
  const result = await runCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    {
      cwd: repoPath,
    }
  );
  if (result.code !== 0) return null;
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : null;
}

export async function runRepoPush(
  options: Record<string, string | boolean>
): Promise<void> {
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(config);
  const apiKey = await ensureApiKey(config, baseUrl);

  const rawPath =
    typeof options.path === "string"
      ? options.path
      : typeof options.dir === "string"
      ? options.dir
      : null;
  const repoPath = path.resolve(
    rawPath && rawPath.trim().length > 0 ? rawPath.trim() : "."
  );
  const gitDir = path.join(repoPath, ".git");
  if (!existsSync(gitDir)) {
    throw new Error(`git repo not found at ${repoPath} (missing .git)`);
  }

  const originUrl = await getGitRemoteUrl(repoPath, "origin");
  if (!originUrl) {
    throw new Error("origin remote not set; run `openpond repo create` first");
  }
  warnOnRepoHostMismatch(originUrl);

  const branchOption =
    typeof options.branch === "string" ? options.branch.trim() : "";
  const resolvedBranch = branchOption || (await resolveGitBranch(repoPath));
  if (!resolvedBranch) {
    throw new Error("unable to resolve git branch; pass --branch");
  }

  let tokenRemote: string;
  try {
    tokenRemote = formatTokenizedRepoUrl(originUrl, apiKey);
  } catch {
    throw new Error("origin remote must be https for tokenized pushes");
  }
  const keepTokenRemote =
    parseBooleanOption(options.keepTokenRemote) ||
    parseBooleanOption(options.token) ||
    parseBooleanOption(options.setRemoteToken);
  const alreadyTokenized = originUrl.includes("x-access-token:");
  const restoreUrl = !keepTokenRemote && !alreadyTokenized ? originUrl : null;

  const previousPrompt = process.env.GIT_TERMINAL_PROMPT;
  process.env.GIT_TERMINAL_PROMPT = "0";
  try {
    if (!alreadyTokenized) {
      const setResult = await runCommand(
        "git",
        ["remote", "set-url", "origin", tokenRemote],
        {
          cwd: repoPath,
        }
      );
      if (setResult.code !== 0) {
        throw new Error(
          `git remote set-url failed: ${redactToken(
            setResult.stderr.trim() ||
              setResult.stdout.trim() ||
              "unknown error"
          )}`
        );
      }
    }

    const pushResult = await runCommand(
      "git",
      ["push", "-u", "origin", resolvedBranch],
      {
        cwd: repoPath,
        inherit: true,
      }
    );
    if (pushResult.code !== 0) {
      throw new Error("git push failed");
    }
  } finally {
    if (restoreUrl) {
      await runCommand("git", ["remote", "set-url", "origin", restoreUrl], {
        cwd: repoPath,
      }).catch(() => null);
    }
    if (previousPrompt === undefined) {
      delete process.env.GIT_TERMINAL_PROMPT;
    } else {
      process.env.GIT_TERMINAL_PROMPT = previousPrompt;
    }
  }
}

export async function runOpentool(rawArgs: string[]): Promise<void> {
  if (rawArgs.length === 0) {
    throw new Error("usage: opentool <init|validate|build> [args]");
  }
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = await runCommand(command, ["opentool", ...rawArgs], {
    inherit: true,
  });
  if (result.code !== 0) {
    throw new Error("opentool command failed");
  }
}

export async function runCheckUpdate(): Promise<void> {
  const packageName = "openpond";
  const installed = getInstalledCliVersion();
  const latest = await fetchLatestNpmVersion(packageName);
  const installCommand = `npm i -g ${packageName}@${latest}`;
  const cmp = compareSemver(installed, latest);

  if (cmp === 0) {
    console.log(`${packageName} is up to date (${installed})`);
    return;
  }

  if (cmp === -1) {
    console.log(`Update available: ${installed} -> ${latest}`);
    console.log(`Run: ${installCommand}`);
    return;
  }

  if (cmp === 1) {
    console.log(
      `Installed version (${installed}) is newer than npm latest (${latest}).`
    );
    return;
  }

  if (installed === latest) {
    console.log(`${packageName} is up to date (${installed})`);
    return;
  }

  console.log(`Installed: ${installed}`);
  console.log(`Latest: ${latest}`);
  console.log(`Run: ${installCommand}`);
}
