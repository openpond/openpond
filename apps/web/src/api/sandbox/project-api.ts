import type {
  Approval,
  BootstrapPayload,
  CloudWorkItem,
  CloudWorkItemDetail,
  CloudWorkItemMessage,
  CloudWorkItemBackgroundRequest,
  CloudProject,
  CompactSessionRequest,
  CreateCloudWorkItemRequest,
  CreateLocalProjectRequest,
  CreateSessionRequest,
  LocalProject,
  UpdateLocalProjectAgentSetupRequest,
  PatchSessionRequest,
  PatchSidebarAppPreferenceRequest,
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
  UpdateAppPreferencesRequest,
  UpdatePersonalizationRequest,
  UpdateProviderSettingsRequest,
  WorkspaceBranchRequest,
  WorkspaceDiffFile,
  WorkspaceDiffSummary,
  WorkspaceLspActionRequest,
  WorkspaceLspActionResponse,
  WorkspaceLspDiagnosticsResponse,
  WorkspaceLspSettingsStatusResponse,
  WorkspaceLspTouchRequest,
  WorkspaceState,
  WorkspaceTemplateConfigView,
  WorkspaceToolRequest,
  WorkspaceToolResult,
} from "@openpond/contracts";
import type {
  CreateOpenPondOrganizationRequest,
  GenerateOpenPondOrganizationMcpServerRequest,
  OpenPondOrganizationMemberResponse,
  OpenPondOrganizationMembersResponse,
  OpenPondOrganizationMcpServerResponse,
  OpenPondOrganizationResponse,
  OpenPondOrganizationsResponse,
  UpdateOpenPondOrganizationRequest,
  UpsertOpenPondOrganizationMemberRequest,
} from "../../lib/organization-types";
import type {
  SandboxRuntimeCreateInput,
  SandboxRuntimeResponse,
  SandboxRuntimeSandboxResponse,
  SandboxAgentRunInput,
  SandboxAgentRunResponse,
  SandboxAgentListResponse,
  SandboxAgentResponse,
  SandboxAgentUpsertInput,
  CreateSandboxRequest,
  ForkSandboxRequest,
  ForkSandboxSnapshotRequest,
  LaunchSandboxTemplateRequest,
  SandboxBillingStatusResponse,
  SandboxExecResponse,
  SandboxFileDeleteResponse,
  SandboxFileDownloadResponse,
  SandboxFileListResponse,
  SandboxFileMkdirResponse,
  SandboxFileMoveResponse,
  SandboxFileSearchResponse,
  SandboxFileStatResponse,
  SandboxFileUploadResponse,
  SandboxForkResponse,
  SandboxGitBranchResponse,
  SandboxGitCommitResponse,
  SandboxGitDiffResponse,
  SandboxGitPullResponse,
  SandboxGitPushResponse,
  SandboxGitStatusResponse,
  SandboxIntegrationConnectionLeaseInput,
  SandboxIntegrationConnectionsResponse,
  SandboxIntegrationConnectionStatusFilter,
  SandboxIntegrationLeasesResponse,
  SandboxListResponse,
  SandboxLogsResponse,
  SandboxOpenPortResponse,
  SandboxPreviewAuthPolicyInput,
  SandboxProjectListResponse,
  SandboxProjectResponse,
  SandboxProjectSourceUploadInput,
  SandboxProjectUpsertInput,
  SandboxProcessListResponse,
  SandboxProcessStartResponse,
  SandboxProcessStatusResponse,
  SandboxProcessStopResponse,
  SandboxPtyInputResponse,
  SandboxPtyListResponse,
  SandboxPtyStartResponse,
  SandboxPtyStatusResponse,
  SandboxPtyStopResponse,
  SandboxReceiptResponse,
  SandboxReceiptsResponse,
  SandboxRecordResponse,
  SandboxReplayArtifactsResponse,
  SandboxReplayInput,
  SandboxReplayListResponse,
  SandboxReplayLogsResponse,
  SandboxReplayResponse,
  SandboxSecretListResponse,
  SandboxSecretResponse,
  SandboxSnapshotCatalogResponse,
  SandboxSnapshotResponse,
  SandboxSnapshotValidateInput,
  SandboxSnapshotValidationResponse,
  SandboxSnapshotUpdateInput,
  SandboxTemplateBuildCreateInput,
  SandboxTemplateBuildListResponse,
  SandboxTemplateBuildLogsResponse,
  SandboxTemplateBuildResponse,
  SandboxTemplateCatalogResponse,
  SandboxTemplateLaunchResponse,
  SandboxVolumeCreateInput,
  SandboxVolumeListResponse,
  SandboxVolumeResponse,
} from "../../lib/sandbox-types";
import {
  apiFetch,
  base64ToText,
  sandboxScopeQuery,
  textToBase64,
  type ClientConnection,
  type SandboxScopeInput,
} from "../api-client";

