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

export const sandboxReplayApi = {
  sandboxReplays: (
    connection: ClientConnection,
    input: {
      teamId?: string;
      projectId?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return apiFetch<SandboxReplayListResponse>(
      connection,
      `/v1/sandbox-replays${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  startSandboxReplay: (
    connection: ClientConnection,
    input: SandboxReplayInput & { teamId?: string; projectId?: string },
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    const { teamId: _teamId, projectId: _projectId, ...body } = input;
    return apiFetch<SandboxReplayResponse>(
      connection,
      `/v1/sandbox-replays${query.size > 0 ? `?${query.toString()}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },
  sandboxReplay: (
    connection: ClientConnection,
    replayId: string,
    input: {
      teamId?: string;
      projectId?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return apiFetch<SandboxReplayResponse>(
      connection,
      `/v1/sandbox-replays/${encodeURIComponent(replayId)}${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
    );
  },
  sandboxReplayLogs: (
    connection: ClientConnection,
    replayId: string,
    input: {
      teamId?: string;
      projectId?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return apiFetch<SandboxReplayLogsResponse>(
      connection,
      `/v1/sandbox-replays/${encodeURIComponent(replayId)}/logs${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
    );
  },
  sandboxReplayArtifacts: (
    connection: ClientConnection,
    replayId: string,
    input: {
      teamId?: string;
      projectId?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return apiFetch<SandboxReplayArtifactsResponse>(
      connection,
      `/v1/sandbox-replays/${encodeURIComponent(replayId)}/artifacts${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
    );
  },
  cancelSandboxReplay: (
    connection: ClientConnection,
    replayId: string,
    input: {
      teamId?: string;
      projectId?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return apiFetch<SandboxReplayResponse>(
      connection,
      `/v1/sandbox-replays/${encodeURIComponent(replayId)}/cancel${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "POST",
      },
    );
  },
};
