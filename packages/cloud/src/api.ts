import { apiFetch, LONG_STREAM_API_OPTIONS, readApiJson } from "./api/core.js";
import type {
  AgentCreateRequest,
  AppCodeVisibilityUpdateResponse,
  AppEnvironmentGetResponse,
  AppEnvironmentUpdateRequest,
  AppEnvironmentUpdateResponse,
  AppExecutionTimelineResponse,
  AppListItem,
  AppRuntimeSummary,
  AppSchedulesResponse,
  AssistantRunRequest,
  AssistantRunResponse,
  BacktestRunRequest,
  CreateLocalProjectInput,
  CreateRepoRequest,
  CreateRepoResponse,
  HeadlessAppRequest,
  HeadlessAppsResponse,
  OpenPondAccount,
  OpenPondAccountBalanceResponse,
  OpenPondAccountResponse,
  OpenPondApiHealth,
  OpenPondApiHealthResponse,
  OpenToolRecipe,
  OpenToolRecipeGetRequest,
  OpenToolRecipeListRequest,
  OpenToolRecipeListResponse,
  OpenToolRecipeSearchRequest,
  OpenToolRecipeSearchResponse,
  OpenToolRulesGetRequest,
  OpenToolRulesGetResponse,
  ScheduleDeleteResponse,
  ScheduleExecutionLog,
  ScheduleExecutionLogsResponse,
  ScheduleRunNowRequest,
  ScheduleRunNowResponse,
  ScheduleToggleRequest,
  ScheduleToggleResult,
  TemplateBranchesResponse,
  TemplateDeployLatestRequest,
  TemplateDeployLatestResponse,
  TemplateStatusResponse,
  ToolExecuteRequest,
  ToolExecuteResponse,
  ToolManifest,
} from "./api/types.js";
import type { ChatRequestBody } from "./types.js";
import {
  DEFAULT_OPENPOND_API_BASE_URL,
  DEFAULT_OPENPOND_WEB_BASE_URL,
} from "./urls.js";
export { apiFetch } from "./api/core.js";
export {
  commitFiles,
  deployApp,
  getDeploymentDetail,
  getDeploymentLogs,
  getDeploymentStatus,
  getLatestDeploymentForApp,
  promotePreviewToProduction,
  startAppLifecycle,
} from "./api/deployments.js";
export type {
  AgentCreateRequest,
  AppCodeVisibilityUpdateResponse,
  AppEnvironmentGetResponse,
  AppEnvironmentUpdateRequest,
  AppEnvironmentUpdateResponse,
  AppExecutionDeployment,
  AppExecutionTimelineResponse,
  AppExecutionToolRun,
  AppListItem,
  AppRuntimeSummary,
  AppSchedule,
  AppSchedulesResponse,
  AppScheduleSummary,
  AssistantMode,
  AssistantRunRequest,
  AssistantRunResponse,
  BacktestRunRequest,
  CreateLocalProjectInput,
  CreateRepoRequest,
  CreateRepoResponse,
  DeploymentDetail,
  DeploymentLogEntry,
  HeadlessAppRequest,
  HeadlessAppResponse,
  HeadlessAppsResponse,
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
  ScheduleExecutionStatus,
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
  ToolManifest,
} from "./api/types.js";

const DEFAULT_OPENPOND_API_HOST = new URL(DEFAULT_OPENPOND_API_BASE_URL)
  .hostname;
