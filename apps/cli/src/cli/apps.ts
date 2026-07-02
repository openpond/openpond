import {
  createAgentFromPrompt,
  deployApp,
  executeUserTool,
  getAppEnvironment,
  getAppRuntimeSummary,
  getUserPerformance,
  runAssistantMode,
  submitBacktestDetail,
  submitBacktestTx,
  submitPositionsTx,
  updateAppCodeVisibility,
  updateAppEnvironment,
} from "../api";
import { loadConfig } from "../config";
import { consumeStream, formatStreamItem } from "../stream";
import {
  ensureApiKey,
  fetchAppsWithCache,
  fetchToolsWithCache,
  normalizeRepoName,
  parseBooleanOption,
  parseJsonOption,
  parseTimeOption,
  pollDeploymentLogs,
  resolveAppTarget,
  resolveBaseUrl,
  resolvePublicApiBaseUrl,
  resolveTemplateEnvironment,
} from "./common";

export async function runAppsTools(): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const apiBase = resolvePublicApiBaseUrl(config);
  const tools = await fetchToolsWithCache({ apiBase, apiKey });
  console.log(JSON.stringify(tools, null, 2));
}

export async function runAppsList(
  options: Record<string, string | boolean>
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const handle =
    typeof options.handle === "string" ? String(options.handle) : undefined;
  const normalizedHandle = handle ? normalizeRepoName(handle) : null;
  const forceRefresh =
    options.refresh !== undefined
      ? parseBooleanOption(options.refresh)
      : undefined;
  const apps = await fetchAppsWithCache({
    apiBase,
    apiKey,
    forceRefresh,
  });
  const filtered = normalizedHandle
    ? apps.filter((app) => {
        const candidate = normalizeRepoName(app.handle || app.gitOwner);
        return candidate === normalizedHandle;
      })
    : apps;
  if (filtered.length === 0) {
    console.log("no apps found");
    return;
  }
  if (parseBooleanOption(options.json)) {
    console.log(JSON.stringify({ apps: filtered }, null, 2));
    return;
  }
  for (const app of filtered) {
    const owner = app.handle || app.gitOwner || "unknown";
    const repo = app.repo || app.gitRepo || app.id;
    const status = app.latestDeployment?.status || "no-deploy";
    const branch = app.latestDeployment?.gitBranch || app.defaultBranch || "-";
    const codeVisibility = app.codeVisibility || "unknown";
    const sandbox = app.sandbox ? "yes" : "no";
    console.log(
      `${owner}/${repo}  ${status}  ${branch}  code=${codeVisibility}  sandbox=${sandbox}  ${app.id}`
    );
  }
}

export async function runAppsCodeVisibility(
  options: Record<string, string | boolean>,
  target: string
): Promise<void> {
  const visibility =
    typeof options.visibility === "string"
      ? options.visibility.trim()
      : typeof options.codeVisibility === "string"
      ? options.codeVisibility.trim()
      : "";

  if (visibility !== "public" && visibility !== "private") {
    throw new Error(
      "usage: apps code-visibility <handle>/<repo> --visibility public|private"
    );
  }

  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const { app, handle, repo } = await resolveAppTarget(apiBase, apiKey, target);
  const result = await updateAppCodeVisibility(
    apiBase,
    apiKey,
    app.id,
    visibility
  );
  console.log(
    `${handle}/${repo} code_visibility=${
      result.app?.codeVisibility ?? visibility
    } app_id=${app.id}`
  );
}

export async function runAppsPerformance(
  options: Record<string, string | boolean>
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const apiBase = resolvePublicApiBaseUrl(config);
  const appId =
    typeof options.appId === "string" ? String(options.appId) : undefined;
  const performance = await getUserPerformance(apiBase, apiKey, { appId });
  console.log(JSON.stringify(performance, null, 2));
}

export async function runAppsSummary(
  _options: Record<string, string | boolean>,
  target: string
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const { app } = await resolveAppTarget(apiBase, apiKey, target);
  const summary = await getAppRuntimeSummary(apiBase, apiKey, app.id);
  console.log(JSON.stringify(summary, null, 2));
}

