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

export const sandboxRuntimeApi = {
  createSandboxRuntime: (
    connection: ClientConnection,
    input: SandboxRuntimeCreateInput,
  ) =>
    apiFetch<SandboxRuntimeResponse>(connection, "/v1/runtimes", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createSandboxRuntimeSandbox: (
    connection: ClientConnection,
    runtimeId: string,
    input: CreateSandboxRequest,
  ) =>
    apiFetch<SandboxRuntimeSandboxResponse>(
      connection,
      `/v1/runtimes/${encodeURIComponent(runtimeId)}/sandbox`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  sandbox: (connection: ClientConnection, sandboxId: string) =>
    apiFetch<SandboxRecordResponse>(connection, `/v1/sandboxes/${encodeURIComponent(sandboxId)}`),
  deleteSandbox: (
    connection: ClientConnection,
    sandboxId: string,
    options: { failOnUnpreservedChanges?: boolean } = {},
  ) => {
    const query = new URLSearchParams();
    if (options.failOnUnpreservedChanges) query.set("failOnUnpreservedChanges", "true");
    return apiFetch<SandboxRecordResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "DELETE",
      },
    );
  },
  execSandboxCommand: (
    connection: ClientConnection,
    sandboxId: string,
    input: { command: string; timeoutSeconds?: number },
  ) =>
    apiFetch<SandboxExecResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  openSandboxPort: (
    connection: ClientConnection,
    sandboxId: string,
    input: {
      port: number;
      label?: string;
      access?: "private" | "public";
      autoStart?: boolean;
      customDomain?: string;
      authPolicy?: SandboxPreviewAuthPolicyInput;
    },
  ) =>
    apiFetch<SandboxOpenPortResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/ports`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  updateSandboxSnapshot: (
    connection: ClientConnection,
    sandboxId: string,
    snapshotId: string,
    input: SandboxSnapshotUpdateInput,
  ) =>
    apiFetch<SandboxSnapshotResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/snapshots/${encodeURIComponent(
        snapshotId,
      )}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ),
  validateSandboxSnapshot: (
    connection: ClientConnection,
    sandboxId: string,
    snapshotId: string,
    input: SandboxSnapshotValidateInput = {},
  ) =>
    apiFetch<SandboxSnapshotValidationResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/snapshots/${encodeURIComponent(
        snapshotId,
      )}/validate`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  publishSandboxSnapshot: (
    connection: ClientConnection,
    sandboxId: string,
    snapshotId: string,
  ) =>
    apiFetch<SandboxSnapshotResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/snapshots/${encodeURIComponent(
        snapshotId,
      )}/publish`,
      {
        method: "POST",
      },
    ),
  forkSandbox: (
    connection: ClientConnection,
    sandboxId: string,
    input: ForkSandboxRequest = {},
  ) =>
    apiFetch<SandboxForkResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/fork`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  forkSandboxSnapshot: (
    connection: ClientConnection,
    snapshotId: string,
    input: ForkSandboxSnapshotRequest = {},
  ) => {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    const { teamId: _teamId, projectId: _projectId, ...body } = input;
    return apiFetch<SandboxForkResponse>(
      connection,
      `/v1/sandboxes/snapshots/${encodeURIComponent(snapshotId)}/fork${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "POST",
        body: JSON.stringify({
          ...body,
          snapshotId,
        }),
      },
    );
  },
  stopSandbox: (
    connection: ClientConnection,
    sandboxId: string,
    options: { failOnUnpreservedChanges?: boolean } = {},
  ) => {
    const query = new URLSearchParams();
    if (options.failOnUnpreservedChanges) query.set("failOnUnpreservedChanges", "true");
    return apiFetch<SandboxReceiptResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/stop${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );
  },
  sandboxReceipts: (connection: ClientConnection, sandboxId: string) =>
    apiFetch<SandboxReceiptsResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/receipts`,
    ),
  sandboxLogs: (connection: ClientConnection, sandboxId: string) =>
    apiFetch<SandboxLogsResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/logs`,
    ),
  sandboxBilling: (connection: ClientConnection, sandboxId: string) =>
    apiFetch<SandboxBillingStatusResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/billing`,
    ),
  startSandboxProcess: (
    connection: ClientConnection,
    sandboxId: string,
    input: { command: string; timeoutSeconds?: number },
  ) =>
    apiFetch<SandboxProcessStartResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/processes`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  sandboxProcesses: (connection: ClientConnection, sandboxId: string) =>
    apiFetch<SandboxProcessListResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/processes`,
    ),
  sandboxProcess: (
    connection: ClientConnection,
    sandboxId: string,
    processId: string,
    input: { since?: number } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.since !== undefined) query.set("since", String(input.since));
    return apiFetch<SandboxProcessStatusResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/processes/${encodeURIComponent(
        processId,
      )}${query.size > 0 ? `?${query.toString()}` : ""}`,
    );
  },
  stopSandboxProcess: (connection: ClientConnection, sandboxId: string, processId: string) =>
    apiFetch<SandboxProcessStopResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/processes/${encodeURIComponent(
        processId,
      )}`,
      {
        method: "DELETE",
      },
    ),
  startSandboxPty: (
    connection: ClientConnection,
    sandboxId: string,
    input: { command?: string; timeoutSeconds?: number; rows?: number; cols?: number },
  ) =>
    apiFetch<SandboxPtyStartResponse>(connection, `/v1/sandboxes/${encodeURIComponent(sandboxId)}/pty`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sandboxPtys: (connection: ClientConnection, sandboxId: string) =>
    apiFetch<SandboxPtyListResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/pty`,
    ),
  sandboxPty: (
    connection: ClientConnection,
    sandboxId: string,
    ptyId: string,
    input: { since?: number } = {},
  ) => {
    const query = new URLSearchParams();
    if (input.since !== undefined) query.set("since", String(input.since));
    return apiFetch<SandboxPtyStatusResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/pty/${encodeURIComponent(ptyId)}${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
    );
  },
  writeSandboxPty: (
    connection: ClientConnection,
    sandboxId: string,
    ptyId: string,
    input: string,
  ) =>
    apiFetch<SandboxPtyInputResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/pty/${encodeURIComponent(ptyId)}/input`,
      {
        method: "POST",
        body: JSON.stringify({ dataBase64: textToBase64(input) }),
      },
    ),
  stopSandboxPty: (connection: ClientConnection, sandboxId: string, ptyId: string) =>
    apiFetch<SandboxPtyStopResponse>(
      connection,
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/pty/${encodeURIComponent(ptyId)}`,
      {
        method: "DELETE",
      },
    ),
};