const DEFAULT_OPENPOND_WEB_HOST = new URL(DEFAULT_OPENPOND_WEB_BASE_URL)
  .hostname;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1] || "";
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "="
  );
  try {
    const json = Buffer.from(padded, "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function listApps(
  apiBase: string,
  token: string,
  options?: {
    handle?: string;
    limit?: number;
    offset?: number;
    includeScheduled?: boolean;
  }
): Promise<AppListItem[]> {
  const params = new URLSearchParams();
  if (options?.handle) {
    params.set("handle", options.handle);
  }
  if (typeof options?.limit === "number" && Number.isFinite(options.limit)) {
    params.set("limit", String(Math.max(1, Math.floor(options.limit))));
  }
  if (typeof options?.offset === "number" && Number.isFinite(options.offset)) {
    params.set("offset", String(Math.max(0, Math.floor(options.offset))));
  }
  if (typeof options?.includeScheduled === "boolean") {
    params.set("includeScheduled", options.includeScheduled ? "true" : "false");
  }
  const query = params.toString();
  const response = await apiFetch(
    apiBase,
    token,
    `/apps/list${query ? `?${query}` : ""}`,
    { method: "GET" }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Apps list failed: ${response.status} ${text}`);
  }
  const payload = (await response.json().catch(() => ({}))) as {
    apps?: AppListItem[];
  };
  return Array.isArray(payload.apps) ? payload.apps : [];
}

export async function createLocalProject(
  baseUrl: string,
  token: string,
  input: CreateLocalProjectInput
): Promise<{ appId: string }> {
  const response = await apiFetch(baseUrl, token, "/api/projects/local", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Create project failed: ${response.status} ${text}`);
  }
  return (await response.json()) as { appId: string };
}

export async function createRepo(
  apiBase: string,
  apiKey: string,
  input: CreateRepoRequest
): Promise<CreateRepoResponse> {
  const response = await apiFetch(apiBase, apiKey, "/apps/repo/create", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Repo create failed: ${response.status} ${text}`);
  }
  return (await response.json()) as CreateRepoResponse;
}

export async function updateAppCodeVisibility(
  apiBase: string,
  apiKey: string,
  appId: string,
  codeVisibility: "public" | "private"
): Promise<AppCodeVisibilityUpdateResponse> {
  const response = await apiFetch(
    apiBase,
    apiKey,
    `/apps/${encodeURIComponent(appId)}/code-visibility`,
    {
      method: "PATCH",
      body: JSON.stringify({ codeVisibility }),
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Code visibility update failed: ${response.status} ${text}`
    );
  }
  return (await response.json()) as AppCodeVisibilityUpdateResponse;
}

export async function createHeadlessApps(
  baseUrl: string,
  token: string,
  items: HeadlessAppRequest[],
  teamId?: string
): Promise<HeadlessAppsResponse> {
  const response = await apiFetch(baseUrl, token, "/v4/apps/headless", {
    method: "POST",
    body: JSON.stringify({ items, ...(teamId ? { teamId } : {}) }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Headless create failed: ${response.status} ${text}`);
  }
  return (await response.json()) as HeadlessAppsResponse;
}

export async function getTemplateStatus(
  apiBase: string,
  token: string,
  appId: string
): Promise<TemplateStatusResponse> {
  const response = await apiFetch(
    apiBase,
    token,
    `/v4/apps/${appId}/template/status`,
    { method: "GET" }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Template status failed: ${response.status} ${text}`);
  }
  return (await response.json()) as TemplateStatusResponse;
}

export async function listTemplateBranches(
  apiBase: string,
  token: string,
  appId: string
): Promise<TemplateBranchesResponse> {
  const response = await apiFetch(
    apiBase,
    token,
    `/v4/apps/${appId}/template/branches`,
    { method: "GET" }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Template branches failed: ${response.status} ${text}`);
  }
  return (await response.json()) as TemplateBranchesResponse;
}

export async function deployLatestTemplate(
  apiBase: string,
  token: string,
  appId: string,
  input: TemplateDeployLatestRequest
): Promise<TemplateDeployLatestResponse> {
  const response = await apiFetch(
    apiBase,
    token,
    `/v4/apps/${appId}/template/deploy-latest`,
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Template deploy failed: ${response.status} ${text}`);
  }
  return (await response.json()) as TemplateDeployLatestResponse;
}