export async function runAppsAssistant(
  options: Record<string, string | boolean>,
  mode: "plan" | "performance",
  target: string,
  contentParts: string[]
): Promise<void> {
  const prompt =
    (typeof options.prompt === "string" ? options.prompt : null) ||
    contentParts.join(" ");
  if (!prompt.trim()) {
    throw new Error(
      "usage: apps assistant <plan|performance> <handle>/<repo> --prompt <text>"
    );
  }

  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const { app } = await resolveAppTarget(apiBase, apiKey, target);
  const result = await runAssistantMode(apiBase, apiKey, {
    appId: app.id,
    mode,
    prompt: prompt.trim(),
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function runAppsAgentCreate(
  options: Record<string, string | boolean>,
  contentParts: string[]
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const apiBase = resolvePublicApiBaseUrl(config);
  const prompt =
    (typeof options.prompt === "string" ? options.prompt : null) ||
    contentParts.join(" ");
  if (!prompt.trim()) {
    throw new Error(
      "usage: apps agent create --prompt <text> [--team-id <id>]"
    );
  }
  const templateRepoUrl =
    typeof options.templateRepoUrl === "string"
      ? options.templateRepoUrl
      : undefined;
  const templateBranch =
    typeof options.templateBranch === "string"
      ? options.templateBranch
      : undefined;
  const templateLocalPath =
    typeof options.templateLocalPath === "string"
      ? options.templateLocalPath
      : undefined;
  const teamId =
    typeof options.teamId === "string" && options.teamId.trim()
      ? options.teamId.trim()
      : undefined;
  if (templateLocalPath && String(templateLocalPath).trim().length > 0) {
    throw new Error("templateLocalPath is not supported; use templateRepoUrl");
  }
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

  const template =
    templateRepoUrl || templateBranch || envVars
      ? {
          templateRepoUrl,
          templateBranch,
          envVars,
        }
      : undefined;

  const deployEnvironment =
    typeof options.deployEnvironment === "string"
      ? options.deployEnvironment === "preview"
        ? "preview"
        : "production"
      : undefined;
  const deployDisabled =
    options.deployDisabled !== undefined
      ? parseBooleanOption(options.deployDisabled)
      : undefined;
  const streamDeployLogs =
    options.streamDeployLogs !== undefined
      ? parseBooleanOption(options.streamDeployLogs)
      : true;

  const response = await createAgentFromPrompt(apiBase, apiKey, {
    prompt: prompt.trim(),
    ...(teamId ? { teamId } : {}),
    ...(template ? { template } : {}),
    ...(deployEnvironment ? { deployEnvironment } : {}),
    ...(deployDisabled !== undefined ? { deployDisabled } : {}),
    streamDeployLogs,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`agent create failed: ${response.status} ${text}`);
  }

  let conversationId: string | null = null;
  let appId: string | null = null;
  let deploymentId: string | null = null;

  await consumeStream(response, {
    onConversationId: (id) => {
      conversationId = id;
    },
    onItems: (items) => {
      for (const item of items) {
        const line = formatStreamItem(item);
        if (line) {
          console.log(line);
        }
        const typed = item as Record<string, unknown>;
        if (!appId && typeof typed.appId === "string") {
          appId = typed.appId;
        }
        if (!deploymentId && typeof typed.deploymentId === "string") {
          deploymentId = typed.deploymentId;
        }
      }
    },
  });

  if (conversationId) {
    console.log(`conversation_id: ${conversationId}`);
  }
  if (appId) {
    console.log(`app_id: ${appId}`);
  }
  if (deploymentId) {
    console.log(`deployment_id: ${deploymentId}`);
  }

  try {
    await fetchAppsWithCache({ apiBase, apiKey, forceRefresh: true });
    await fetchToolsWithCache({ apiBase, apiKey, forceRefresh: true });
  } catch (error) {
    console.warn("cache refresh failed", error);
  }
}

export async function runAppsToolsExecute(
  options: Record<string, string | boolean>,
  appId: string,
  deploymentId: string,
  toolName: string
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const apiBase = resolvePublicApiBaseUrl(config);
  const methodRaw =
    typeof options.method === "string"
      ? String(options.method).toUpperCase()
      : undefined;
  const method =
    methodRaw && ["GET", "POST", "PUT", "DELETE"].includes(methodRaw)
      ? (methodRaw as "GET" | "POST" | "PUT" | "DELETE")
      : undefined;
  if (methodRaw && !method) {
    throw new Error("method must be GET, POST, PUT, or DELETE");
  }
  const body =
    typeof options.body === "string"
      ? parseJsonOption(String(options.body), "body")
      : undefined;
  const headers =
    typeof options.headers === "string"
      ? (parseJsonOption(String(options.headers), "headers") as Record<
          string,
          string
        >)
      : undefined;
  const scheduleId =
    typeof options.scheduleId === "string"
      ? String(options.scheduleId)
      : undefined;
  const notifyEmail = parseBooleanOption(options.notifyEmail);
  const withSummary =
    parseBooleanOption(options.summary) ||
    parseBooleanOption(options.withSummary);
  const result = await executeUserTool(apiBase, apiKey, {
    appId,
    deploymentId,
    toolName,
    scheduleId,
    method,
    body,
    headers,
    notifyEmail: notifyEmail || undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  if (withSummary && result.ok) {
    const summary = await getAppRuntimeSummary(apiBase, apiKey, appId);
    console.log(JSON.stringify({ summary }, null, 2));
  }
}

export async function runAppsEnvSet(
  options: Record<string, string | boolean>,
  target: string
): Promise<void> {
  const rawEnv =
    typeof options.env === "string"
      ? options.env
      : typeof options.vars === "string"
      ? options.vars
      : typeof options.envVars === "string"
      ? options.envVars
      : null;
  if (!rawEnv) {
    throw new Error("usage: apps env set <handle>/<repo> --env <json>");
  }
  const parsed = parseJsonOption(rawEnv, "env");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("env must be a JSON object");
  }
  const envVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    if (typeof value !== "string") {
      throw new Error(`env value for ${key} must be a string`);
    }
    if (!key.startsWith("OPENTOOL_PUBLIC_")) {
      throw new Error("only OPENTOOL_PUBLIC_ env vars can be set");
    }
    envVars[key] = value;
  }

  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const { app } = await resolveAppTarget(apiBase, apiKey, target);
  const result = await updateAppEnvironment(apiBase, apiKey, app.id, {
    envVars,
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function runAppsEnvGet(
  _options: Record<string, string | boolean>,
  target: string
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const { app } = await resolveAppTarget(apiBase, apiKey, target);
  const result = await getAppEnvironment(apiBase, apiKey, app.id);
  console.log(JSON.stringify(result, null, 2));
}

export async function runAppsDeploy(
  options: Record<string, string | boolean>,
  target: string
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiBase = resolvePublicApiBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const { app, handle, repo } = await resolveAppTarget(apiBase, apiKey, target);
  const envRaw =
    typeof options.env === "string"
      ? options.env
      : typeof options.environment === "string"
      ? options.environment
      : undefined;
  const environment = resolveTemplateEnvironment(envRaw);
  const result = await deployApp(apiBase, apiKey, app.id, { environment });
  console.log(JSON.stringify(result, null, 2));

  const shouldWatch =
    parseBooleanOption(options.watch) ||
    parseBooleanOption(options.wait) ||
    parseBooleanOption(options.follow);
  if (!shouldWatch) return;

  await pollDeploymentLogs({
    baseUrl: apiBase,
    apiKey,
    deploymentId: result.deploymentId,
    prefix: `[${handle}/${repo}] `,
    intervalMs: options.interval ? Number(options.interval) : undefined,
    timeoutMs: options.timeout ? Number(options.timeout) : undefined,
  });
}

export async function runAppsPositionsTx(
  options: Record<string, string | boolean>
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const apiBase = resolvePublicApiBaseUrl(config);
  const methodRaw =
    typeof options.method === "string"
      ? String(options.method).toUpperCase()
      : "POST";
  const method = methodRaw === "GET" ? "GET" : "POST";
  if (methodRaw !== "GET" && methodRaw !== "POST") {
    throw new Error("method must be GET or POST");
  }
  let query: Record<string, string> | undefined;
  if (method === "GET" && typeof options.params === "string") {
    const parsed = parseJsonOption(String(options.params), "params");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("params must be a JSON object");
    }
    query = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      if (value === undefined) continue;
      query[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
  }
  const body =
    method === "POST" && typeof options.body === "string"
      ? parseJsonOption(String(options.body), "body")
      : undefined;
  const result = await submitPositionsTx(apiBase, apiKey, {
    method,
    body,
    query,
  });
  console.log(JSON.stringify(result, null, 2));
}

export function resolveStoreEventsParams(
  options: Record<string, string | boolean>
): Record<string, string> | undefined {
  let params: Record<string, string> = {};
  if (typeof options.params === "string") {
    const parsed = parseJsonOption(String(options.params), "params");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("params must be a JSON object");
    }
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      if (value === undefined) continue;
      params[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
  }

  const addParam = (key: string, value: string | undefined) => {
    if (value === undefined || value === "") return;
    params[key] = value;
  };

  addParam(
    "source",
    typeof options.source === "string" ? options.source.trim() : undefined
  );
  addParam(
    "walletAddress",
    typeof options.walletAddress === "string"
      ? options.walletAddress.trim()
      : undefined
  );
  addParam(
    "symbol",
    typeof options.symbol === "string" ? options.symbol.trim() : undefined
  );
  addParam(
    "cursor",
    typeof options.cursor === "string" ? options.cursor.trim() : undefined
  );
  addParam(
    "status",
    typeof options.status === "string" ? options.status.trim() : undefined
  );
  addParam("since", parseTimeOption(options.since, "since"));
  addParam("until", parseTimeOption(options.until, "until"));

  if (typeof options.limit === "string" && options.limit.trim().length > 0) {
    const parsed = Number.parseInt(options.limit, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error("limit must be a number");
    }
    addParam("limit", String(parsed));
  }

  if (options.history !== undefined) {
    addParam("history", parseBooleanOption(options.history) ? "true" : "false");
  }

  return Object.keys(params).length ? params : undefined;
}

export function resolveBacktestEventsParams(
  options: Record<string, string | boolean>
): Record<string, string> | undefined {
  let params: Record<string, string> = {};
  if (typeof options.params === "string") {
    const parsed = parseJsonOption(String(options.params), "params");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("params must be a JSON object");
    }
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      if (value === undefined) continue;
      params[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
  }

  const addParam = (key: string, value: string | undefined) => {
    if (value === undefined || value === "") return;
    params[key] = value;
  };

  addParam(
    "source",
    typeof options.source === "string" ? options.source.trim() : undefined
  );
  addParam(
    "walletAddress",
    typeof options.walletAddress === "string"
      ? options.walletAddress.trim()
      : undefined
  );
  addParam(
    "symbol",
    typeof options.symbol === "string" ? options.symbol.trim() : undefined
  );
  addParam(
    "cursor",
    typeof options.cursor === "string" ? options.cursor.trim() : undefined
  );
  addParam(
    "status",
    typeof options.status === "string" ? options.status.trim() : undefined
  );
  addParam(
    "backtestRunId",
    typeof options.runId === "string"
      ? options.runId.trim()
      : typeof options.backtestRunId === "string"
      ? options.backtestRunId.trim()
      : undefined
  );
  addParam("since", parseTimeOption(options.since, "since"));
  addParam("until", parseTimeOption(options.until, "until"));

  if (typeof options.limit === "string" && options.limit.trim().length > 0) {
    const parsed = Number.parseInt(options.limit, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error("limit must be a number");
    }
    addParam("limit", String(parsed));
  }

  return Object.keys(params).length ? params : undefined;
}

export async function runAppsStoreEvents(
  options: Record<string, string | boolean>
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const apiBase = resolvePublicApiBaseUrl(config);
  const query = resolveStoreEventsParams(options);
  const result = await submitPositionsTx(apiBase, apiKey, {
    method: "GET",
    query,
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function runBacktestEvents(
  options: Record<string, string | boolean>,
  target: string
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const apiBase = resolvePublicApiBaseUrl(config);
  const { app } = await resolveAppTarget(apiBase, apiKey, target);
  const query = {
    ...(resolveBacktestEventsParams(options) ?? {}),
    appId: app.id,
  };
  const result = await submitBacktestTx(apiBase, apiKey, {
    method: "GET",
    query,
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function runBacktestGet(
  options: Record<string, string | boolean>,
  target: string
): Promise<void> {
  const runId =
    typeof options.runId === "string"
      ? options.runId.trim()
      : typeof options.backtestRunId === "string"
      ? options.backtestRunId.trim()
      : "";
  if (!runId) {
    throw new Error("usage: backtest get <handle>/<repo> --run-id <id>");
  }

  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const apiBase = resolvePublicApiBaseUrl(config);
  const { app } = await resolveAppTarget(apiBase, apiKey, target);
  const result = await submitBacktestDetail(apiBase, apiKey, {
    appId: app.id,
    runId,
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function runAppsTradeFacts(
  options: Record<string, string | boolean>
): Promise<void> {
  const config = await loadConfig();
  const uiBase = resolveBaseUrl(config);
  const apiKey = await ensureApiKey(config, uiBase);
  const apiBase = resolvePublicApiBaseUrl(config);
  const appId = typeof options.appId === "string" ? options.appId : undefined;
  const performance = await getUserPerformance(apiBase, apiKey, { appId });
  if (
    performance &&
    typeof performance === "object" &&
    "trades" in performance &&
    Array.isArray((performance as { trades?: unknown }).trades)
  ) {
    console.log(
      JSON.stringify((performance as { trades: unknown }).trades, null, 2)
    );
    return;
  }
  console.log(JSON.stringify(performance, null, 2));
}
