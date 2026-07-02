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

export const sandboxTemplateApi = {
  sandboxTemplates: (
    connection: ClientConnection,
    input: {
      teamId?: string;
      projectId?: string;
      q?: string;
      name?: string;
      version?: string;
      tag?: string;
      useCase?: string;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.q) query.set("q", input.q);
    if (input.name) query.set("name", input.name);
    if (input.version) query.set("version", input.version);
    if (input.tag) query.set("tag", input.tag);
    if (input.useCase) query.set("useCase", input.useCase);
    return apiFetch<SandboxTemplateCatalogResponse>(
      connection,
      `/v1/sandboxes/templates${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  sandboxTemplateBuilds: (
    connection: ClientConnection,
    input: {
      teamId: string;
    },
  ) => {
    const query = new URLSearchParams({ teamId: input.teamId });
    return apiFetch<SandboxTemplateBuildListResponse>(
      connection,
      `/v1/sandbox-template-builds?${query.toString()}`,
    );
  },
  createSandboxTemplateBuild: (
    connection: ClientConnection,
    input: SandboxTemplateBuildCreateInput,
  ) =>
    apiFetch<SandboxTemplateBuildResponse>(connection, "/v1/sandbox-template-builds", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sandboxTemplateBuild: (connection: ClientConnection, buildId: string) =>
    apiFetch<SandboxTemplateBuildResponse>(
      connection,
      `/v1/sandbox-template-builds/${encodeURIComponent(buildId)}`,
    ),
  sandboxTemplateBuildLogs: (connection: ClientConnection, buildId: string) =>
    apiFetch<SandboxTemplateBuildLogsResponse>(
      connection,
      `/v1/sandbox-template-builds/${encodeURIComponent(buildId)}/logs`,
    ),
  cancelSandboxTemplateBuild: (connection: ClientConnection, buildId: string) =>
    apiFetch<SandboxTemplateBuildResponse>(
      connection,
      `/v1/sandbox-template-builds/${encodeURIComponent(buildId)}/cancel`,
      {
        method: "POST",
      },
    ),
  launchSandboxTemplate: (
    connection: ClientConnection,
    input: LaunchSandboxTemplateRequest,
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    const { teamId: _teamId, projectId: _projectId, ...body } = input;
    return apiFetch<SandboxTemplateLaunchResponse>(
      connection,
      `/v1/sandboxes/templates/launch${query.size > 0 ? `?${query.toString()}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },
};
