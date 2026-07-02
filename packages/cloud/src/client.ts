import {
  checkOpenPondApiHealth,
  getAppRuntimeSummary,
  createAgentFromPrompt,
  createRepo,
  deleteOrArchiveSchedule,
  deployApp,
  deployLatestTemplate,
  getAppEnvironment,
  getAppExecutionTimeline,
  getScheduleExecutionLog,
  runAssistantMode,
  updateAppEnvironment,
  executeHostedTool,
  executeUserTool,
  getDeploymentDetail,
  getDeploymentLogs,
  getDeploymentStatus,
  getLatestDeploymentForApp,
  getOpenPondAccount,
  getOpenPondAccountBalance,
  getOpenToolRecipe,
  getOpenToolRules,
  getTemplateStatus,
  getUserPerformance,
  listTemplateBranches,
  listApps,
  listAppSchedules,
  listDeploymentScheduleExecutionLogs,
  listOpenToolRecipes,
  listScheduleExecutionLogs,
  listUserTools,
  promotePreviewToProduction,
  runScheduleNow,
  searchOpenToolRecipes,
  startAppLifecycle,
  startAppSchedules,
  stopAppSchedules,
  stopCurrentAppSchedules,
  submitPositionsTx,
  type AssistantMode,
  type AssistantRunResponse,
  type AgentCreateRequest,
  type AppEnvironmentGetResponse,
  type AppEnvironmentUpdateRequest,
  type AppEnvironmentUpdateResponse,
  type AppExecutionDeployment,
  type AppExecutionTimelineResponse,
  type AppExecutionToolRun,
  type AppListItem,
  type AppRuntimeSummary,
  type AppSchedule,
  type AppScheduleSummary,
  type AppSchedulesResponse,
  type CreateRepoRequest,
  type CreateRepoResponse,
  type DeploymentDetail,
  type DeploymentLogEntry,
  type OpenPondAccount,
  type OpenPondAccountBalanceResponse,
  type OpenPondAccountProduct,
  type OpenPondAccountResponse,
  type OpenPondApiHealth,
  type OpenPondApiHealthResponse,
  type OpenToolRecipe,
  type OpenToolRecipeDomain,
  type OpenToolRecipeGetRequest,
  type OpenToolRecipeListRequest,
  type OpenToolRecipeListResponse,
  type OpenToolRecipeSearchRequest,
  type OpenToolRecipeSearchResponse,
  type OpenToolRecipeSummary,
  type OpenToolRulesGetRequest,
  type OpenToolRulesGetResponse,
  type PromotePreviewToProductionRequest,
  type PromotePreviewToProductionResponse,
  type ScheduleDeleteResponse,
  type ScheduleExecutionLog,
  type ScheduleExecutionLogsResponse,
  type ScheduleRunNowRequest,
  type ScheduleRunNowResponse,
  type ScheduleToggleRequest,
  type ScheduleToggleResult,
  type StartAppLifecycleRequest,
  type StartAppLifecycleResponse,
  type TemplateBranchesResponse,
  type TemplateDeployLatestRequest,
  type TemplateDeployLatestResponse,
  type TemplateStatusResponse,
  type ToolExecuteRequest,
  type ToolExecuteResponse,
} from "./api.js";
import {
  DEFAULT_CACHE_TTL_MS,
  getCachedApps,
  getCachedTools,
  setCachedApps,
  setCachedTools,
} from "./cache.js";
import { consumeStream } from "./stream.js";
import type { StreamCallbacks } from "./stream.js";