export async function updateAppEnvironment(
  apiBase: string,
  token: string,
  appId: string,
  input: AppEnvironmentUpdateRequest
): Promise<AppEnvironmentUpdateResponse> {
  const response = await apiFetch(
    apiBase,
    token,
    `/v4/apps/${appId}/environment`,
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Environment update failed: ${response.status} ${text}`);
  }
  return (await response.json()) as AppEnvironmentUpdateResponse;
}

export async function getAppEnvironment(
  apiBase: string,
  token: string,
  appId: string
): Promise<AppEnvironmentGetResponse> {
  const response = await apiFetch(
    apiBase,
    token,
    `/v4/apps/${appId}/environment`,
    {
      method: "GET",
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Environment get failed: ${response.status} ${text}`);
  }
  return (await response.json()) as AppEnvironmentGetResponse;
}

export async function fetchToolManifest(
  baseUrl: string,
  token: string
): Promise<ToolManifest> {
  const response = await apiFetch(baseUrl, token, "/api/tools/manifest", {
    method: "GET",
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Manifest fetch failed: ${response.status} ${text}`);
  }
  return (await response.json()) as ToolManifest;
}

export async function listUserTools(
  baseUrl: string,
  token: string
): Promise<{ tools?: unknown[] }> {
  const response = await apiFetch(baseUrl, token, "/apps/tools", {
    method: "GET",
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Tools lookup failed: ${response.status} ${text}`);
  }
  return (await response.json()) as { tools?: unknown[] };
}

