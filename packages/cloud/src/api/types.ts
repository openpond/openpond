export type ToolManifest = {
  version?: string;
  tools: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: unknown;
    };
  }>;
};

export type CreateLocalProjectInput = {
  name: string;
  teamId?: string;
  templateRepoUrl?: string;
  templateBranch?: string;
  envVars?: Record<string, string>;
};

export type CreateRepoRequest = {
  name: string;
  teamId?: string;
  description?: string;
  repoInit?: "opentool" | "empty";
  sandbox?: boolean;
  templateRepoUrl?: string;
  templateBranch?: string;
  envVars?: Record<string, string>;
  deployOnPush?: boolean;
  autoScheduleMigration?: boolean;
};

export type CreateRepoResponse = {
  appId: string;
  gitOwner?: string | null;
  gitRepo?: string | null;
  gitHost?: string | null;
  repoUrl?: string | null;
  defaultBranch?: string;
};

export type HeadlessAppRequest = {
  teamId?: string;
  name?: string;
  description?: string;
  templateRepoUrl?: string;
  templateBranch?: string;
  templateName?: string;
  envVars?: Record<string, string>;
  visibility?: "private" | "public";
};

export type HeadlessAppResponse = {
  status: "ok" | "error";
  appId?: string;
  deploymentId?: string;
  conversationId?: string;
  error?: string;
};

export type HeadlessAppsResponse = {
  items: HeadlessAppResponse[];
};

export type TemplateStatusResponse = {
  templateRepoUrl: string;
  templateBranch: string;
  remoteSha: string;
  lastAppliedSha: string | null;
  updateAvailable: boolean;
};

export type TemplateBranchesResponse = {
  templateRepoUrl: string;
  templateBranch: string;
  defaultBranch: string;
  branches: string[];
};

export type TemplateDeployLatestRequest = {
  environment: "preview" | "production";
};

export type TemplateDeployLatestResponse = {
  deploymentId: string;
  version: number;
  templateCommitSha: string;
};

export type AppEnvironmentUpdateRequest = {
  envVars: Record<string, string>;
};

export type AppEnvironmentUpdateResponse = {
  environment: Record<string, string>;
};

export type AppEnvironmentGetResponse = {
  environment: Record<string, string>;
};

export type AppScheduleSummary = {
  total: number;
  active: number;
  paused: number;
  enabled?: number;
  disabled?: number;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  schedules: AppSchedule[];
  truncated?: boolean;
  [key: string]: unknown;
};

export type AppListItem = {
  id: string;
  name: string;
  description: string | null;
  appType: string | null;
  visibility: "public" | "private";
  codeVisibility?: "public" | "private";
  gitOwner: string | null;
  gitRepo: string | null;
  gitProvider: string | null;
  gitHost: string | null;
  defaultBranch: string | null;
  sandbox: boolean;
  createdAt: string;
  updatedAt: string;
  teamId: string | null;
  teamName: string | null;
  handle: string | null;
  repo: string | null;
  latestDeployment: {
    id: string;
    status: string;
    deploymentDomain: string | null;
    internalUrl: string | null;
    createdAt: string;
    isProduction: boolean | null;
    gitBranch: string | null;
  } | null;
  scheduleSummary?: AppScheduleSummary | null;
};

export type AppCodeVisibilityUpdateResponse = {
  success: boolean;
  app: {
    id: string;
    gitOwner: string | null;
    gitRepo: string | null;
    codeVisibility: "public" | "private";
    updatedAt: string;
  } | null;
};