export type { StreamCallbacks } from "./stream.js";
export type {
  AssistantMode,
  AssistantRunResponse,
  AgentCreateRequest,
  AppEnvironmentGetResponse,
  AppEnvironmentUpdateRequest,
  AppEnvironmentUpdateResponse,
  AppExecutionDeployment,
  AppExecutionTimelineResponse,
  AppExecutionToolRun,
  AppListItem,
  AppRuntimeSummary,
  AppSchedule,
  AppScheduleSummary,
  AppSchedulesResponse,
  CreateRepoRequest,
  CreateRepoResponse,
  DeploymentDetail,
  DeploymentLogEntry,
  OpenPondAccount,
  OpenPondAccountBalanceResponse,
  OpenPondAccountProduct,
  OpenPondAccountResponse,
  OpenPondApiHealth,
  OpenPondApiHealthResponse,
  OpenToolRecipe,
  OpenToolRecipeDomain,
  OpenToolRecipeGetRequest,
  OpenToolRecipeListRequest,
  OpenToolRecipeListResponse,
  OpenToolRecipeSearchRequest,
  OpenToolRecipeSearchResponse,
  OpenToolRecipeSummary,
  OpenToolRulesGetRequest,
  OpenToolRulesGetResponse,
  PromotePreviewToProductionRequest,
  PromotePreviewToProductionResponse,
  ScheduleDeleteResponse,
  ScheduleExecutionLog,
  ScheduleExecutionLogsResponse,
  ScheduleRunNowRequest,
  ScheduleRunNowResponse,
  ScheduleToggleRequest,
  ScheduleToggleResult,
  StartAppLifecycleRequest,
  StartAppLifecycleResponse,
  TemplateBranchesResponse,
  TemplateDeployLatestRequest,
  TemplateDeployLatestResponse,
  TemplateStatusResponse,
  ToolExecuteRequest,
  ToolExecuteResponse,
} from "./api.js";
import {
  getOpChatModel,
  getOpChatProvider,
  listOpChatModels,
  listOpChatProviders,
  resolveHostedChatApiBaseUrl,
  resolveOpChatApiBaseUrl,
  listHostedModels,
  listHostedProviders,
  sendHostedChatTurn,
  streamHostedChatTurn,
} from "./hosted-chat.js";
import {
  DEFAULT_OPENPOND_API_BASE_URL,
  DEFAULT_OPENPOND_CHAT_API_BASE_URL,
  DEFAULT_OPENPOND_OPCHAT_API_BASE_URL,
  DEFAULT_OPENPOND_WEB_BASE_URL,
} from "./urls.js";
export type {
  ChatRequestBody,
  ResponseItem,
  ResponseMessageItem,
  TemplateBootstrap,
  ToolCallItem,
  ToolOutputItem,
  UsageInfo,
} from "./types.js";
export type {
  HostedChatCompletion,
  HostedChatMessage,
  HostedChatRequestOptions,
  HostedChatRole,
  HostedChatStreamDelta,
  HostedChatTool,
  HostedChatToolCall,
  HostedChatToolChoice,
  HostedChatUsage,
  HostedChatApiBaseUrlOptions,
  HostedModel,
  HostedModelRequestOptions,
  HostedModelsRequestOptions,
  HostedModelsResponse,
  HostedProvider,
  HostedProviderRequestOptions,
  HostedProvidersRequestOptions,
  HostedProvidersResponse,
} from "./hosted-chat.js";
export type {
  OpChatCompletionSummary,
  OpChatSmokeOptions,
  OpChatSmokeSummary,
  OpChatStreamSummary,
  OpChatToolSummary,
} from "./opchat-smoke.js";
export type {
  Bar as IndicatorBar,
  BollingerResult,
  MacdResult,
  MaCrossResult,
  MaCrossSignal,
  PriceChangeResult,
} from "./indicators.js";
export {
  apiFetch,
  checkOpenPondApiHealth,
  getAppRuntimeSummary,
  commitFiles,
  createAgentFromPrompt,
  createRepo,
  createHeadlessApps,
  createLocalProject,
  deleteOrArchiveSchedule,
  deployApp,
  deployLatestTemplate,
  getAppEnvironment,
  getAppExecutionTimeline,
  getScheduleExecutionLog,
  updateAppEnvironment,
  executeHostedTool,
  executeUserTool,
  fetchToolManifest,
  getDeploymentDetail,
  getDeploymentLogs,
  getDeploymentStatus,
  getLatestDeploymentForApp,
  getOpenPondAccount,
  getOpenPondAccountBalance,
  getOpenToolRecipe,
  getOpenToolRules,
  getTemplateStatus,
  getUserPerformance,
  runAssistantMode,
  listApps,
  listAppSchedules,
  listDeploymentScheduleExecutionLogs,
  listOpenToolRecipes,
  listScheduleExecutionLogs,
  listTemplateBranches,
  listUserTools,
  postAgentDigest,
  promotePreviewToProduction,
  resolveWorkerBaseUrl,
  runScheduleNow,
  searchOpenToolRecipes,
  startAppLifecycle,
  startAppSchedules,
  stopAppSchedules,
  stopCurrentAppSchedules,
  submitPositionsTx,
} from "./api.js";
export {
  DEFAULT_OPENPOND_API_BASE_URL,
  DEFAULT_OPENPOND_CHAT_API_BASE_URL,
  DEFAULT_OPENPOND_OPCHAT_API_BASE_URL,
  DEFAULT_OPENPOND_WEB_BASE_URL,
} from "./urls.js";
export {
  getOpChatModel,
  getOpChatProvider,
  listOpChatModels,
  listOpChatProviders,
  listHostedModels,
  listHostedProviders,
  resolveHostedChatApiBaseUrl,
  resolveOpChatApiBaseUrl,
  sendHostedChatTurn,
  streamHostedChatTurn,
} from "./hosted-chat.js";
export { runOpChatSmoke } from "./opchat-smoke.js";
export {
  computeAtr,
  computeBollinger,
  computeEma,
  computeEmaSeries,
  computeMacd,
  computeMaCross,
  computePriceChange,
  computeRsi,
  computeSma,
  computeSmaSeries,
} from "./indicators.js";
export {
  DEFAULT_CACHE_TTL_MS,
  getCachedApps,
  getCachedTools,
  setCachedApps,
  setCachedTools,
} from "./cache.js";
export {
  getConfigPath,
  listConfiguredProfiles,
  loadConfig,
  loadGlobalConfig,
  saveConfig,
  saveGlobalConfig,
  saveProfileApiKey,
  setActiveProfile,
} from "./config.js";
export type {
  ActiveProfileSelector,
  ConfiguredProfile,
  SaveProfileApiKeyInput,
  SetActiveProfileOptions,
} from "./config.js";
export { consumeStream, formatStreamItem, normalizeDataFrames } from "./stream.js";

