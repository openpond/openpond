import type { StreamCallbacks } from "./stream.js";
import type {
  AgentCreateRequest,
  AppEnvironmentGetResponse,
  AppEnvironmentUpdateResponse,
  AppExecutionTimelineResponse,
  AppListItem,
  AppRuntimeSummary,
  AppSchedulesResponse,
  AssistantMode,
  AssistantRunResponse,
  CreateRepoRequest,
  CreateRepoResponse,
  DeploymentLogEntry,
  OpenPondAccountResponse,
  OpenPondApiHealth,
  OpenToolRecipe,
  OpenToolRecipeGetRequest,
  OpenToolRecipeListRequest,
  OpenToolRecipeListResponse,
  OpenToolRecipeSearchRequest,
  OpenToolRecipeSearchResponse,
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

export type OpenPondClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  apiUrl?: string;
  chatApiUrl?: string;
  opChatApiUrl?: string;
  toolUrl?: string;
  cacheTtlMs?: number;
  useCache?: boolean;
};

export type ToolSummary = {
  name: string;
  description?: string;
  raw: unknown;
};

export type ToolListResult = {
  app: AppListItem;
  deploymentId: string | null;
  tools: ToolSummary[];
};

export type DeploymentWatchResult = {
  deploymentId: string;
  status: string | "timeout" | null;
  logs: DeploymentLogEntry[];
};

export type AgentCreateStreamCallbacks = StreamCallbacks & {
  onAppId?: (appId: string) => void;
  onDeploymentId?: (deploymentId: string) => void;
};

export type AgentCreateStreamResult = {
  conversationId?: string;
  appId?: string;
  deploymentId?: string;
};

export type OpenPondClient = {
  baseUrl: string;
  apiUrl: string;
  chatApiUrl: string;
  toolUrl: string;
  apiKey: string;
  account: {
    get: () => Promise<OpenPondAccountResponse>;
    health: () => Promise<OpenPondApiHealth>;
  };
  chat: {
    providers: () => Promise<import("./hosted-chat.js").HostedProvidersResponse>;
    provider: (
      provider: string
    ) => Promise<import("./hosted-chat.js").HostedProvider>;
    models: () => Promise<import("./hosted-chat.js").HostedModelsResponse>;
    model: (model: string) => Promise<import("./hosted-chat.js").HostedModel>;
    send: (
      input: Omit<
        import("./hosted-chat.js").HostedChatRequestOptions,
        "apiBaseUrl" | "token"
      >
    ) => Promise<import("./hosted-chat.js").HostedChatCompletion>;
    stream: (
      input: Omit<
        import("./hosted-chat.js").HostedChatRequestOptions,
        "apiBaseUrl" | "token"
      >
    ) => AsyncGenerator<
      import("./hosted-chat.js").HostedChatStreamDelta,
      void,
      unknown
    >;
  };
  tool: {
    list: (
      target: string,
      options?: ToolListOptions
    ) => Promise<ToolListResult>;
    run: (
      target: string,
      toolName: string,
      options?: ToolRunOptions
    ) => Promise<ToolExecuteResponse>;
  };
  deploy: {
    watch: (
      target: string,
      options?: DeployWatchOptions
    ) => Promise<DeploymentWatchResult>;
  };
  template: {
    status: (
      target: string,
      options?: TemplateTargetOptions
    ) => Promise<TemplateStatusResponse>;
    branches: (
      target: string,
      options?: TemplateTargetOptions
    ) => Promise<TemplateBranchesResponse>;
    update: (
      target: string,
      options?: TemplateUpdateOptions
    ) => Promise<TemplateDeployLatestResponse>;
  };
  opentool: {
    recipesList: (
      input?: OpenToolRecipeListRequest
    ) => Promise<OpenToolRecipeListResponse>;
    recipesSearch: (
      input: OpenToolRecipeSearchRequest
    ) => Promise<OpenToolRecipeSearchResponse>;
    recipeGet: (input: OpenToolRecipeGetRequest) => Promise<OpenToolRecipe>;
    rulesGet: (
      input: OpenToolRulesGetRequest
    ) => Promise<OpenToolRulesGetResponse>;
  };
  apps: {
    list: (options?: AppsListOptions) => Promise<AppListItem[]>;
    tools: (options?: AppsToolsOptions) => Promise<unknown[]>;
    performance: (options?: AppsPerformanceOptions) => Promise<unknown>;
    summary: (input: AppSummaryOptions) => Promise<AppRuntimeSummary>;
    schedules: (input: AppSchedulesOptions) => Promise<AppSchedulesResponse>;
    schedulesStart: (
      input: AppSchedulesStartOptions
    ) => Promise<ScheduleToggleResult>;
    schedulesStop: (
      input: AppSchedulesStopOptions
    ) => Promise<ScheduleToggleResult>;
    schedulesStopCurrent: () => Promise<ScheduleToggleResult>;
    scheduleRunNow: (
      input: ScheduleRunNowOptions
    ) => Promise<ScheduleRunNowResponse>;
    scheduleDelete: (
      input: ScheduleDeleteOptions
    ) => Promise<ScheduleDeleteResponse>;
    scheduleExecutionLogs: (
      input: ScheduleExecutionLogsOptions
    ) => Promise<ScheduleExecutionLogsResponse>;
    scheduleExecutionLog: (
      input: ScheduleExecutionLogOptions
    ) => Promise<ScheduleExecutionLog>;
    deploymentScheduleExecutionLogs: (
      input: DeploymentScheduleExecutionLogsOptions
    ) => Promise<ScheduleExecutionLogsResponse>;
    executionTimeline: (
      input: AppExecutionTimelineOptions
    ) => Promise<AppExecutionTimelineResponse>;
    assistantRun: (
      input: AppsAssistantRunOptions
    ) => Promise<AssistantRunResponse>;
    agentCreate: (
      input: AgentCreateRequest & { refreshCache?: boolean },
      callbacks?: AgentCreateStreamCallbacks
    ) => Promise<AgentCreateStreamResult>;
    toolsExecute: (
      input: ExecuteUserToolOptions
    ) => Promise<ToolExecuteResponse>;
    deploy: (input: AppDeployOptions) => Promise<{ deploymentId: string }>;
    startApp: (input: AppStartOptions) => Promise<StartAppLifecycleResponse>;
    promotePreview: (
      input: AppPromotePreviewOptions
    ) => Promise<PromotePreviewToProductionResponse>;
    envGet: (
      input: AppEnvironmentGetOptions
    ) => Promise<AppEnvironmentGetResponse>;
    envSet: (
      input: AppEnvironmentSetOptions
    ) => Promise<AppEnvironmentUpdateResponse>;
  };
  repo: {
    create: (
      input: CreateRepoRequest & { refreshCache?: boolean }
    ) => Promise<CreateRepoResponse>;
  };
  cache: {
    refresh: () => Promise<void>;
  };
};