export async function listAppSchedules(
  baseUrl: string,
  token: string,
  appId: string
): Promise<AppSchedulesResponse> {
  const response = await apiFetch(
    baseUrl,
    token,
    `/apps/${encodeURIComponent(appId)}/schedules`,
    { method: "GET" }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Schedules lookup failed: ${response.status} ${text}`);
  }
  const payload = (await response
    .json()
    .catch(() => ({}))) as Partial<AppSchedulesResponse>;
  return {
    schedules: Array.isArray(payload.schedules) ? payload.schedules : [],
  };
}

export async function listOpenToolRecipes(
  baseUrl: string,
  token: string,
  input: OpenToolRecipeListRequest = {}
): Promise<OpenToolRecipeListResponse> {
  const params = new URLSearchParams();
  if (input.domain) params.set("domain", input.domain);
  if (input.opentoolVersion)
    params.set("opentoolVersion", input.opentoolVersion);
  if (typeof input.limit === "number") params.set("limit", String(input.limit));
  for (const tag of input.tags ?? []) params.append("tag", tag);
  const query = params.toString();
  const response = await apiFetch(
    baseUrl,
    token,
    `/v1/opentool/recipes${query ? `?${query}` : ""}`,
    {
      method: "GET",
    }
  );
  return readApiJson<OpenToolRecipeListResponse>(
    response,
    "OpenTool recipe list"
  );
}

export async function searchOpenToolRecipes(
  baseUrl: string,
  token: string,
  input: OpenToolRecipeSearchRequest
): Promise<OpenToolRecipeSearchResponse> {
  const response = await apiFetch(
    baseUrl,
    token,
    "/v1/opentool/recipes/search",
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
  return readApiJson<OpenToolRecipeSearchResponse>(
    response,
    "OpenTool recipe search"
  );
}

export async function getOpenToolRecipe(
  baseUrl: string,
  token: string,
  input: OpenToolRecipeGetRequest
): Promise<OpenToolRecipe> {
  const params = new URLSearchParams();
  if (typeof input.includeExamples === "boolean")
    params.set("includeExamples", String(input.includeExamples));
  if (typeof input.includeTests === "boolean")
    params.set("includeTests", String(input.includeTests));
  if (input.opentoolVersion)
    params.set("opentoolVersion", input.opentoolVersion);
  const query = params.toString();
  const response = await apiFetch(
    baseUrl,
    token,
    `/v1/opentool/recipes/${encodeURIComponent(input.id)}${
      query ? `?${query}` : ""
    }`,
    { method: "GET" }
  );
  return readApiJson<OpenToolRecipe>(response, "OpenTool recipe get");
}

export async function getOpenToolRules(
  baseUrl: string,
  token: string,
  input: OpenToolRulesGetRequest
): Promise<OpenToolRulesGetResponse> {
  const response = await apiFetch(baseUrl, token, "/v1/opentool/rules", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return readApiJson<OpenToolRulesGetResponse>(response, "OpenTool rules get");
}

function buildLimitQuery(limit?: number): string {
  const params = new URLSearchParams();
  if (typeof limit === "number" && Number.isFinite(limit)) {
    params.set("limit", String(Math.max(1, Math.floor(limit))));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function normalizeScheduleExecutionLogs(
  payload: unknown
): ScheduleExecutionLog[] {
  if (Array.isArray(payload)) {
    return payload as ScheduleExecutionLog[];
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const record = payload as {
    logs?: unknown;
    runs?: unknown;
    scheduleRuns?: unknown;
    items?: unknown;
  };
  if (Array.isArray(record.logs)) {
    return record.logs as ScheduleExecutionLog[];
  }
  if (Array.isArray(record.runs)) {
    return record.runs as ScheduleExecutionLog[];
  }
  if (Array.isArray(record.scheduleRuns)) {
    return record.scheduleRuns as ScheduleExecutionLog[];
  }
  if (Array.isArray(record.items)) {
    return record.items as ScheduleExecutionLog[];
  }
  return [];
}

export async function startAppSchedules(
  baseUrl: string,
  token: string,
  appId: string,
  input?: ScheduleToggleRequest
): Promise<ScheduleToggleResult> {
  const body = {
    ...(input?.preferredScheduleId
      ? { preferredScheduleId: input.preferredScheduleId }
      : {}),
    ...(input?.scheduleId ? { scheduleId: input.scheduleId } : {}),
    ...(input?.startAt ? { startAt: input.startAt } : {}),
    ...(input && "endAt" in input ? { endAt: input.endAt ?? null } : {}),
  };
  const response = await apiFetch(
    baseUrl,
    token,
    `/apps/${encodeURIComponent(appId)}/schedules/start`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
  return readApiJson<ScheduleToggleResult>(response, "Schedule start");
}

export async function stopAppSchedules(
  baseUrl: string,
  token: string,
  appId: string
): Promise<ScheduleToggleResult> {
  const response = await apiFetch(
    baseUrl,
    token,
    `/apps/${encodeURIComponent(appId)}/schedules/stop`,
    {
      method: "POST",
      body: JSON.stringify({}),
    }
  );
  return readApiJson<ScheduleToggleResult>(response, "Schedule stop");
}

export async function stopCurrentAppSchedules(
  baseUrl: string,
  token: string
): Promise<ScheduleToggleResult> {
  const response = await apiFetch(
    baseUrl,
    token,
    "/apps/schedules/current/stop",
    {
      method: "POST",
      body: JSON.stringify({}),
    }
  );
  return readApiJson<ScheduleToggleResult>(response, "Current schedule stop");
}

export async function runScheduleNow(
  baseUrl: string,
  token: string,
  input: ScheduleRunNowRequest
): Promise<ScheduleRunNowResponse> {
  const response = await apiFetch(baseUrl, token, "/v1/schedules/run", {
    method: "POST",
    body: JSON.stringify({ scheduleId: input.scheduleId }),
  });
  return readApiJson<ScheduleRunNowResponse>(response, "Schedule run");
}

export async function deleteOrArchiveSchedule(
  baseUrl: string,
  token: string,
  appId: string,
  scheduleId: string
): Promise<ScheduleDeleteResponse> {
  const response = await apiFetch(
    baseUrl,
    token,
    `/apps/${encodeURIComponent(appId)}/schedules/${encodeURIComponent(
      scheduleId
    )}`,
    { method: "DELETE" }
  );
  return readApiJson<ScheduleDeleteResponse>(response, "Schedule delete");
}

export async function listScheduleExecutionLogs(
  baseUrl: string,
  token: string,
  scheduleId: string,
  options?: { limit?: number }
): Promise<ScheduleExecutionLogsResponse> {
  const response = await apiFetch(
    baseUrl,
    token,
    `/v1/schedules/${encodeURIComponent(
      scheduleId
    )}/execution-logs${buildLimitQuery(options?.limit)}`,
    { method: "GET" }
  );
  const payload = await readApiJson<unknown>(
    response,
    "Schedule execution logs"
  );
  return { logs: normalizeScheduleExecutionLogs(payload) };
}

export async function listDeploymentScheduleExecutionLogs(
  baseUrl: string,
  token: string,
  deploymentId: string,
  options?: { limit?: number }
): Promise<ScheduleExecutionLogsResponse> {
  const response = await apiFetch(
    baseUrl,
    token,
    `/v1/deployments/${encodeURIComponent(
      deploymentId
    )}/schedule-execution-logs${buildLimitQuery(options?.limit)}`,
    { method: "GET" }
  );
  const payload = await readApiJson<unknown>(
    response,
    "Deployment schedule execution logs"
  );
  return { logs: normalizeScheduleExecutionLogs(payload) };
}

export async function getScheduleExecutionLog(
  baseUrl: string,
  token: string,
  runId: string
): Promise<ScheduleExecutionLog> {
  const response = await apiFetch(
    baseUrl,
    token,
    `/v1/schedule-execution-logs/${encodeURIComponent(runId)}`,
    { method: "GET" }
  );
  return readApiJson<ScheduleExecutionLog>(response, "Schedule execution log");
}

export async function getAppExecutionTimeline(
  baseUrl: string,
  token: string,
  appId: string,
  options?: { limit?: number }
): Promise<AppExecutionTimelineResponse> {
  const response = await apiFetch(
    baseUrl,
    token,
    `/v1/apps/${encodeURIComponent(appId)}/execution-timeline${buildLimitQuery(
      options?.limit
    )}`,
    { method: "GET" }
  );
  return readApiJson<AppExecutionTimelineResponse>(
    response,
    "App execution timeline"
  );
}

export async function createAgentFromPrompt(
  baseUrl: string,
  token: string,
  payload: AgentCreateRequest
): Promise<Response> {
  return apiFetch(baseUrl, token, "/apps/agent/create", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getUserPerformance(
  baseUrl: string,
  token: string,
  options?: { appId?: string }
): Promise<unknown> {
  const params = new URLSearchParams();
  if (options?.appId) {
    params.set("appId", options.appId);
  }
  const qs = params.toString();
  const response = await apiFetch(
    baseUrl,
    token,
    `/apps/performance${qs ? `?${qs}` : ""}`,
    {
      method: "GET",
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Performance lookup failed: ${response.status} ${text}`);
  }
  return (await response.json()) as unknown;
}

