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

export const sandboxIntegrationApi = {
  integrationConnections: (
    connection: ClientConnection,
    input: {
      teamId?: string;
      projectId?: string;
      agentId?: string;
      status?: SandboxIntegrationConnectionStatusFilter;
    } = {},
  ) => {
    const query = sandboxScopeQuery(input);
    if (input.status) query.set("status", input.status);
    return apiFetch<SandboxIntegrationConnectionsResponse>(
      connection,
      `/v1/integrations/connections${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  sandboxIntegrationLeases: (connection: ClientConnection, sandboxId: string) =>
    apiFetch<SandboxIntegrationLeasesResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/integrations`,
    ),
  attachSandboxIntegrationConnection: (
    connection: ClientConnection,
    sandboxId: string,
    input: SandboxIntegrationConnectionLeaseInput,
  ) =>
    apiFetch<SandboxIntegrationLeasesResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/integrations`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  removeSandboxIntegrationLease: (
    connection: ClientConnection,
    sandboxId: string,
    leaseId: string,
  ) =>
    apiFetch<SandboxIntegrationLeasesResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/integrations`,
      {
        method: "DELETE",
        body: JSON.stringify({ leaseId }),
      },
    ),
  sandboxSecrets: (
    connection: ClientConnection,
    input: SandboxScopeInput = {},
  ) => {
    const query = sandboxScopeQuery(input);
    return apiFetch<SandboxSecretListResponse>(
      connection,
      `/v1/sandbox-secrets${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  sandboxSecret: (
    connection: ClientConnection,
    secretId: string,
    input: SandboxScopeInput = {},
  ) => {
    const query = sandboxScopeQuery(input);
    return apiFetch<SandboxSecretResponse>(
      connection,
      `/v1/sandbox-secrets/${encodeURIComponent(secretId)}${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
    );
  },
  createSandboxSecret: (
    connection: ClientConnection,
    input: {
      teamId?: string;
      name: string;
      value: string;
      description?: string;
      scope?: "team" | "app" | "project" | "template";
    },
  ) =>
    apiFetch<SandboxSecretResponse>(connection, "/v1/sandbox-secrets", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  rotateSandboxSecret: (
    connection: ClientConnection,
    secretId: string,
    input: { teamId?: string; value: string },
  ) =>
    apiFetch<SandboxSecretResponse>(
      connection,
      `/v1/sandbox-secrets/${encodeURIComponent(secretId)}/rotate`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
};
