import type {
  Approval,
  AppPreferences,
  ApplyCloudWorkItemLocalPatchRequest,
  BootstrapPayload,
  CloudWorkItemBackgroundRequest,
  CloudWorkItemDetail,
  ChatAttachment,
  ChatAttachmentSummary,
  CreateCloudWorkItemRequest,
  CreateLocalProjectRequest,
  CreateSessionRequest,
  InsightStatus,
  InsightEvidenceSource,
  InsightRunStatus,
  InsightRunTrigger,
  InsightsListResponse,
  InsightsScanResponse,
  InsightsAskRequest,
  InsightsAskResponse,
  TrainingStateResponse,
  TrainingRunDetail,
  ComputeStateResponse,
  ComputeSettings,
  ModelDownloadJob,
  LocalAgentSchedulesResponse,
  LocalAgentScheduleRunsResponse,
  LocalAgentScheduleRunResponse,
  PatchLocalAgentScheduleRequest,
  LocalAgentScheduleRunNowRequest,
  LocalProject,
  UpdateLocalProjectAgentSetupRequest,
  PatchSessionRequest,
  PatchSidebarAppPreferenceRequest,
  ProviderCredentialDeleteRequest,
  ProviderCredentialWriteRequest,
  ProviderModelsRefreshRequest,
  ProviderSettings,
  ProviderValidationRequest,
  ReorderSidebarAppsRequest,
  RecordClientDiagnosticRequest,
  ResolveApprovalRequest,
  RemoteAccessStatus,
  RemoteAccessToggleResponse,
  RuntimeEvent,
  SaveWorkspaceFileRequest,
  SaveOpenPondAccountRequest,
  SendTurnRequest,
  Session,
  SidebarAppPreference,
  SidebarAppPreferences,
  SwitchOpenPondAccountRequest,
  SubagentLifecycleActionRequest,
  SubagentLifecycleActionResponse,
  UpdateOpenPondAccountConfigRequest,
  ListCloudWorkItemsRequest,
  OpenCloudWorkItemRequest,
  SendCloudWorkItemMessageRequest,
  UploadLocalProjectCloudSourceRequest,
  UpdateAppPreferencesRequest,
  UpdatePersonalizationRequest,
  UpdateProviderSettingsRequest,
  UsageRecordsResponse,
  UsageStatusFilter,
  UsageSummaryResponse,
  UsageVisibilityFilter,
  WorkspaceBranchRequest,
  WorkspaceDiffFile,
  WorkspaceDiffSummary,
  WorkspaceLspActionRequest,
  WorkspaceLspActionResponse,
  WorkspaceLspDiagnosticsResponse,
  WorkspaceLspRuntimeStatusResponse,
  WorkspaceLspSettingsStatusResponse,
  WorkspaceLspTouchRequest,
  WorkspaceState,
  WorkspaceTemplateConfigView,
  TeamChatHostedAiThread,
  TeamChatAgentCatalogEntry,
  TeamChatAgentConversation,
  TeamChatAgentRunResult,
  TeamChatAttachment,
  TeamChatAttachmentDownload,
  TeamChatEventPage,
  TeamChatMember,
  TeamChatMessage,
  TeamChatRealtimeSession,
  TeamChatThread,
  TeamChatThreadDetail,
  TeamChatThreadMuteResult,
} from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "./api/api-client";
import { organizationApi } from "./api/organization-api";
import { sessionApi } from "./api/session-api";
import { sandboxApi } from "./api/sandbox";
import { communityApi } from "./api/community-api";
import type {
  CloudWorkItemCancelTaskResponse,
  CloudWorkItemApplyLocalPatchResponse,
  CloudWorkItemMessageResponse,
  CloudWorkItemOpenCloudResponse,
  CloudWorkItemsResponse,
  GitAvailability,
  LocalProjectCloudSourcePreviewResponse,
  LocalProjectCloudSourceUploadResponse,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResponse,
  VoiceTranscriptionStatus,
} from "./api/types";

type ProviderModelsResponse = {
  providerId: string;
  models: ProviderSettings["modelCaches"][string]["models"];
  cache: ProviderSettings["modelCaches"][string];
  query: string | null;
  providers: ProviderSettings;
};

export type OpenAiSubscriptionAuthResponse =
  | {
      providerId: "openai";
      method: "browser";
      url: string;
      redirectUri: string;
      expiresAt: number;
    }
  | {
      providerId: "openai";
      method: "device";
      url: string;
      userCode: string;
      expiresAt: number;
    };

type CodexHistoryTurnInterruptResponse =
  | { interrupted: true }
  | { interrupted: false; reason: "no_active_openpond_turn" | "turn_not_ready" };

export type PreferencesPayload = {
  preferences: AppPreferences;
};