export async function getAppRuntimeSummary(
  baseUrl: string,
  token: string,
  appId: string
): Promise<AppRuntimeSummary> {
  const params = new URLSearchParams({ appId });
  const response = await apiFetch(
    baseUrl,
    token,
    `/apps/summary?${params.toString()}`,
    {
      method: "GET",
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Summary lookup failed: ${response.status} ${text}`);
  }
  return (await response.json()) as AppRuntimeSummary;
}

export async function getOpenPondAccount(
  baseUrl: string,
  token: string
): Promise<OpenPondAccountResponse> {
  const response = await apiFetch(baseUrl, token, "/account", {
    method: "GET",
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Account lookup failed: ${response.status} ${text}`);
  }
  return (await response.json()) as OpenPondAccountResponse;
}

export async function getOpenPondAccountBalance(
  baseUrl: string,
  token: string
): Promise<OpenPondAccountBalanceResponse> {
  const response = await apiFetch(baseUrl, token, "/account/balance", {
    method: "GET",
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Account balance lookup failed: ${response.status} ${text}`
    );
  }
  return (await response.json()) as OpenPondAccountBalanceResponse;
}

export async function checkOpenPondApiHealth(
  baseUrl: string,
  token?: string | null
): Promise<OpenPondApiHealth> {
  const checkedAt = new Date().toISOString();
  const started = Date.now();
  const normalizedBase = baseUrl.replace(/\/$/, "");
  try {
    const response = await fetch(`${normalizedBase}/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const latencyMs = Date.now() - started;
    const payload = (await response
      .json()
      .catch(() => ({}))) as Partial<OpenPondApiHealthResponse>;
    let authenticated: boolean | null = null;
    let account: OpenPondAccount | null = null;

    if (token?.trim()) {
      try {
        const accountPayload = await getOpenPondAccount(normalizedBase, token);
        authenticated = true;
        account = accountPayload.account;
      } catch {
        authenticated = false;
      }
    }

    return {
      reachable: response.ok,
      authenticated,
      apiBase: normalizedBase,
      latencyMs,
      status: response.status,
      service: typeof payload.service === "string" ? payload.service : null,
      checkedAt,
      account,
      ...(response.ok
        ? {}
        : { error: response.statusText || `HTTP ${response.status}` }),
    };
  } catch (error) {
    return {
      reachable: false,
      authenticated: token?.trim() ? false : null,
      apiBase: normalizedBase,
      latencyMs: Date.now() - started,
      status: null,
      service: null,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runAssistantMode(
  baseUrl: string,
  token: string,
  payload: AssistantRunRequest
): Promise<AssistantRunResponse> {
  const response = await apiFetch(baseUrl, token, "/apps/assistant/run", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Assistant run failed: ${response.status} ${text}`);
  }
  return (await response.json()) as AssistantRunResponse;
}

export async function postAgentDigest(
  baseUrl: string,
  token: string,
  body: { content: string; runAt?: string; metadata?: Record<string, unknown> }
): Promise<unknown> {
  const response = await apiFetch(baseUrl, token, "/apps/agent/digest", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Agent digest failed: ${response.status} ${text}`);
  }
  return (await response.json()) as unknown;
}

export async function executeUserTool(
  baseUrl: string,
  token: string,
  body: {
    appId: string;
    deploymentId: string;
    toolName: string;
    scheduleId?: string;
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    headers?: Record<string, string>;
    notifyEmail?: boolean;
  }
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const response = await apiFetch(baseUrl, token, "/apps/tools/execute", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => "");
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error:
        payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error?: unknown }).error)
          : text || response.statusText,
    };
  }
  return {
    ok: true,
    status: response.status,
    data: payload,
  };
}

