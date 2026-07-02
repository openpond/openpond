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

export const sandboxFileApi = {
  sandboxFiles: (
    connection: ClientConnection,
    sandboxId: string,
    input: { path?: string; recursive?: boolean; maxEntries?: number } = {},
  ) => {
    const query = new URLSearchParams({ list: "1" });
    if (input.path) query.set("path", input.path);
    if (input.recursive !== undefined) query.set("recursive", String(input.recursive));
    if (input.maxEntries !== undefined) query.set("maxEntries", String(input.maxEntries));
    return apiFetch<SandboxFileListResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files?${query.toString()}`,
    );
  },
  sandboxUploadFile: (
    connection: ClientConnection,
    sandboxId: string,
    input: { path: string; contents: string },
  ) =>
    apiFetch<SandboxFileUploadResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  sandboxDownloadFile: async (
    connection: ClientConnection,
    sandboxId: string,
    path: string,
    input: { offsetBytes?: number; maxBytes?: number } = {},
  ) => {
    const query = new URLSearchParams({ path });
    if (input.offsetBytes !== undefined) query.set("offsetBytes", String(input.offsetBytes));
    if (input.maxBytes !== undefined) query.set("maxBytes", String(input.maxBytes));
    const payload = await apiFetch<SandboxFileDownloadResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files?${query.toString()}`,
    );
    return {
      ...payload,
      contents: payload.file.isBinary ? "" : base64ToText(payload.file.contentsBase64),
    };
  },
  sandboxSearchFiles: (
    connection: ClientConnection,
    sandboxId: string,
    input: { query: string; path?: string; maxResults?: number },
  ) => {
    const query = new URLSearchParams({ search: "1", query: input.query });
    if (input.path) query.set("path", input.path);
    if (input.maxResults !== undefined) query.set("maxResults", String(input.maxResults));
    return apiFetch<SandboxFileSearchResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files?${query.toString()}`,
    );
  },
  sandboxDeleteFile: (
    connection: ClientConnection,
    sandboxId: string,
    input: { path: string; recursive?: boolean },
  ) => {
    const query = new URLSearchParams({ path: input.path });
    if (input.recursive !== undefined) query.set("recursive", String(input.recursive));
    return apiFetch<SandboxFileDeleteResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files?${query.toString()}`,
      {
        method: "DELETE",
      },
    );
  },
  sandboxStatFile: (connection: ClientConnection, sandboxId: string, path: string) => {
    const query = new URLSearchParams({ stat: "1", path });
    return apiFetch<SandboxFileStatResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files?${query.toString()}`,
    );
  },
  sandboxMkdir: (
    connection: ClientConnection,
    sandboxId: string,
    input: { path: string; recursive?: boolean },
  ) => {
    const query = new URLSearchParams({ path: input.path });
    if (input.recursive !== undefined) query.set("recursive", String(input.recursive));
    return apiFetch<SandboxFileMkdirResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files?${query.toString()}`,
      {
        method: "PUT",
      },
    );
  },
  sandboxMoveFile: (
    connection: ClientConnection,
    sandboxId: string,
    input: { fromPath: string; toPath: string; overwrite?: boolean },
  ) => {
    const query = new URLSearchParams({
      fromPath: input.fromPath,
      toPath: input.toPath,
    });
    if (input.overwrite !== undefined) query.set("overwrite", String(input.overwrite));
    return apiFetch<SandboxFileMoveResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files?${query.toString()}`,
      {
        method: "PATCH",
      },
    );
  },
};