export type {
  OpenPondClientOptions,
  ToolSummary,
  ToolListResult,
  DeploymentWatchResult,
  AgentCreateStreamCallbacks,
  AgentCreateStreamResult,
  OpenPondClient,
  ToolListOptions,
  ToolRunOptions,
  DeployWatchOptions,
  TemplateTargetOptions,
  TemplateUpdateOptions,
  AppsListOptions,
  AppsToolsOptions,
  AppsPerformanceOptions,
  AppSummaryOptions,
  AppSchedulesOptions,
  AppSchedulesStartOptions,
  AppSchedulesStopOptions,
  ScheduleRunNowOptions,
  ScheduleDeleteOptions,
  ScheduleExecutionLogsOptions,
  ScheduleExecutionLogOptions,
  DeploymentScheduleExecutionLogsOptions,
  AppExecutionTimelineOptions,
  AppsAssistantRunOptions,
  ExecuteUserToolOptions,
  AppEnvironmentSetOptions,
  AppEnvironmentGetOptions,
  AppDeployOptions,
  AppPromotePreviewOptions,
  AppStartOptions,
  PositionsTxOptions,
} from "./client-types.js";
import type {
  OpenPondClientOptions,
  ToolSummary,
  ToolListResult,
  DeploymentWatchResult,
  AgentCreateStreamCallbacks,
  AgentCreateStreamResult,
  OpenPondClient,
  ToolListOptions,
  ToolRunOptions,
  DeployWatchOptions,
  TemplateTargetOptions,
  TemplateUpdateOptions,
  AppsListOptions,
  AppsToolsOptions,
  AppsPerformanceOptions,
  AppSummaryOptions,
  AppSchedulesOptions,
  AppSchedulesStartOptions,
  AppSchedulesStopOptions,
  ScheduleRunNowOptions,
  ScheduleDeleteOptions,
  ScheduleExecutionLogsOptions,
  ScheduleExecutionLogOptions,
  DeploymentScheduleExecutionLogsOptions,
  AppExecutionTimelineOptions,
  AppsAssistantRunOptions,
  ExecuteUserToolOptions,
  AppEnvironmentSetOptions,
  AppEnvironmentGetOptions,
  AppDeployOptions,
  AppPromotePreviewOptions,
  AppStartOptions,
  PositionsTxOptions,
} from "./client-types.js";
function resolveUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function resolveBaseUrl(options: OpenPondClientOptions): string {
  const envBase = process.env.OPENPOND_BASE_URL;
  const base = options.baseUrl || envBase || DEFAULT_OPENPOND_WEB_BASE_URL;
  return resolveUrl(base.trim());
}