export const sandboxProjectApi = {
  createSandbox: (connection: ClientConnection, input: CreateSandboxRequest) =>
    apiFetch<SandboxRecordResponse>(connection, "/v1/sandboxes", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listSandboxProjects: (connection: ClientConnection, input: { teamId: string }) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxProjectListResponse>(
      connection,
      `/v1/sandbox-projects?${query.toString()}`,
    );
  },
  upsertSandboxProject: (connection: ClientConnection, input: SandboxProjectUpsertInput) =>
    apiFetch<SandboxProjectResponse>(connection, "/v1/sandbox-projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sandboxProject: (connection: ClientConnection, projectId: string, input: { teamId: string }) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxProjectResponse>(
      connection,
      `/v1/sandbox-projects/${encodeURIComponent(projectId)}?${query.toString()}`,
    );
  },
  syncSandboxProject: (
    connection: ClientConnection,
    projectId: string,
    input: { teamId: string },
  ) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxProjectResponse>(
      connection,
      `/v1/sandbox-projects/${encodeURIComponent(projectId)}/sync?${query.toString()}`,
      { method: "POST" },
    );
  },
  uploadSandboxProjectSource: (
    connection: ClientConnection,
    projectId: string,
    input: SandboxProjectSourceUploadInput,
  ) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    const { teamId: _teamId, ...body } = input;
    return apiFetch<SandboxProjectResponse>(
      connection,
      `/v1/sandbox-projects/${encodeURIComponent(projectId)}/source?${query.toString()}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },
  archiveSandboxProject: (
    connection: ClientConnection,
    projectId: string,
    input: { teamId: string },
  ) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxProjectResponse>(
      connection,
      `/v1/sandbox-projects/${encodeURIComponent(projectId)}?${query.toString()}`,
      { method: "DELETE" },
    );
  },
  listSandboxAgents: (connection: ClientConnection, input: { teamId: string }) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxAgentListResponse>(
      connection,
      `/v1/sandbox-agents?${query.toString()}`,
    );
  },
  upsertSandboxAgent: (connection: ClientConnection, input: SandboxAgentUpsertInput) =>
    apiFetch<SandboxAgentResponse>(connection, "/v1/sandbox-agents", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sandboxAgent: (connection: ClientConnection, agentId: string, input: { teamId: string }) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxAgentResponse>(
      connection,
      `/v1/sandbox-agents/${encodeURIComponent(agentId)}?${query.toString()}`,
    );
  },
	  runSandboxAgent: (
	    connection: ClientConnection,
	    agentId: string,
	    input: SandboxAgentRunInput,
	  ) =>
    apiFetch<SandboxAgentRunResponse>(
      connection,
      `/v1/sandbox-agents/${encodeURIComponent(agentId)}/run`,
      {
        method: "POST",
        body: JSON.stringify(input),
	      },
	    ),
	  runProfileAction: (
	    connection: ClientConnection,
	    input: { action: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> },
	  ) =>
	    apiFetch<{ action: string; stdout: string; stderr: string; code: number | null }>(
	      connection,
	      "/v1/profile/run",
	      {
	        method: "POST",
	        body: JSON.stringify(input),
	      },
	    ),
	  archiveSandboxAgent: (
    connection: ClientConnection,
    agentId: string,
    input: { teamId: string },
  ) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxAgentResponse>(
      connection,
      `/v1/sandbox-agents/${encodeURIComponent(agentId)}?${query.toString()}`,
      { method: "DELETE" },
    );
  },
};