export type AppRuntimeSummary = {
  app: {
    appId: string;
    name: string;
    description: string | null;
    teamId: string;
    templateRepoUrl: string | null;
    templateBranch: string | null;
    initialPromptSnapshot: string | null;
  };
  runtime: {
    latestDeployment: {
      id: string;
      status: string;
      isProduction: boolean | null;
      createdAt: string;
    } | null;
    schedules: {
      total: number;
      enabled: number;
      disabled: number;
    };
    notifications: {
      scheduleEmailsEnabled: boolean;
      scheduleTweetsEnabled: boolean;
    };
    toolNotifyEmail: {
      notifyEmailEnabledCount: number;
      toolsConfiguredCount: number;
    };
    lastScheduleRun: {
      id: string;
      status: string;
      executionTime: string;
      scheduleName: string;
      errorMessage: string | null;
    } | null;
    lastToolRun: {
      id: string;
      status: string;
      endpoint: string;
      toolName: string | null;
      method: string | null;
      createdAt: string;
      executionTime: number | null;
      error: string | null;
    } | null;
  };
  wallet: {
    personalWalletAddress: string | null;
    operatingWalletAddress: string | null;
    arbitrum: {
      eth: { raw: string; formatted: string } | null;
      usdc: { raw: string; formatted: string } | null;
    };
    hyperliquid: {
      mainnet: {
        accountValue: number | null;
        withdrawable: number | null;
        totalMarginUsed: number | null;
        error?: string;
      };
      testnet: {
        accountValue: number | null;
        withdrawable: number | null;
        totalMarginUsed: number | null;
        error?: string;
      };
    };
  };
  asOf: string;
};

export type ScheduleExecutionStatus = "success" | "failed" | "timeout" | string;

export type AppSchedule = {
  id: string;
  name: string;
  description: string | null;
  scheduleType: "rate" | "cron" | "once" | string;
  scheduleExpression: string;
  enabled: boolean;
  rawEnabled?: boolean;
  syncStatus: string | null;
  syncError?: string | null;
  startAt: string | null;
  endAt: string | null;
  maxRuns: number | null;
  executionCount: number | null;
  lifecycleStatus: string | null;
  lifecycleReason: string | null;
  lastExecutionAt?: string | null;
  lastExecutionStatus?: ScheduleExecutionStatus | null;
  lastRunNowAt?: string | null;
  lastRunNowStatus?: ScheduleExecutionStatus | string | null;
  updatedAt: string;
  deploymentId: string;
  isProduction?: boolean;
  payload?: unknown;
  [key: string]: unknown;
};

export type AppSchedulesResponse = {
  schedules: AppSchedule[];
};

export type OpenToolRecipeDomain =
  | "core"
  | "ai"
  | "market"
  | "orders"
  | "news"
  | "backtesting"
  | "config"
  | "scheduling"
  | "deploy"
  | "debug";

export type OpenToolRecipeSummary = {
  id: string;
  title: string;
  summary: string;
  domain: OpenToolRecipeDomain | string;
  tags: string[];
  supportLevel: "stable" | "beta" | "experimental" | string;
  requiredPackages: string[];
  requiredEnv: string[];
  updatedAt: string;
};

export type OpenToolRecipeListRequest = {
  domain?: OpenToolRecipeDomain | string;
  tags?: string[];
  opentoolVersion?: string;
  limit?: number;
};

export type OpenToolRecipeListResponse = {
  recipes: OpenToolRecipeSummary[];
};

export type OpenToolRecipeSearchRequest = {
  query: string;
  currentFiles?: Array<{ path: string; summary?: string }>;
  validationError?: string;
  buildError?: string;
  domains?: Array<OpenToolRecipeDomain | string>;
  limit?: number;
};

export type OpenToolRecipeSearchResponse = {
  matches: Array<{
    id: string;
    title: string;
    score: number;
    reason: string;
    snippetsAvailable: string[];
    warnings: string[];
  }>;
};

export type OpenToolRecipeGetRequest = {
  id: string;
  includeExamples?: boolean;
  includeTests?: boolean;
  opentoolVersion?: string;
};

export type OpenToolRecipe = OpenToolRecipeSummary & {
  goal: string;
  rules: string[];
  files: Array<{
    pathHint: string;
    purpose: string;
    code: string;
  }>;
  tests: Array<{
    name: string;
    command?: string;
    assertion: string;
  }>;
  validationChecklist: string[];
  dependencies: string[];
  env: Array<{ name: string; required: boolean; description: string }>;
  failureModes: Array<{ symptom: string; fix: string }>;
  sources: Array<{ title: string; url?: string; path?: string }>;
};