function resolveApiUrl(options: OpenPondClientOptions): string {
  const envBase = process.env.OPENPOND_API_URL;
  const base = options.apiUrl || envBase || DEFAULT_OPENPOND_API_BASE_URL;
  return resolveUrl(base.trim());
}

function resolveChatApiUrl(
  options: OpenPondClientOptions,
  apiUrl: string
): string {
  return resolveOpChatApiBaseUrl({
    apiBaseUrl: apiUrl,
    opChatApiBaseUrl: options.opChatApiUrl,
    chatApiBaseUrl: options.chatApiUrl,
  });
}

function resolveToolUrl(
  options: OpenPondClientOptions,
  baseUrl: string
): string {
  const envBase = process.env.OPENPOND_TOOL_URL;
  const base = options.toolUrl || envBase || baseUrl;
  return resolveUrl(base.trim());
}

function resolveApiKey(options: OpenPondClientOptions): string {
  const explicit = options.apiKey?.trim();
  if (explicit) return explicit;
  const envKey = process.env.OPENPOND_API_KEY?.trim();
  if (envKey) return envKey;
  throw new Error("OPENPOND_API_KEY is required");
}

function parseHandleRepo(value: string): { handle: string; repo: string } {
  const parts = value.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error("expected <handle>/<repo>");
  }
  return { handle: parts[0]!, repo: parts[1]! };
}