export async function submitPositionsTx(
  baseUrl: string,
  token: string,
  params: {
    method: "GET" | "POST";
    body?: unknown;
    query?: Record<string, string>;
  }
): Promise<unknown> {
  const qs =
    params.query && Object.keys(params.query).length > 0
      ? `?${new URLSearchParams(params.query).toString()}`
      : "";
  const response = await apiFetch(baseUrl, token, `/apps/positions/tx${qs}`, {
    method: params.method,
    body:
      params.method === "POST" && params.body !== undefined
        ? JSON.stringify(params.body)
        : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Positions request failed: ${response.status} ${text}`);
  }
  return (await response.json()) as unknown;
}

export async function submitBacktestRun(
  baseUrl: string,
  token: string,
  body: BacktestRunRequest
): Promise<unknown> {
  const response = await apiFetch(baseUrl, token, "/apps/backtests/run", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Backtest run failed: ${response.status} ${text}`);
  }
  return (await response.json()) as unknown;
}

export async function submitBacktestTx(
  baseUrl: string,
  token: string,
  params: {
    method: "GET" | "POST";
    body?: unknown;
    query?: Record<string, string>;
  }
): Promise<unknown> {
  const qs =
    params.query && Object.keys(params.query).length > 0
      ? `?${new URLSearchParams(params.query).toString()}`
      : "";
  const response = await apiFetch(baseUrl, token, `/apps/backtests/tx${qs}`, {
    method: params.method,
    body:
      params.method === "POST" && params.body !== undefined
        ? JSON.stringify(params.body)
        : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Backtests request failed: ${response.status} ${text}`);
  }
  return (await response.json()) as unknown;
}

export async function submitBacktestDetail(
  baseUrl: string,
  token: string,
  query: Record<string, string>
): Promise<unknown> {
  const qs = new URLSearchParams(query).toString();
  const response = await apiFetch(
    baseUrl,
    token,
    `/apps/backtests/detail?${qs}`,
    {
      method: "GET",
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Backtest detail failed: ${response.status} ${text}`);
  }
  return (await response.json()) as unknown;
}