export type ToolListOptions = {
  branch?: string;
  forceRefresh?: boolean;
  deploymentId?: string;
};

export type ToolRunOptions = {
  branch?: string;
  deploymentId?: string;
  method?: ToolExecuteRequest["method"];
  body?: unknown;
  headers?: Record<string, string>;
  forceRefresh?: boolean;
};

export type DeployWatchOptions = {
  branch?: string;
  deploymentId?: string;
  intervalMs?: number;
  timeoutMs?: number;
  forceRefresh?: boolean;
  onLog?: (log: DeploymentLogEntry) => void;
  onStatus?: (status: string | null) => void;
};

export type TemplateTargetOptions = {
  forceRefresh?: boolean;
};

export type TemplateUpdateOptions = {
  environment?: TemplateDeployLatestRequest["environment"];
  forceRefresh?: boolean;
};

export type AppsListOptions = {
  handle?: string;
  forceRefresh?: boolean;
};

export type AppsToolsOptions = {
  forceRefresh?: boolean;
};

export type AppsPerformanceOptions = {
  appId?: string;
};

export type AppSummaryOptions = {
  appId: string;
};

export type AppSchedulesOptions = {
  appId: string;
};

export type AppSchedulesStartOptions = {
  appId: string;
} & ScheduleToggleRequest;

export type AppSchedulesStopOptions = {
  appId: string;
};

export type ScheduleRunNowOptions = ScheduleRunNowRequest;

export type ScheduleDeleteOptions = {
  appId: string;
  scheduleId: string;
};

export type ScheduleExecutionLogsOptions = {
  scheduleId: string;
  limit?: number;
};

export type ScheduleExecutionLogOptions = {
  runId: string;
};

export type DeploymentScheduleExecutionLogsOptions = {
  deploymentId: string;
  limit?: number;
};

export type AppExecutionTimelineOptions = {
  appId: string;
  limit?: number;
};

export type AppsAssistantRunOptions = {
  appId: string;
  mode: AssistantMode;
  prompt: string;
};

export type ExecuteUserToolOptions = {
  appId: string;
  deploymentId: string;
  toolName: string;
  scheduleId?: string;
  method?: ToolExecuteRequest["method"];
  body?: unknown;
  headers?: Record<string, string>;
  notifyEmail?: boolean;
};

export type AppEnvironmentSetOptions = {
  appId: string;
  envVars: Record<string, string>;
};

export type AppEnvironmentGetOptions = {
  appId: string;
};

export type AppDeployOptions = {
  appId: string;
  environment?: "preview" | "production";
  commitSha?: string;
  branch?: string;
};

export type AppPromotePreviewOptions = {
  appId: string;
} & PromotePreviewToProductionRequest;

export type AppStartOptions = {
  appId: string;
} & StartAppLifecycleRequest;