function normalizeRepoName(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function normalizeToolSummary(tool: unknown): ToolSummary {
  if (!tool || typeof tool !== "object") {
    return { name: "unknown", raw: tool };
  }
  const record = tool as Record<string, unknown>;
  const profile = (record.profile || record.function) as
    | Record<string, unknown>
    | undefined;
  const name =
    typeof record.name === "string"
      ? record.name
      : typeof profile?.name === "string"
      ? profile.name
      : "unknown";
  const description =
    typeof record.description === "string"
      ? record.description
      : typeof profile?.description === "string"
      ? profile.description
      : undefined;
  return { name, description, raw: tool };
}

function extractDeploymentTools(detail: DeploymentDetail | null): unknown[] {
  if (!detail) return [];
  if (Array.isArray(detail.toolsJson)) {
    return detail.toolsJson;
  }
  if (detail.metadataJson && typeof detail.metadataJson === "object") {
    const metadataTools = (detail.metadataJson as { tools?: unknown }).tools;
    if (Array.isArray(metadataTools)) {
      return metadataTools;
    }
  }
  return [];
}

async function resolveAppTarget(params: {
  apiBase: string;
  apiKey: string;
  target: string;
  useCache: boolean;
  cacheTtlMs: number;
  forceRefresh?: boolean;
}): Promise<{ app: AppListItem; handle: string; repo: string }> {
  const { handle, repo } = parseHandleRepo(params.target);
  const apps = await fetchAppsWithCache({
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    useCache: params.useCache,
    cacheTtlMs: params.cacheTtlMs,
    forceRefresh: params.forceRefresh,
  });
  const normalizedRepo = normalizeRepoName(repo);
  const match = apps.find((app) => {
    if (app.handle && app.handle !== handle) {
      return false;
    }
    const candidates = [app.repo, app.gitRepo, app.id].map(normalizeRepoName);
    return candidates.includes(normalizedRepo);
  });
  if (!match) {
    throw new Error(`app not found for ${handle}/${repo}`);
  }
  return { app: match, handle, repo };
}

async function fetchAppsWithCache(params: {
  apiBase: string;
  apiKey: string;
  useCache: boolean;
  cacheTtlMs: number;
  forceRefresh?: boolean;
}): Promise<AppListItem[]> {
  if (params.useCache && !params.forceRefresh) {
    const cached = await getCachedApps({
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      ttlMs: params.cacheTtlMs,
    });
    if (cached) {
      return cached;
    }
  }
  const apps = await listApps(params.apiBase, params.apiKey);
  if (params.useCache) {
    await setCachedApps({
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      apps,
    });
  }
  return apps;
}

async function fetchToolsWithCache(params: {
  apiBase: string;
  apiKey: string;
  useCache: boolean;
  cacheTtlMs: number;
  forceRefresh?: boolean;
}): Promise<unknown[]> {
  if (params.useCache && !params.forceRefresh) {
    const cached = await getCachedTools({
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      ttlMs: params.cacheTtlMs,
    });
    if (cached) {
      return cached;
    }
  }
  const result = await listUserTools(params.apiBase, params.apiKey);
  const tools = Array.isArray(result.tools) ? result.tools : [];
  if (params.useCache) {
    await setCachedTools({
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      tools,
    });
  }
  return tools;
}

function normalizeMethod(
  method?: ToolExecuteRequest["method"]
): NonNullable<ToolExecuteRequest["method"]> {
  if (!method) return "POST";
  const upper = method.toUpperCase();
  switch (upper) {
    case "GET":
    case "POST":
    case "PUT":
    case "DELETE":
      return upper;
    default:
      throw new Error("method must be GET, POST, PUT, or DELETE");
  }
}

export async function consumeAgentCreateStream(
  response: Response,
  callbacks?: AgentCreateStreamCallbacks
): Promise<AgentCreateStreamResult> {
  let conversationId: string | undefined;
  let appId: string | undefined;
  let deploymentId: string | undefined;

  await consumeStream(response, {
    ...callbacks,
    onConversationId: (id) => {
      conversationId = id;
      callbacks?.onConversationId?.(id);
    },
    onItems: (items) => {
      for (const item of items) {
        const typed = item as Record<string, unknown>;
        if (!appId && typeof typed.appId === "string") {
          appId = typed.appId;
          callbacks?.onAppId?.(typed.appId);
        }
        if (!deploymentId && typeof typed.deploymentId === "string") {
          deploymentId = typed.deploymentId;
          callbacks?.onDeploymentId?.(typed.deploymentId);
        }
      }
      callbacks?.onItems?.(items);
    },
  });

  return { conversationId, appId, deploymentId };
}

export function createClient(options: OpenPondClientOptions): OpenPondClient {
  const apiKey = resolveApiKey(options);
  const baseUrl = resolveBaseUrl(options);
  const apiUrl = resolveApiUrl(options);
  const chatApiUrl = resolveChatApiUrl(options, apiUrl);
  const toolUrl = resolveToolUrl(options, baseUrl);
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const useCache = options.useCache !== false;

  const refreshCache = async (): Promise<void> => {
    if (!useCache) return;
    await Promise.all([
      fetchAppsWithCache({
        apiBase: apiUrl,
        apiKey,
        useCache,
        cacheTtlMs,
        forceRefresh: true,
      }),
      fetchToolsWithCache({
        apiBase: apiUrl,
        apiKey,
        useCache,
        cacheTtlMs,
        forceRefresh: true,
      }),
    ]);
  };

  const resolveLatestDeploymentId = async (
    appId: string,
    branch?: string
  ): Promise<string | null> => {
    const latest = await getLatestDeploymentForApp(apiUrl, apiKey, appId, {
      branch,
    });
    return latest?.id ?? null;
  };

  return {
    baseUrl,
    apiUrl,
    chatApiUrl,
    toolUrl,
    apiKey,
    account: {
      get: async () => getOpenPondAccount(apiUrl, apiKey),
      balance: async () => getOpenPondAccountBalance(apiUrl, apiKey),
      health: async () => checkOpenPondApiHealth(apiUrl, apiKey),
    },
    chat: {
      providers: async () =>
        listOpChatProviders({ apiBaseUrl: chatApiUrl, token: apiKey }),
      provider: async (provider) =>
        getOpChatProvider({ apiBaseUrl: chatApiUrl, token: apiKey, provider }),
      models: async () =>
        listOpChatModels({ apiBaseUrl: chatApiUrl, token: apiKey }),
      model: async (model) =>
        getOpChatModel({ apiBaseUrl: chatApiUrl, token: apiKey, model }),
      send: async (input) =>
        sendHostedChatTurn({ ...input, apiBaseUrl: chatApiUrl, token: apiKey }),
      stream: (input) =>
        streamHostedChatTurn({
          ...input,
          apiBaseUrl: chatApiUrl,
          token: apiKey,
        }),
    },
    tool: {
      list: async (target, options) => {
        const { app } = await resolveAppTarget({
          apiBase: apiUrl,
          apiKey,
          target,
          useCache,
          cacheTtlMs,
          forceRefresh: options?.forceRefresh,
        });
        const deploymentId =
          options?.deploymentId ||
          (await resolveLatestDeploymentId(app.id, options?.branch));
        if (!deploymentId) {
          return { app, deploymentId: null, tools: [] };
        }
        const detail = await getDeploymentDetail(apiUrl, apiKey, deploymentId);
        const rawTools = extractDeploymentTools(detail);
        const tools = rawTools.map(normalizeToolSummary);
        return { app, deploymentId, tools };
      },
      run: async (target, toolName, options) => {
        const { app } = await resolveAppTarget({
          apiBase: apiUrl,
          apiKey,
          target,
          useCache,
          cacheTtlMs,
          forceRefresh: options?.forceRefresh,
        });
        const deploymentId =
          options?.deploymentId ||
          (await resolveLatestDeploymentId(app.id, options?.branch));
        if (!deploymentId) {
          throw new Error("no deployments found");
        }
        const method = normalizeMethod(options?.method);
        return executeHostedTool(toolUrl, apiKey, {
          appId: app.id,
          deploymentId,
          toolName,
          method,
          body: options?.body,
          headers: options?.headers,
        });
      },
    },
    deploy: {
      watch: async (target, options) => {
        const { app } = await resolveAppTarget({
          apiBase: apiUrl,
          apiKey,
          target,
          useCache,
          cacheTtlMs,
          forceRefresh: options?.forceRefresh,
        });
        const deploymentId =
          options?.deploymentId ||
          (await resolveLatestDeploymentId(app.id, options?.branch));
        if (!deploymentId) {
          throw new Error("no deployments found");
        }
        const intervalMs = options?.intervalMs ?? 5000;
        const timeoutMs = options?.timeoutMs ?? 4 * 60 * 1000;
        const logs: DeploymentLogEntry[] = [];
        const seen = new Set<string>();
        const startedAt = Date.now();
        let status: string | null = null;

        while (Date.now() - startedAt < timeoutMs) {
          const batch = await getDeploymentLogs(apiUrl, apiKey, deploymentId);
          for (const log of batch) {
            if (seen.has(log.id)) continue;
            seen.add(log.id);
            logs.push(log);
            options?.onLog?.(log);
          }
          const statusResponse = await getDeploymentStatus(
            apiUrl,
            apiKey,
            deploymentId
          );
          status = statusResponse.status ?? null;
          options?.onStatus?.(status);
          if (status === "failed") {
            return { deploymentId, status, logs };
          }
          if (status === "running" || status === "deployed") {
            return { deploymentId, status, logs };
          }
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        return { deploymentId, status: "timeout", logs };
      },
    },
    template: {
      status: async (target, options) => {
        const { app } = await resolveAppTarget({
          apiBase: apiUrl,
          apiKey,
          target,
          useCache,
          cacheTtlMs,
          forceRefresh: options?.forceRefresh,
        });
        return getTemplateStatus(apiUrl, apiKey, app.id);
      },
      branches: async (target, options) => {
        const { app } = await resolveAppTarget({
          apiBase: apiUrl,
          apiKey,
          target,
          useCache,
          cacheTtlMs,
          forceRefresh: options?.forceRefresh,
        });
        return listTemplateBranches(apiUrl, apiKey, app.id);
      },
      update: async (target, options) => {
        const { app } = await resolveAppTarget({
          apiBase: apiUrl,
          apiKey,
          target,
          useCache,
          cacheTtlMs,
          forceRefresh: options?.forceRefresh,
        });
        const environment =
          options?.environment === "preview" ? "preview" : "production";
        return deployLatestTemplate(apiUrl, apiKey, app.id, { environment });
      },
    },
    opentool: {
      recipesList: async (input = {}) =>
        listOpenToolRecipes(apiUrl, apiKey, input),
      recipesSearch: async (input) =>
        searchOpenToolRecipes(apiUrl, apiKey, input),
      recipeGet: async (input) => getOpenToolRecipe(apiUrl, apiKey, input),
      rulesGet: async (input) => getOpenToolRules(apiUrl, apiKey, input),
    },
    apps: {
      list: async (options) => {
        const apps = await fetchAppsWithCache({
          apiBase: apiUrl,
          apiKey,
          useCache,
          cacheTtlMs,
          forceRefresh: options?.forceRefresh,
        });
        if (!options?.handle) return apps;
        return apps.filter((app) => app.handle === options.handle);
      },
      tools: async (options) => {
        return fetchToolsWithCache({
          apiBase: apiUrl,
          apiKey,
          useCache,
          cacheTtlMs,
          forceRefresh: options?.forceRefresh,
        });
      },
      performance: async (options) => {
        return getUserPerformance(apiUrl, apiKey, { appId: options?.appId });
      },
      summary: async (input) => {
        return getAppRuntimeSummary(apiUrl, apiKey, input.appId);
      },
      schedules: async (input) => {
        return listAppSchedules(apiUrl, apiKey, input.appId);
      },
      schedulesStart: async (input) => {
        const { appId, ...rest } = input;
        return startAppSchedules(apiUrl, apiKey, appId, rest);
      },
      schedulesStop: async (input) => {
        return stopAppSchedules(apiUrl, apiKey, input.appId);
      },
      schedulesStopCurrent: async () => {
        return stopCurrentAppSchedules(apiUrl, apiKey);
      },
      scheduleRunNow: async (input) => {
        return runScheduleNow(apiUrl, apiKey, input);
      },
      scheduleDelete: async (input) => {
        return deleteOrArchiveSchedule(
          apiUrl,
          apiKey,
          input.appId,
          input.scheduleId
        );
      },
      scheduleExecutionLogs: async (input) => {
        return listScheduleExecutionLogs(apiUrl, apiKey, input.scheduleId, {
          limit: input.limit,
        });
      },
      scheduleExecutionLog: async (input) => {
        return getScheduleExecutionLog(apiUrl, apiKey, input.runId);
      },
      deploymentScheduleExecutionLogs: async (input) => {
        return listDeploymentScheduleExecutionLogs(
          apiUrl,
          apiKey,
          input.deploymentId,
          {
            limit: input.limit,
          }
        );
      },
      executionTimeline: async (input) => {
        return getAppExecutionTimeline(apiUrl, apiKey, input.appId, {
          limit: input.limit,
        });
      },
      assistantRun: async (input) => {
        return runAssistantMode(apiUrl, apiKey, input);
      },
      agentCreate: async (input, callbacks) => {
        const { refreshCache: refreshCacheFlag, ...rest } = input;
        const payload: AgentCreateRequest = {
          ...rest,
          streamDeployLogs: rest.streamDeployLogs ?? true,
        };
        const response = await createAgentFromPrompt(apiUrl, apiKey, payload);
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`agent create failed: ${response.status} ${text}`);
        }
        const result = await consumeAgentCreateStream(response, callbacks);
        if (useCache && refreshCacheFlag !== false) {
          try {
            await refreshCache();
          } catch {
            // keep agent creation result even if cache refresh fails
          }
        }
        return result;
      },
      toolsExecute: async (input) => {
        return executeUserTool(apiUrl, apiKey, input);
      },
      deploy: async (input) => {
        return deployApp(apiUrl, apiKey, input.appId, {
          environment: input.environment,
          commitSha: input.commitSha,
          branch: input.branch,
        });
      },
      startApp: async (input) => {
        const { appId, ...rest } = input;
        return startAppLifecycle(apiUrl, apiKey, appId, rest);
      },
      promotePreview: async (input) => {
        const { appId, ...rest } = input;
        return promotePreviewToProduction(apiUrl, apiKey, appId, rest);
      },
      envGet: async (input) => {
        return getAppEnvironment(apiUrl, apiKey, input.appId);
      },
      envSet: async (input) => {
        return updateAppEnvironment(apiUrl, apiKey, input.appId, {
          envVars: input.envVars,
        });
      },
      positionsTx: async (input) => {
        const method = input?.method ?? "POST";
        if (method !== "GET" && method !== "POST") {
          throw new Error("method must be GET or POST");
        }
        let query = input?.query;
        if (!query && input?.params) {
          query = {};
          for (const [key, value] of Object.entries(input.params)) {
            if (value === undefined) continue;
            query[key] =
              typeof value === "string" ? value : JSON.stringify(value);
          }
        }
        return submitPositionsTx(apiUrl, apiKey, {
          method,
          body: method === "POST" ? input?.body : undefined,
          query,
        });
      },
    },
    repo: {
      create: async (input) => {
        const { refreshCache: refreshCacheFlag, ...rest } = input;
        const result = await createRepo(apiUrl, apiKey, rest);
        if (useCache && refreshCacheFlag !== false) {
          try {
            await refreshCache();
          } catch {
            // keep repo result even if cache refresh fails
          }
        }
        return result;
      },
    },
    cache: {
      refresh: refreshCache,
    },
  };
}