export async function chatRequest(
  baseUrl: string,
  token: string,
  body: ChatRequestBody
): Promise<Response> {
  const resolvedBody: ChatRequestBody = { ...body };
  if (token && (!resolvedBody.userId || !resolvedBody.teamId)) {
    const payload = decodeJwtPayload(token);
    const userId =
      typeof payload?.user_id === "string" ? payload.user_id : undefined;
    const teamId =
      typeof payload?.organization_id === "string"
        ? payload.organization_id
        : undefined;
    if (!resolvedBody.userId && userId) {
      resolvedBody.userId = userId;
    }
    if (!resolvedBody.teamId && teamId) {
      resolvedBody.teamId = teamId;
    }
  }
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/api/training")) {
    return apiFetch(trimmed, token, "/chat/completions", {
      method: "POST",
      body: JSON.stringify(resolvedBody),
      ...LONG_STREAM_API_OPTIONS,
    });
  }
  return apiFetch(trimmed, token, "/api/chat/apps", {
    method: "POST",
    body: JSON.stringify(resolvedBody),
    ...LONG_STREAM_API_OPTIONS,
  });
}
function normalizeToolPathSegment(toolName: string): string {
  const trimmed = toolName.trim().replace(/^\/+/, "");
  return encodeURIComponent(trimmed || "tool");
}
export function resolveWorkerBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  const workerEnv = process.env.OPENPOND_TOOL_URL;
  if (workerEnv) {
    return workerEnv.replace(/\/$/, "");
  }
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    const mappedHost = (() => {
      if (host === "apps.openpond.live") {
        return null;
      }
      if (
        host === DEFAULT_OPENPOND_API_HOST ||
        host === DEFAULT_OPENPOND_WEB_HOST ||
        host === "openpond.live" ||
        host === "www.openpond.live"
      ) {
        return "https://apps.openpond.live";
      }
      return null;
    })();
    if (mappedHost) {
      return mappedHost;
    }
    const isLocal = host === "localhost" || host === "127.0.0.1";
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    if (isLocal && port === "3000") {
      return trimmed;
    }
  } catch {
    // fall through to trimmed
  }
  return trimmed;
}

export async function executeHostedTool(
  baseUrl: string,
  token: string,
  payload: ToolExecuteRequest
): Promise<ToolExecuteResponse> {
  const workerBase = resolveWorkerBaseUrl(baseUrl);
  const toolPath = normalizeToolPathSegment(payload.toolName);
  const deploymentPrefix = payload.deploymentId
    ? `/${payload.appId}/deployments/${payload.deploymentId}`
    : `/${payload.appId}`;
  const requestPath = `${deploymentPrefix}/${toolPath}`;
  const headers = new Headers(payload.headers || {});
  const method = payload.method ?? "POST";
  const body =
    payload.body === undefined || method === "GET"
      ? undefined
      : JSON.stringify(payload.body);
  const response = await apiFetch(workerBase, token, requestPath, {
    method,
    body,
    headers,
  });
  const text = await response.text().catch(() => "");
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  const dataOk =
    data && typeof data === "object" && "ok" in data
      ? Boolean((data as { ok?: unknown }).ok)
      : true;
  const ok = response.ok && dataOk;
  const status =
    data && typeof data === "object" && "status" in data
      ? Number((data as { status?: unknown }).status) || response.status
      : response.status;
  const error =
    data && typeof data === "object" && "error" in data
      ? String((data as { error?: unknown }).error)
      : response.ok
      ? undefined
      : text || response.statusText;
  const payloadData =
    data && typeof data === "object" && "data" in data
      ? (data as { data?: unknown }).data
      : data;
  return { ok, status, data: payloadData, error };
}
