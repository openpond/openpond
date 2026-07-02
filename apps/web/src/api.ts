import type {
  Approval,
  BootstrapPayload,
  CloudWorkItemBackgroundRequest,
  CloudWorkItemDetail,
  CompactSessionRequest,
  CreateCloudWorkItemRequest,
  CreateLocalProjectRequest,
  CreateSessionRequest,
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
  ListCloudWorkItemsRequest,
  OpenCloudWorkItemRequest,
  SendCloudWorkItemMessageRequest,
  UploadLocalProjectCloudSourceRequest,
  Turn,
  UpdateTurnCreatePipelineRequest,
  UpdateAppPreferencesRequest,
  UpdatePersonalizationRequest,
  UpdateProviderSettingsRequest,
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
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from "@openpond/contracts";
import { apiFetch, type ClientConnection } from "./api/api-client";
import { organizationApi } from "./api/organization-api";
import { sandboxApi } from "./api/sandbox";
import type {
  CloudWorkItemCancelTaskResponse,
  CloudWorkItemMessageResponse,
  CloudWorkItemOpenCloudResponse,
  CloudWorkItemsResponse,
  GitAvailability,
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
  LocalProjectCloudSourceUploadResponse,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResponse,
  VoiceTranscriptionStatus,
} from "./api/types";

export const api = {
  bootstrap: (connection: ClientConnection) =>
    apiFetch<BootstrapPayload>(connection, "/v1/bootstrap?refreshCodex=1"),
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
  savePreferences: (connection: ClientConnection, input: UpdateAppPreferencesRequest) =>
    apiFetch<BootstrapPayload>(connection, "/v1/preferences", {
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
    input: { teamId: string; ensureHosted?: boolean; force?: boolean; message?: string | null },
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
  sendTurn: (connection: ClientConnection, sessionId: string, input: SendTurnRequest) =>
    apiFetch<Turn>(connection, `/v1/sessions/${sessionId}/turns`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateTurnCreatePipeline: (
    connection: ClientConnection,
    sessionId: string,
    turnId: string,
    input: UpdateTurnCreatePipelineRequest,
  ) =>
    apiFetch<Turn>(
      connection,
      `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/create-pipeline`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  interruptTurn: (connection: ClientConnection, sessionId: string) =>
    apiFetch<Turn>(connection, `/v1/sessions/${sessionId}/turns/interrupt`, {
      method: "POST",
    }),
  compactSession: (
    connection: ClientConnection,
    sessionId: string,
    input: CompactSessionRequest = { reason: "manual" },
  ) =>
    apiFetch<unknown>(connection, `/v1/sessions/${sessionId}/compact`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  workspaceTool: (connection: ClientConnection, sessionId: string, input: WorkspaceToolRequest) =>
    apiFetch<WorkspaceToolResult>(connection, `/v1/sessions/${sessionId}/workspace-tools`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
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