export type OpenToolRulesGetRequest = {
  topic:
    | "tool-shape"
    | "zod-schema"
    | "handler-exports"
    | "template-config"
    | "orders"
    | "news"
    | "backtesting"
    | "opentool-ai"
    | "scheduling"
    | "build-validate"
    | "deployment"
    | string;
  errorText?: string;
  filePath?: string;
  codeExcerpt?: string;
  opentoolVersion?: string;
};

export type OpenToolRulesGetResponse = {
  topic: string;
  rules: string[];
  commonMistakes: string[];
  diagnostics: Array<{ check: string; passCondition: string; fix: string }>;
  examples: Array<{ label: string; code: string }>;
  nextActions: string[];
};

export type ScheduleToggleRequest = {
  preferredScheduleId?: string | null;
  scheduleId?: string | null;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
};

export type ScheduleToggleResult = {
  enabled: boolean;
  status: "started" | "stopped" | "already_stopped" | string;
  updatedScheduleIds: string[];
  primaryScheduleId?: string;
  schedules: AppSchedule[];
};

export type ScheduleRunNowRequest = {
  scheduleId: string;
};

export type ScheduleRunNowResponse = {
  ok: boolean;
  scheduleId: string;
  deploymentId?: string;
  statusCode?: number | null;
  requestId?: string | null;
};

export type ScheduleDeleteResponse = {
  ok?: boolean;
  success?: boolean;
  scheduleId?: string;
  status?: string;
  message?: string;
  [key: string]: unknown;
};

export type PromotePreviewToProductionRequest = {
  previewDeploymentId?: string;
  baseBranch: string;
  headBranch: string;
  chatRunId?: string;
};

export type PromotePreviewToProductionResponse = {
  deploymentId: string;
  previewDeploymentId?: string;
  baseBranch?: string;
  headBranch?: string;
  [key: string]: unknown;
};

export type StartAppLifecycleRequest = {
  previewDeploymentId?: string;
  deploymentId?: string;
  baseBranch?: string;
  headBranch?: string;
  chatRunId?: string;
  scheduleId?: string | null;
  preferredScheduleId?: string | null;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
  promotePreview?: boolean;
  deployToProduction?: boolean;
  runOnceImmediately?: boolean;
  runImmediately?: boolean;
};

export type StartAppLifecycleResponse = {
  ok: boolean;
  action: "start_app" | string;
  appId: string;
  promotedPreview?: boolean;
  deploymentId?: string | null;
  scheduleId?: string | null;
  promotion?: PromotePreviewToProductionResponse | null;
  scheduleStart?: ScheduleToggleResult | null;
  scheduleStatus?: "started" | "no_schedules" | string;
  immediateRun?: ScheduleRunNowResponse | null;
  summary?: string;
  [key: string]: unknown;
};

export type ScheduleExecutionLog = {
  id: string;
  scheduleId: string;
  deploymentId: string;
  executionTime: string;
  status: ScheduleExecutionStatus;
  duration: number | null;
  requestId: string | null;
  logStreamName: string | null;
  errorMessage: string | null;
  errorType: string | null;
  responsePayload: unknown;
  createdAt: string;
  scheduleName?: string | null;
  scheduleExpression?: string | null;
  [key: string]: unknown;
};

export type ScheduleExecutionLogsResponse = {
  logs: ScheduleExecutionLog[];
};

export type AppExecutionDeployment = {
  id: string;
  status: string | null;
  versionNumber?: number | null;
  isProduction?: boolean | null;
  createdAt: string;
  [key: string]: unknown;
};

export type AppExecutionToolRun = {
  id: string;
  deploymentId: string | null;
  toolName: string | null;
  endpoint: string | null;
  method: string | null;
  status: string | null;
  response?: unknown;
  statusCode?: number | null;
  executionTime: number | null;
  error: string | null;
  parameters?: unknown;
  createdAt: string;
  [key: string]: unknown;
};

