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

export const sandboxCatalogApi = {
  sandboxes: (
    connection: ClientConnection,
    input: SandboxScopeInput = {},
  ) => {
    const query = sandboxScopeQuery(input);
    return apiFetch<SandboxListResponse>(
      connection,
      `/v1/sandboxes${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  sandboxVolumes: (
    connection: ClientConnection,
    input: SandboxScopeInput = {},
  ) => {
    const query = sandboxScopeQuery(input);
    return apiFetch<SandboxVolumeListResponse>(
      connection,
      `/v1/sandboxes/volumes${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  createSandboxVolume: (connection: ClientConnection, input: SandboxVolumeCreateInput) =>
    apiFetch<SandboxVolumeResponse>(connection, "/v1/sandboxes/volumes", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteSandboxVolume: (
    connection: ClientConnection,
    volumeId: string,
    input: SandboxScopeInput = {},
  ) => {
    const query = sandboxScopeQuery(input);
    return apiFetch<SandboxVolumeResponse>(
      connection,
      `/v1/sandboxes/volumes/${encodeURIComponent(volumeId)}${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      { method: "DELETE" },
    );
  },
  sandboxSnapshotCatalog: (
    connection: ClientConnection,
    input: {
      teamId?: string;
      projectId?: string;
      agentId?: string;
      q?: string;
      replayState?: "draft" | "validated" | "published";
      tag?: string;
      useCase?: string;
    } = {},
  ) => {
    const query = sandboxScopeQuery(input);
    if (input.q) query.set("q", input.q);
    if (input.replayState) query.set("replayState", input.replayState);
    if (input.tag) query.set("tag", input.tag);
    if (input.useCase) query.set("useCase", input.useCase);
    return apiFetch<SandboxSnapshotCatalogResponse>(
      connection,
      `/v1/sandboxes/snapshots${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
};