export type RuntimeEventPagePayload = {
  events: Array<{ sequence: number; event: RuntimeEvent }>;
  sessionId: string | null;
  afterSequence: number;
  beforeSequence: number | null;
  nextSequence: number;
  previousSequence: number;
  limit: number;
  hasMore: boolean;
  totalMatchingEvents: number;
  remainingMatchingEvents: number;
};

export { openEventStream, terminalWebSocketProtocols, terminalWebSocketUrl } from "./api/api-client";
export { resolveConnection } from "./api/connection";
export type { ClientConnection } from "./api/api-client";
export type {
  CloudWorkItemCancelTaskResponse,
  CloudWorkItemMessageResponse,
  CloudWorkItemOpenCloudResponse,
  CloudWorkItemsResponse,
  GitAvailability,
  LocalProjectCloudSourcePreviewResponse,
  LocalProjectCloudSourceUploadResponse,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResponse,
  VoiceTranscriptionStatus,
} from "./api/types";

export const api = {
  ...communityApi,
  bootstrap: (connection: ClientConnection) =>
    apiFetch<BootstrapPayload>(connection, "/v1/bootstrap?refreshCodex=1"),
  teamChatMembers: (connection: ClientConnection, teamId: string) =>
    apiFetch<{ members: TeamChatMember[] }>(
      connection,
      `/v1/team-chat/members?teamId=${encodeURIComponent(teamId)}`,
    ),
  teamChatAgents: (connection: ClientConnection, teamId: string) =>
    apiFetch<{ agents: TeamChatAgentCatalogEntry[] }>(
      connection,
      `/v1/team-chat/agents?teamId=${encodeURIComponent(teamId)}`,
    ),
  teamChatThreads: (connection: ClientConnection, teamId: string) =>
    apiFetch<{ threads: TeamChatThread[] }>(
      connection,
      `/v1/team-chat/threads?teamId=${encodeURIComponent(teamId)}`,
    ),
  teamChatRealtimeSession: (connection: ClientConnection, teamId: string) =>
    apiFetch<TeamChatRealtimeSession>(
      connection,
      `/v1/team-chat/realtime-session?teamId=${encodeURIComponent(teamId)}`,
    ),
  teamChatEvents: (
    connection: ClientConnection,
    teamId: string,
    input: { after?: number; limit?: number } = {},
  ) => {
    const query = new URLSearchParams({ teamId });
    if (input.after != null) query.set("after", String(input.after));
    if (input.limit != null) query.set("limit", String(input.limit));
    return apiFetch<TeamChatEventPage>(
      connection,
      `/v1/team-chat/events?${query.toString()}`,
    );
  },
  teamChatGeneral: (connection: ClientConnection, teamId: string) =>
    apiFetch<TeamChatThreadDetail>(connection, "/v1/team-chat/threads/general", {
      method: "POST",
      body: JSON.stringify({ teamId }),
    }),
  teamChatDm: (connection: ClientConnection, teamId: string, otherUserId: string) =>
    apiFetch<TeamChatThreadDetail>(connection, "/v1/team-chat/threads/dm", {
      method: "POST",
      body: JSON.stringify({ teamId, otherUserId }),
    }),
  teamChatThread: (
    connection: ClientConnection,
    teamId: string,
    threadId: string,
    input: { beforeSequence?: number; limit?: number } = {},
  ) => {
    const query = new URLSearchParams({ teamId });
    if (input.beforeSequence != null) query.set("beforeSequence", String(input.beforeSequence));
    if (input.limit != null) query.set("limit", String(input.limit));
    return apiFetch<TeamChatThreadDetail>(
      connection,
      `/v1/team-chat/threads/${encodeURIComponent(threadId)}?${query.toString()}`,
    );
  },
  uploadTeamChatAttachment: (
    connection: ClientConnection,
    threadId: string,
    input: { teamId: string; attachment: ChatAttachment },
  ) =>
    apiFetch<TeamChatAttachment>(
      connection,
      `/v1/team-chat/threads/${encodeURIComponent(threadId)}/attachments/upload`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  teamChatAttachmentDownload: (
    connection: ClientConnection,
    teamId: string,
    attachmentId: string,
  ) =>
    apiFetch<TeamChatAttachmentDownload>(
      connection,
      `/v1/team-chat/attachments/${encodeURIComponent(attachmentId)}/download?teamId=${encodeURIComponent(teamId)}`,
    ),
  sendTeamChatMessage: (
    connection: ClientConnection,
    threadId: string,
    input: {
      teamId: string;
      body: string;
      clientRequestId: string;
      mentionUserIds?: string[];
      attachmentIds?: string[];
      replyToMessageId?: string | null;
    },
  ) =>
    apiFetch<TeamChatMessage>(
      connection,
      `/v1/team-chat/threads/${encodeURIComponent(threadId)}/messages`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  createTeamChatAgentRun: (
    connection: ClientConnection,
    threadId: string,
    input: {
      teamId: string;
      body: string;
      clientRequestId: string;
      selectedActionKey?: string | null;
      selectedAgentId?: string | null;
      conversationId?: string | null;
      targetProjectId?: string | null;
      approvalId?: string | null;
    },
  ) =>
    apiFetch<TeamChatAgentRunResult>(
      connection,
      `/v1/team-chat/threads/${encodeURIComponent(threadId)}/agent-runs`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  teamChatAgentConversation: (
    connection: ClientConnection,
    teamId: string,
    agentRunId: string,
  ) =>
    apiFetch<TeamChatAgentConversation>(
      connection,
      `/v1/team-chat/agent-runs/${encodeURIComponent(agentRunId)}?teamId=${encodeURIComponent(teamId)}`,
    ),
  editTeamChatMessage: (
    connection: ClientConnection,
    threadId: string,
    messageId: string,
    input: { teamId: string; body: string },
  ) =>
    apiFetch<TeamChatMessage>(
      connection,
      `/v1/team-chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  deleteTeamChatMessage: (
    connection: ClientConnection,
    threadId: string,
    messageId: string,
    teamId: string,
  ) =>
    apiFetch<TeamChatMessage>(
      connection,
      `/v1/team-chat/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE", body: JSON.stringify({ teamId }) },
    ),
  markTeamChatRead: (
    connection: ClientConnection,
    threadId: string,
    teamId: string,
    sequence: number,
  ) =>
    apiFetch<{ sequence: number }>(
      connection,
      `/v1/team-chat/threads/${encodeURIComponent(threadId)}/read`,
      { method: "POST", body: JSON.stringify({ teamId, sequence }) },
    ),
  setTeamChatThreadMuted: (
    connection: ClientConnection,
    threadId: string,
    teamId: string,
    muted: boolean,
  ) =>
    apiFetch<TeamChatThreadMuteResult>(
      connection,
      `/v1/team-chat/threads/${encodeURIComponent(threadId)}/mute`,
      { method: "POST", body: JSON.stringify({ teamId, muted }) },
    ),
  createTeamChatAiThread: (
    connection: ClientConnection,
    threadId: string,
    input: {
      teamId: string;
      body: string;
      clientRequestId: string;
      providerId: string;
      modelId: string;
    },
  ) =>
    apiFetch<TeamChatHostedAiThread>(
      connection,
      `/v1/team-chat/threads/${encodeURIComponent(threadId)}/ai-threads`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  teamChatAiThread: (connection: ClientConnection, teamId: string, conversationId: string) =>
    apiFetch<TeamChatHostedAiThread>(
      connection,
      `/v1/team-chat/ai-threads/${encodeURIComponent(conversationId)}?teamId=${encodeURIComponent(teamId)}`,
    ),
  sendTeamChatAiTurn: (
    connection: ClientConnection,
    conversationId: string,
    input: {
      teamId: string;
      body: string;
      clientRequestId: string;
      providerId: string;
      modelId: string;
    },
  ) =>
    apiFetch<TeamChatHostedAiThread>(
      connection,
      `/v1/team-chat/ai-threads/${encodeURIComponent(conversationId)}/turns`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  executeTeamChatAiTurn: (
    connection: ClientConnection,
    turnId: string,
    teamId: string,
  ) =>
    apiFetch<{ accepted: true }>(
      connection,
      `/v1/team-chat/ai-turns/${encodeURIComponent(turnId)}/execute`,
      { method: "POST", body: JSON.stringify({ teamId }) },
    ),
  cancelTeamChatAiTurnExecution: (
    connection: ClientConnection,
    turnId: string,
    teamId: string,
  ) =>
    apiFetch<{ cancelled: boolean }>(
      connection,
      `/v1/team-chat/ai-turns/${encodeURIComponent(turnId)}/execute/cancel`,
      { method: "POST", body: JSON.stringify({ teamId }) },
    ),
  usage: (
    connection: ClientConnection,
    input: {
      range?: "7d" | "30d" | "90d" | "all";
      visibility?: UsageVisibilityFilter;
      status?: UsageStatusFilter;
    } = {},
  ) => {
    const params = usageSearchParams(input);
    const query = params.size ? `?${params.toString()}` : "";
    return apiFetch<UsageSummaryResponse>(connection, `/v1/usage${query}`);
  },
  usageRecords: (
    connection: ClientConnection,
    input: {
      range?: "7d" | "30d" | "90d" | "all";
      visibility?: UsageVisibilityFilter;
      status?: UsageStatusFilter;
      sessionId?: string | null;
      turnId?: string | null;
      limit?: number;
    } = {},
  ) => {
    const params = usageSearchParams(input);
    if (input.sessionId) params.set("sessionId", input.sessionId);
    if (input.turnId) params.set("turnId", input.turnId);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const query = params.size ? `?${params.toString()}` : "";
    return apiFetch<UsageRecordsResponse>(connection, `/v1/usage/records${query}`);
  },
  runtimeEventsPage: (
    connection: ClientConnection,
    input: { sessionId?: string | null; afterSequence?: number; beforeSequence?: number | null; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (input.sessionId) params.set("sessionId", input.sessionId);
    if (input.afterSequence !== undefined) params.set("afterSequence", String(input.afterSequence));
    if (input.beforeSequence !== undefined && input.beforeSequence !== null) {
      params.set("beforeSequence", String(input.beforeSequence));
    }
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const query = params.size ? `?${params.toString()}` : "";
    return apiFetch<RuntimeEventPagePayload>(connection, `/v1/events/page${query}`);
  },
  runSubagentLifecycleAction: (
    connection: ClientConnection,
    runId: string,
    input: SubagentLifecycleActionRequest,
  ) =>
    apiFetch<SubagentLifecycleActionResponse>(
      connection,
      `/v1/subagents/${encodeURIComponent(runId)}/lifecycle`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  insights: (
    connection: ClientConnection,
    input: {
      status?: InsightStatus | "all";
      limit?: number;
      evidenceSource?: InsightEvidenceSource | "all";
      runStatus?: InsightRunStatus | "all";
      runTrigger?: InsightRunTrigger | "all";
      runModel?: string | null;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (input.status) params.set("status", input.status);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.evidenceSource) params.set("evidenceSource", input.evidenceSource);
    if (input.runStatus) params.set("runStatus", input.runStatus);
    if (input.runTrigger) params.set("runTrigger", input.runTrigger);
    if (input.runModel?.trim()) params.set("runModel", input.runModel.trim());
    const query = params.size ? `?${params.toString()}` : "";
    return apiFetch<InsightsListResponse>(connection, `/v1/insights${query}`);
  },
  runInsightsScan: (connection: ClientConnection, input: { trigger?: InsightRunTrigger } = {}) => {
    const params = new URLSearchParams();
    if (input.trigger) params.set("trigger", input.trigger);
    const query = params.size ? `?${params.toString()}` : "";
    return apiFetch<InsightsScanResponse>(connection, `/v1/insights/scan${query}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  askInsights: (connection: ClientConnection, input: InsightsAskRequest) =>
    apiFetch<InsightsAskResponse>(connection, "/v1/insights/question", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  patchInsight: (connection: ClientConnection, insightId: string, input: { status: InsightStatus }) =>
    apiFetch<InsightsListResponse>(connection, `/v1/insights/${encodeURIComponent(insightId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  trainingState: (connection: ClientConnection, profileId: string) =>
    apiFetch<TrainingStateResponse>(connection, `/v1/training?profileId=${encodeURIComponent(profileId)}`),
  trainingRunDetail: (connection: ClientConnection, jobId: string) =>
    apiFetch<TrainingRunDetail>(connection, `/v1/training/jobs/${encodeURIComponent(jobId)}/detail`),
  trainingRequest: <T>(
    connection: ClientConnection,
    path: string,
    input: unknown,
    method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
  ) => apiFetch<T>(connection, `/v1/training${path}`, {
    method,
    body: method === "DELETE" ? undefined : JSON.stringify(input),
  }),
  computeState: (connection: ClientConnection) =>
    apiFetch<ComputeStateResponse>(connection, "/v1/compute"),
  scanCompute: (connection: ClientConnection) =>
    apiFetch<ComputeStateResponse["inventory"]>(connection, "/v1/compute/scan", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  updateComputeSettings: (connection: ClientConnection, input: { modelStorePath?: string | null; defaultDeviceIds?: string[]; additionalModelPaths?: string[] }) =>
    apiFetch<ComputeSettings>(connection, "/v1/compute/settings", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  downloadSmolLm2: (connection: ClientConnection) =>
    apiFetch<ModelDownloadJob>(connection, "/v1/compute/models/smollm2/download", { method: "POST", body: JSON.stringify({}) }),
  cancelModelDownload: (connection: ClientConnection, jobId: string) =>
    apiFetch<ModelDownloadJob>(connection, `/v1/compute/downloads/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: JSON.stringify({}) }),
  localAgentSchedules: (
    connection: ClientConnection,
    input: { localProjectId?: string | null } = {},
  ) => {
    const params = new URLSearchParams();
    if (input.localProjectId) params.set("localProjectId", input.localProjectId);
    const query = params.size ? `?${params.toString()}` : "";
    return apiFetch<LocalAgentSchedulesResponse>(connection, `/v1/local-agent-schedules${query}`);
  },
  syncLocalAgentSchedules: (connection: ClientConnection) =>
    apiFetch<LocalAgentSchedulesResponse>(connection, "/v1/local-agent-schedules/sync", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  patchLocalAgentSchedule: (
    connection: ClientConnection,
    scheduleId: string,
    input: PatchLocalAgentScheduleRequest,
  ) =>
    apiFetch<{ schedule: LocalAgentSchedulesResponse["schedules"][number] }>(
      connection,
      `/v1/local-agent-schedules/${encodeURIComponent(scheduleId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ),
  runLocalAgentSchedule: (
    connection: ClientConnection,
    scheduleId: string,
    input: LocalAgentScheduleRunNowRequest = {},
  ) =>
    apiFetch<LocalAgentScheduleRunResponse>(
      connection,
      `/v1/local-agent-schedules/${encodeURIComponent(scheduleId)}/run`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  localAgentScheduleRuns: (
    connection: ClientConnection,
    scheduleId: string,
    input: { limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const query = params.size ? `?${params.toString()}` : "";
    return apiFetch<LocalAgentScheduleRunsResponse>(
      connection,
      `/v1/local-agent-schedules/${encodeURIComponent(scheduleId)}/runs${query}`,
    );
  },
  refreshOpenPond: (connection: ClientConnection) =>
    apiFetch<BootstrapPayload>(connection, "/v1/openpond/apps/refresh", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  refreshOpenPondAccounts: (connection: ClientConnection) =>
    apiFetch<BootstrapPayload>(connection, "/v1/bootstrap?refreshOpenPond=1"),
  refreshOpenPondAccount: (connection: ClientConnection) =>
    apiFetch<{
      account: BootstrapPayload["account"];
      accountMeta: BootstrapPayload["accountMeta"];
    }>(connection, "/v1/openpond/account?refresh=1"),
  loadMoreOpenPondApps: (connection: ClientConnection, input: { offset: number; limit: number }) =>
    apiFetch<{
      bootstrap: BootstrapPayload;
      addedCount: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    }>(
      connection,
      `/v1/openpond/apps/more?offset=${encodeURIComponent(String(input.offset))}&limit=${encodeURIComponent(String(input.limit))}`,
    ),
  switchOpenPondAccount: (connection: ClientConnection, input: SwitchOpenPondAccountRequest) =>
    apiFetch<BootstrapPayload>(connection, "/v1/openpond/accounts/switch", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  saveOpenPondAccount: (connection: ClientConnection, input: SaveOpenPondAccountRequest) =>
    apiFetch<BootstrapPayload>(connection, "/v1/openpond/accounts/login", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateOpenPondAccountConfig: (connection: ClientConnection, input: UpdateOpenPondAccountConfigRequest) =>
    apiFetch<BootstrapPayload>(connection, "/v1/openpond/accounts/config", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  savePreferences: (connection: ClientConnection, input: UpdateAppPreferencesRequest) =>
    apiFetch<PreferencesPayload>(connection, "/v1/preferences", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  saveProviderSettings: (connection: ClientConnection, input: UpdateProviderSettingsRequest) =>
    apiFetch<ProviderSettings>(connection, "/v1/providers", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  providerSettings: (connection: ClientConnection) =>
    apiFetch<ProviderSettings>(connection, "/v1/providers"),
  loadProviderModels: (
    connection: ClientConnection,
    providerId: string,
    input: { query?: string | null; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (input.query?.trim()) params.set("query", input.query.trim());
    if (input.limit) params.set("limit", String(input.limit));
    const query = params.size ? `?${params.toString()}` : "";
    return apiFetch<ProviderModelsResponse>(
      connection,
      `/v1/providers/${encodeURIComponent(providerId)}/models${query}`,
    );
  },
  refreshProviderModels: (
    connection: ClientConnection,
    providerId: string,
    input: ProviderModelsRefreshRequest,
  ) =>
    apiFetch<ProviderModelsResponse>(connection, `/v1/providers/${encodeURIComponent(providerId)}/models`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  saveProviderCredential: (
    connection: ClientConnection,
    providerId: string,
    input: ProviderCredentialWriteRequest,
  ) =>
    apiFetch<ProviderSettings>(connection, `/v1/providers/${encodeURIComponent(providerId)}/credential`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteProviderCredential: (
    connection: ClientConnection,
    providerId: string,
    input: ProviderCredentialDeleteRequest,
  ) =>
    apiFetch<ProviderSettings>(connection, `/v1/providers/${encodeURIComponent(providerId)}/credential`, {
      method: "DELETE",
      body: JSON.stringify(input),
    }),
  startOpenAiSubscriptionAuth: (
    connection: ClientConnection,
    input: { method: "browser" | "device" },
  ) =>
    apiFetch<OpenAiSubscriptionAuthResponse>(connection, "/v1/providers/openai/subscription-auth", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  validateProviderCredential: (
    connection: ClientConnection,
    providerId: string,
    input: ProviderValidationRequest,
  ) =>
    apiFetch<{
      providerId: string;
      ok: boolean;
      live: boolean;
      baseUrl: string | null;
      modelId: string | null;
      credential: ProviderSettings["statuses"][string]["credential"];
      errors: string[];
      providers: ProviderSettings;
    }>(connection, `/v1/providers/${encodeURIComponent(providerId)}/validate`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  savePersonalization: (connection: ClientConnection, input: UpdatePersonalizationRequest) =>
    apiFetch<BootstrapPayload>(connection, "/v1/personalization", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  recordClientDiagnostic: (connection: ClientConnection, input: RecordClientDiagnosticRequest) =>
    apiFetch<{ diagnostic: RuntimeEvent }>(connection, "/v1/diagnostics/client", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  profileCurrent: (connection: ClientConnection) =>
    apiFetch<BootstrapPayload["profile"]>(connection, "/v1/profile"),
  profileInit: (
    connection: ClientConnection,
    input: { path?: string | null; profile?: string | null; template?: string | null; force?: boolean },
  ) =>
    apiFetch<BootstrapPayload["profile"]>(connection, "/v1/profile/init", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  profileLoad: (
    connection: ClientConnection,
    input: { path: string; profile?: string | null },
  ) =>
    apiFetch<BootstrapPayload["profile"]>(connection, "/v1/profile/load", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  profileCheck: (connection: ClientConnection, input: { kind?: string | null }) =>
    apiFetch<BootstrapPayload["profile"]>(connection, "/v1/profile/check", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  profileCommit: (connection: ClientConnection, input: { message?: string | null }) =>
    apiFetch<{
      committed: boolean;
      stdout: string;
      stderr: string;
      state: BootstrapPayload["profile"];
    }>(connection, "/v1/profile/commit", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  profilePush: (
    connection: ClientConnection,
    input: {
      teamId: string;
      ensureHosted?: boolean;
      force?: boolean;
      message?: string | null;
      hostedSourceAgentId?: string | null;
      hostedSourceProjectId?: string | null;
      hostedSourceChecks?: boolean;
      hostedSourceDispatch?: "request_only" | "coding_core" | null;
      publishHostedSource?: boolean;
      hostedCheckKind?: string | null;
      hostedRunAgentId?: string | null;
      hostedRunIdempotencyKey?: string | null;
      hostedRunInput?: Record<string, unknown> | null;
      hostedRunRetry?: boolean;
      expectedManifestHash?: string | null;
      workItemId?: string | null;
    },
  ) =>
    apiFetch<{
      profile: unknown;
      localProfile: BootstrapPayload["profile"];
      uploaded?: unknown;
    }>(connection, "/v1/profile/push", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  workspaceLspSettingsStatus: (connection: ClientConnection) =>
    apiFetch<WorkspaceLspSettingsStatusResponse>(connection, "/v1/lsp/settings-status"),
  workspaceLspRuntimeStatus: (connection: ClientConnection) =>
    apiFetch<WorkspaceLspRuntimeStatusResponse>(connection, "/v1/lsp/status"),
  restartWorkspaceLsp: (connection: ClientConnection) =>
    apiFetch<{ ok: boolean; updatedAt: string }>(connection, "/v1/lsp/restart", {
      method: "POST",
    }),
  remoteAccess: (connection: ClientConnection) =>
    apiFetch<RemoteAccessStatus>(connection, "/v1/remote-access"),
  enableRemoteAccess: (connection: ClientConnection) =>
    apiFetch<RemoteAccessToggleResponse>(connection, "/v1/remote-access/enable", {
      method: "POST",
    }),
  disableRemoteAccess: (connection: ClientConnection) =>
    apiFetch<RemoteAccessToggleResponse>(connection, "/v1/remote-access/disable", {
      method: "POST",
    }),
  voiceTranscriptionStatus: (connection: ClientConnection) =>
    apiFetch<VoiceTranscriptionStatus>(connection, "/v1/audio/transcriptions/status"),
  transcribeVoice: (connection: ClientConnection, input: VoiceTranscriptionRequest) =>
    apiFetch<VoiceTranscriptionResponse>(connection, "/v1/audio/transcriptions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createSession: (connection: ClientConnection, input: CreateSessionRequest) =>
    apiFetch<Session>(connection, "/v1/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  patchSession: (connection: ClientConnection, sessionId: string, input: PatchSessionRequest) =>
    apiFetch<Session>(connection, `/v1/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  codexHistoryThread: (
    connection: ClientConnection,
    sessionId: string,
    input: { limit?: number; tail?: boolean } = {},
  ) => {
    const params = new URLSearchParams();
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.tail) params.set("tail", "1");
    const query = params.size ? `?${params.toString()}` : "";
    return apiFetch<{ session: Session; events: RuntimeEvent[] }>(
      connection,
      `/v1/codex-history/${encodeURIComponent(sessionId)}${query}`,
    );
  },
  sendCodexHistoryTurn: (connection: ClientConnection, sessionId: string, input: SendTurnRequest) =>
    apiFetch<{ session: Session; events: RuntimeEvent[] }>(
      connection,
      `/v1/codex-history/${encodeURIComponent(sessionId)}/turns`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  interruptCodexHistoryTurn: (connection: ClientConnection, sessionId: string) =>
    apiFetch<CodexHistoryTurnInterruptResponse>(
      connection,
      `/v1/codex-history/${encodeURIComponent(sessionId)}/turns/interrupt`,
      {
        method: "POST",
      },
    ),
  patchSidebarAppPreference: (
    connection: ClientConnection,
    appId: string,
    input: PatchSidebarAppPreferenceRequest,
  ) =>
    apiFetch<SidebarAppPreference>(connection, `/v1/sidebar/apps/${encodeURIComponent(appId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  reorderSidebarApps: (connection: ClientConnection, input: ReorderSidebarAppsRequest) =>
    apiFetch<SidebarAppPreferences>(connection, "/v1/sidebar/apps/reorder", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  workspaceStatus: (
    connection: ClientConnection,
    appId: string,
    ensure = false,
    options: { signal?: AbortSignal } = {},
  ) =>
    apiFetch<WorkspaceState>(
      connection,
      `/v1/workspaces/${encodeURIComponent(appId)}${ensure ? "?ensure=1" : ""}`,
      { signal: options.signal },
    ),
  createWorkspaceBranch: (
    connection: ClientConnection,
    appId: string,
    input: WorkspaceBranchRequest,
  ) =>
    apiFetch<WorkspaceState>(connection, `/v1/workspaces/${encodeURIComponent(appId)}/branches`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  checkoutWorkspaceBranch: (
    connection: ClientConnection,
    appId: string,
    input: WorkspaceBranchRequest,
  ) =>
    apiFetch<WorkspaceState>(connection, `/v1/workspaces/${encodeURIComponent(appId)}/branch`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  workspaceDiff: (
    connection: ClientConnection,
    appId: string,
    options: { signal?: AbortSignal } = {},
  ) =>
    apiFetch<WorkspaceDiffSummary>(
      connection,
      `/v1/workspaces/${encodeURIComponent(appId)}/diff`,
      { signal: options.signal },
    ),
  workspaceFile: (connection: ClientConnection, appId: string, path: string) =>
    apiFetch<WorkspaceDiffFile>(
      connection,
      `/v1/workspaces/${encodeURIComponent(appId)}/file?path=${encodeURIComponent(path)}`,
    ),
  saveWorkspaceFile: (
    connection: ClientConnection,
    appId: string,
    input: SaveWorkspaceFileRequest,
  ) =>
    apiFetch<WorkspaceDiffFile>(
      connection,
      `/v1/workspaces/${encodeURIComponent(appId)}/file`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ),
  signWorkspaceImageUrl: (connection: ClientConnection, input: { appId: string; path: string }) =>
    apiFetch<{ url: string; expiresAt: number }>(connection, "/v1/assets/workspace-image-url", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  signLocalImageUrl: (connection: ClientConnection, input: { path: string }) =>
    apiFetch<{ url: string; expiresAt: number }>(connection, "/v1/assets/local-image-url", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  signChatAttachmentImageUrl: (
    connection: ClientConnection,
    input: NonNullable<ChatAttachmentSummary["imagePreview"]>,
  ) =>
    apiFetch<{ url: string; expiresAt: number }>(connection, "/v1/assets/chat-attachment-image-url", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  workspaceLspTouch: (
    connection: ClientConnection,
    appId: string,
    input: WorkspaceLspTouchRequest,
    options: { signal?: AbortSignal } = {},
  ) =>
    apiFetch<WorkspaceLspDiagnosticsResponse>(
      connection,
      `/v1/workspaces/${encodeURIComponent(appId)}/lsp/touch`,
      {
        method: "POST",
        body: JSON.stringify(input),
        signal: options.signal,
      },
    ),
  workspaceLspAction: (
    connection: ClientConnection,
    appId: string,
    input: WorkspaceLspActionRequest,
  ) =>
    apiFetch<WorkspaceLspActionResponse>(
      connection,
      `/v1/workspaces/${encodeURIComponent(appId)}/lsp/action`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  workspaceTemplateConfig: (connection: ClientConnection, appId: string) =>
    apiFetch<WorkspaceTemplateConfigView>(
      connection,
      `/v1/openpond/apps/${encodeURIComponent(appId)}/template-config`,
    ),
  ...organizationApi,
  ...sandboxApi,
  createLocalProject: (connection: ClientConnection, input: CreateLocalProjectRequest) =>
    apiFetch<{ project: LocalProject; bootstrap: BootstrapPayload; created?: boolean }>(connection, "/v1/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateLocalProjectAgentSetup: (
    connection: ClientConnection,
    projectId: string,
    input: UpdateLocalProjectAgentSetupRequest,
  ) =>
    apiFetch<{ project: LocalProject; bootstrap: BootstrapPayload }>(
      connection,
      `/v1/projects/${encodeURIComponent(projectId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ),
  uploadLocalProjectCloudSource: (
    connection: ClientConnection,
    projectId: string,
    input: UploadLocalProjectCloudSourceRequest,
  ) =>
    apiFetch<LocalProjectCloudSourceUploadResponse>(
      connection,
      `/v1/projects/${encodeURIComponent(projectId)}/cloud-source`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  previewLocalProjectCloudSource: (
    connection: ClientConnection,
    projectId: string,
    input: { branch?: string | null } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.branch?.trim()) query.set("branch", input.branch.trim());
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return apiFetch<LocalProjectCloudSourcePreviewResponse>(
      connection,
      `/v1/projects/${encodeURIComponent(projectId)}/cloud-source/preview${suffix}`,
    );
  },
  cloudWorkItems: (connection: ClientConnection, input: ListCloudWorkItemsRequest) => {
    const query = new URLSearchParams({
      teamId: input.teamId,
      limit: String(input.limit ?? 100),
    });
    for (const projectId of input.projectIds) query.append("projectId", projectId);
    if (input.includeArchived) query.set("includeArchived", "true");
    return apiFetch<CloudWorkItemsResponse>(
      connection,
      `/v1/cloud/work-items?${query.toString()}`,
    );
  },
  cloudWorkItem: (
    connection: ClientConnection,
    workItemId: string,
    input: { teamId: string },
  ) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<CloudWorkItemDetail>(
      connection,
      `/v1/cloud/work-items/${encodeURIComponent(workItemId)}?${query.toString()}`,
    );
  },
  createCloudWorkItem: (
    connection: ClientConnection,
    input: CreateCloudWorkItemRequest,
  ) =>
    apiFetch<CloudWorkItemDetail>(connection, "/v1/cloud/work-items", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sendCloudWorkItemMessage: (
    connection: ClientConnection,
    workItemId: string,
    input: SendCloudWorkItemMessageRequest,
  ) =>
    apiFetch<CloudWorkItemMessageResponse>(
      connection,
      `/v1/cloud/work-items/${encodeURIComponent(workItemId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  handleCloudWorkItemInBackground: (
    connection: ClientConnection,
    workItemId: string,
    input: CloudWorkItemBackgroundRequest,
  ) =>
    apiFetch<unknown>(
      connection,
      `/v1/cloud/work-items/${encodeURIComponent(workItemId)}/handle-background`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  cancelCloudWorkItemTask: (
    connection: ClientConnection,
    workItemId: string,
    input: { teamId: string },
  ) =>
    apiFetch<CloudWorkItemCancelTaskResponse>(
      connection,
      `/v1/cloud/work-items/${encodeURIComponent(workItemId)}/cancel-task`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  openCloudWorkItem: (
    connection: ClientConnection,
    workItemId: string,
    input: OpenCloudWorkItemRequest,
  ) =>
    apiFetch<CloudWorkItemOpenCloudResponse>(
      connection,
      `/v1/cloud/work-items/${encodeURIComponent(workItemId)}/open-cloud`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  applyCloudWorkItemLocalPatch: (
    connection: ClientConnection,
    workItemId: string,
    input: ApplyCloudWorkItemLocalPatchRequest,
  ) =>
    apiFetch<CloudWorkItemApplyLocalPatchResponse>(
      connection,
      `/v1/cloud/work-items/${encodeURIComponent(workItemId)}/apply-local`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  deleteLocalProject: (connection: ClientConnection, projectId: string) =>
    apiFetch<BootstrapPayload>(connection, `/v1/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE",
    }),
  gitAvailability: (connection: ClientConnection) =>
    apiFetch<GitAvailability>(connection, "/v1/system/git"),
  installMacOSCommandLineTools: (connection: ClientConnection) =>
    apiFetch<{ ok: true; message: string }>(
      connection,
      "/v1/system/git/install-command-line-tools",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ),
  ...sessionApi,
  resolveApproval: (
    connection: ClientConnection,
    approvalId: string,
    input: ResolveApprovalRequest,
  ) =>
    apiFetch<Approval>(connection, `/v1/approvals/${approvalId}`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

function usageSearchParams(input: {
  range?: "7d" | "30d" | "90d" | "all";
  visibility?: UsageVisibilityFilter;
  status?: UsageStatusFilter;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (input.range) params.set("range", input.range);
  if (input.visibility) params.set("visibility", input.visibility);
  if (input.status) params.set("status", input.status);
  return params;
}