export type AppExecutionTimelineResponse = {
  app: unknown;
  latestDeployment: AppExecutionDeployment | null;
  deployments: AppExecutionDeployment[];
  toolRuns: AppExecutionToolRun[];
  scheduleRuns: ScheduleExecutionLog[];
};

export type OpenPondAccountProduct = {
  id: string;
  userProductId: string;
  openPondProductId: string | null;
  name: string;
  description: string[] | null;
  type: "subscription" | "credit_pack" | string;
  status: "active" | "expired" | "cancelled" | string;
  startDate: string | null;
  endDate: string | null;
  dailyInputTokens: number | null;
  dailyOutputTokens: number | null;
  dailyMessageLimit: number | null;
  monthlyInputTokens: number | null;
  monthlyOutputTokens: number | null;
  monthlyCost: string | null;
  credits: string | null;
  price: string | null;
  currency: string;
  duration: number | null;
  restrictedModels: string[] | null;
  gatewayEntitlements: unknown | null;
  duckHoldings: number | null;
  isActive: boolean | null;
};

export type OpenPondAccount = {
  id: string;
  email: string | null;
  name: string | null;
  handle: string | null;
  image: string | null;
  timezone: string | null;
  turnkeyWalletAddress: string | null;
  turnkeyOperatingWalletAddress: string | null;
  isAdmin: boolean;
  isVerified: boolean;
  dailyAgentAppId: string | null;
  dailyAgentDeploymentId: string | null;
  credits: string;
};

export type OpenPondAccountResponse = {
  account: OpenPondAccount;
  products: OpenPondAccountProduct[];
  asOf: string;
};

export type OpenPondAccountBalanceBreakdownItem = {
  wallet: "operating" | "personal" | string;
  chain: string;
  chainId: number | null;
  asset: string;
  amount: string | null;
  usdValue: string | null;
};

export type OpenPondAccountBalanceResponse = {
  balanceKind: "openpond_funding" | string;
  balanceUsd: string | null;
  balanceUsdCents: number | null;
  balanceLabel: string;
  currency: "USD" | string;
  asOf: string;
  stale?: boolean;
  credits?: string | null;
  breakdown: OpenPondAccountBalanceBreakdownItem[];
};

export type OpenPondApiHealthResponse = {
  status: string;
  service?: string;
  timestamp?: string;
  version?: string | null;
};

export type OpenPondApiHealth = {
  reachable: boolean;
  authenticated: boolean | null;
  apiBase: string;
  latencyMs: number;
  status: number | null;
  service: string | null;
  checkedAt: string;
  account?: OpenPondAccount | null;
  error?: string;
};

export type AssistantMode = "plan" | "performance";

export type AssistantRunRequest = {
  appId: string;
  mode: AssistantMode;
  prompt: string;
};

export type AssistantRunResponse = {
  ok: boolean;
  mode: AssistantMode;
  conversationId: string;
  response: string;
};

export type AgentCreateRequest = {
  prompt: string;
  teamId?: string;
  template?: {
    name?: string;
    description?: string;
    templateRepoUrl?: string;
    templateBranch?: string;
    envVars?: Record<string, string>;
  };
  deployEnvironment?: "preview" | "production";
  deployDisabled?: boolean;
  autoDeployOnFinish?: boolean;
  streamDeployLogs?: boolean;
};

export type BacktestRunRequest = {
  appId: string;
  deploymentId: string;
  toolName?: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  symbol?: string;
  timeframeStart?: string;
  timeframeEnd?: string;
  lookbackDays?: number;
  initialEquityUsd?: number;
  source?: string;
  fillModel?: string;
  feeModel?: string;
  slippageBps?: number;
  headers?: Record<string, string>;
};

export type DeploymentLogEntry = {
  id: string;
  type?: string;
  message: string;
  createdAt: string;
};

export type DeploymentDetail = {
  id: string;
  appId: string;
  status: string;
  createdAt: string;
  gitBranch: string | null;
  toolsJson?: unknown;
  metadataJson?: unknown;
};

export type ToolExecuteRequest = {
  appId: string;
  deploymentId: string;
  toolName: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
};

export type ToolExecuteResponse = {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
};
