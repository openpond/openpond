import { apiFetch, readApiJson } from "../api/core.js";
import { DEFAULT_OPENPOND_API_BASE_URL } from "../urls.js";
import { asyncRequestHeaders } from "./async-request-options.js";
import { normalizePtyInput, streamSandboxEventOutput } from "./stream.js";
import type {
  SandboxIntegrationConnectionStatusFilter,
  SandboxIntegrationConnectionLeaseInput,
  SandboxCreateInput,
  SandboxCreateOptions,
  SandboxAsyncRequestOptions,
  SandboxScheduleCreateInput,
  SandboxScheduleUpdateInput,
  SandboxForkInput,
  SandboxForkOptions,
  SandboxTemplateLaunchInput,
  SandboxPublishedSnapshotBuildCreateInput,
  SandboxPublishedSnapshotBuildRecord,
  SandboxSecretMetadata,
  SandboxSecretCreateInput,
  SandboxSecretRotateInput,
  SandboxSecretAttachInput,
  SandboxSecretListResponse,
  SandboxSecretResponse,
  SandboxExecInput,
  SandboxProcessStartInput,
  SandboxPtyStartInput,
  SandboxPtyInput,
  SandboxOpenPortInput,
  SandboxGitDiffInput,
  SandboxGitPatchExportInput,
  SandboxGitBranchInput,
  SandboxGitCommitInput,
  SandboxGitPullInput,
  SandboxGitPushInput,
  SandboxFileDownloadInput,
  SandboxFileListInput,
  SandboxFileMkdirInput,
  SandboxFileMoveInput,
  SandboxFileSearchInput,
  SandboxReceipt,
  SandboxSnapshotTemplateVisibility,
  SandboxSnapshotValidateInput,
  SandboxSnapshotUpdateInput,
  SandboxSnapshotInput,
  SandboxTemplateBuildCreateInput,
  SandboxTemplateBuildRecord,
  OpenPondOrganization,
  OpenPondOrganizationCreateInput,
  OpenPondOrganizationUpdateInput,
  OpenPondOrganizationMember,
  OpenPondOrganizationMemberUpsertInput,
  OpenPondOrganizationMcpServer,
  OpenPondOrganizationMcpGenerateInput,
  SandboxProject,
  OpenPondHostedProfilePushInput,
  OpenPondHostedProfilePushResponse,
  OpenPondHostedProfileResponse,
  OpenPondHostedProfileSummary,
  SandboxAgent,
  SandboxProjectUpsertInput,
  SandboxProjectUpdateInput,
  SandboxProjectSourceUploadInput,
  SandboxProjectGitRemoteResponse,
  SandboxAgentUpsertInput,
  SandboxAgentUpdateInput,
  SandboxAgentRunInput,
  SandboxAgentSourceChecksRequestInput,
  SandboxAgentSourceChecksRequestResult,
  SandboxAgentSourceDeployPlan,
  SandboxAgentSourceDeployPlanResponse,
  SandboxAgentSourcePublishInput,
  SandboxAgentSourcePublishResult,
  SandboxAgentEditWorkItemOpenInput,
  SandboxAgentEditWorkItemOpenResult,
  SandboxCodingWorkItem,
  SandboxCodingWorkItemActivity,
  SandboxCodingWorkItemActivityListInput,
  SandboxCodingWorkItemArtifact,
  SandboxCodingWorkItemBackgroundInput,
  SandboxCodingWorkItemBackgroundResult,
  SandboxCodingWorkItemChatInput,
  SandboxCodingWorkItemChatResult,
  SandboxCodingWorkItemGetInput,
  SandboxCodingWorkItemPromotionInput,
  SandboxCodingWorkItemStatusResult,
  SandboxAgentManifestSnapshot,
  SandboxAgentManifestSnapshotsResponse,
  SandboxProjectListResponse,
  SandboxProjectResponse,
  SandboxAgentListResponse,
  SandboxAgentResponse,
  SandboxAgentRunResponse,
  MicrosoftTeamsBotOverview,
  MicrosoftTeamsBotBindingTargetInput,
  MicrosoftTeamsBotBindingResponse,
  MicrosoftTeamsBotDiagnosticRunInput,
  MicrosoftTeamsBotDiagnosticRunResponse,
  SandboxRecord,
  SandboxCreateResponse,
  SandboxSnapshotCatalogResponse,
  SandboxPublishedSnapshotCatalogResponse,
  SandboxTemplateCatalogResponse,
  SandboxRuntime,
  SandboxRuntimeCreateInput,
  SandboxRuntimeSandboxCreateInput,
  SandboxRuntimeEventInput,
  SandboxRuntimeCheckpointInput,
  SandboxRuntimePromoteInput,
  SandboxRuntimeSourcePreserveInput,
  SandboxRuntimeTransitionInput,
  SandboxRuntimeListResponse,
  SandboxRuntimeResponse,
  SandboxRuntimeSandboxResponse,
  SandboxRuntimeEventResponse,
  SandboxRuntimeEventsResponse,
  SandboxRuntimePromoteResponse,
  SandboxRuntimeSourcePreserveResponse,
  SandboxIntegrationConnectionsResponse,
  SandboxIntegrationLeasesResponse,
  SandboxExecResponse,
  SandboxProcessStartResponse,
  SandboxProcessListResponse,
  SandboxProcessStatusResponse,
  SandboxProcessStopResponse,
  SandboxPtyStartResponse,
  SandboxPtyListResponse,
  SandboxPtyStatusResponse,
  SandboxPtyInputResponse,
  SandboxPtyStopResponse,
  SandboxOpenPortResponse,
  SandboxSnapshotResponse,
  SandboxSnapshotValidationResponse,
  SandboxForkResponse,
  SandboxPublishedSnapshotLaunchResponse,
  SandboxTemplateLaunchResponse,
  SandboxScheduleListResponse,
  SandboxScheduleResponse,
  SandboxScheduleRunListResponse,
  SandboxScheduleRunResponse,
  SandboxReplayInput,
  SandboxReplayResponse,
  SandboxReplayListResponse,
  SandboxReplayLogsResponse,
  SandboxReplayArtifactsResponse,
  SandboxPublishedSnapshotBuildResponse,
  SandboxPublishedSnapshotBuildListResponse,
  SandboxPublishedSnapshotBuildLogsResponse,
  SandboxTemplateBuildResponse,
  SandboxTemplateBuildListResponse,
  SandboxTemplateBuildLogsResponse,
  OpenPondOrganizationsResponse,
  OpenPondOrganizationResponse,
  OpenPondOrganizationMembersResponse,
  OpenPondOrganizationMemberResponse,
  OpenPondOrganizationMcpServerResponse,
  SandboxReceiptResponse,
  SandboxLifecycleAcceptedResponse,
  SandboxStartResponse,
  SandboxRestoreResponse,
  SandboxReceiptsResponse,
  SandboxLogsResponse,
  SandboxGitStatusResponse,
  SandboxGitDiffResponse,
  SandboxGitPatchExportResponse,
  SandboxGitBranchResponse,
  SandboxGitCommitResponse,
  SandboxGitPullResponse,
  SandboxGitPushResponse,
  SandboxFileUploadResponse,
  SandboxFileDownloadResponse,
  SandboxFileListResponse,
  SandboxFileDeleteResponse,
  SandboxFileMkdirResponse,
  SandboxFileMoveResponse,
  SandboxFileStatResponse,
  SandboxFileSearchResponse,
  SandboxBillingStatusResponse,
  SandboxPricingResponse,
  SandboxCostSummaryResponse,
  SandboxSmokeOptions,
  SandboxSmokeSummary,
  OpenPondSandboxClientOptions,
  OpenPondSandboxMcpServerConfig,
  OpenPondSandboxRuntimeHandle,
} from "./types/index.js";

import { apiRootUrlFromSandboxApiUrl, normalizeSandboxApiUrl } from "./url.js";

export class OpenPondSandboxInstanceClient {
  protected readonly apiKey: string;
  private readonly apiRootUrl: string;
  protected readonly sandboxApiUrl: string;

  constructor(options: OpenPondSandboxClientOptions) {
    this.apiKey = options.apiKey;
    this.sandboxApiUrl = normalizeSandboxApiUrl(
      options.sandboxApiUrl ?? options.baseUrl ?? DEFAULT_OPENPOND_API_BASE_URL
    );
    this.apiRootUrl = apiRootUrlFromSandboxApiUrl(this.sandboxApiUrl);
  }

  create(
    input: SandboxCreateInput,
    options: SandboxCreateOptions = {}
  ): Promise<SandboxRecord> {
    return this.request<SandboxCreateResponse>("", {
      method: "POST",
      headers: asyncRequestHeaders(options),
      body: JSON.stringify(input),
    }).then((payload) => payload.sandbox);
  }

  get(sandboxId: string): Promise<SandboxRecord> {
    return this.request<{ sandbox: SandboxRecord }>(
      `/${encodeURIComponent(sandboxId)}`
    ).then((payload) => payload.sandbox);
  }

  exec(
    sandboxId: string,
    input: SandboxExecInput
  ): Promise<SandboxExecResponse> {
    return this.request<SandboxExecResponse>(
      `/${encodeURIComponent(sandboxId)}/exec`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  startProcess(
    sandboxId: string,
    input: SandboxProcessStartInput
  ): Promise<SandboxProcessStartResponse> {
    return this.request<SandboxProcessStartResponse>(
      `/${encodeURIComponent(sandboxId)}/processes`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  listProcesses(sandboxId: string): Promise<SandboxProcessListResponse> {
    return this.request<SandboxProcessListResponse>(
      `/${encodeURIComponent(sandboxId)}/processes`
    );
  }

  getProcess(
    sandboxId: string,
    processId: string,
    input: { since?: number } = {}
  ): Promise<SandboxProcessStatusResponse> {
    const query = new URLSearchParams();
    if (input.since !== undefined)
      query.set("since", String(Math.max(0, input.since)));
    return this.request<SandboxProcessStatusResponse>(
      `/${encodeURIComponent(sandboxId)}/processes/${encodeURIComponent(
        processId
      )}${query.size > 0 ? `?${query.toString()}` : ""}`
    );
  }

  stopProcess(
    sandboxId: string,
    processId: string
  ): Promise<SandboxProcessStopResponse> {
    return this.request<SandboxProcessStopResponse>(
      `/${encodeURIComponent(sandboxId)}/processes/${encodeURIComponent(
        processId
      )}`,
      {
        method: "DELETE",
      }
    );
  }

  async streamProcessOutput(
    sandboxId: string,
    processId: string,
    input: { since?: number } = {}
  ): Promise<void> {
    const query = new URLSearchParams();
    if (input.since !== undefined)
      query.set("since", String(Math.max(0, input.since)));
    await streamSandboxEventOutput({
      sandboxApiUrl: this.sandboxApiUrl,
      apiKey: this.apiKey,
      path: `/${encodeURIComponent(sandboxId)}/processes/${encodeURIComponent(
        processId
      )}/stream${query.size > 0 ? `?${query.toString()}` : ""}`,
    });
  }

  startPty(
    sandboxId: string,
    input: SandboxPtyStartInput = {}
  ): Promise<SandboxPtyStartResponse> {
    return this.request<SandboxPtyStartResponse>(
      `/${encodeURIComponent(sandboxId)}/pty`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  listPtys(sandboxId: string): Promise<SandboxPtyListResponse> {
    return this.request<SandboxPtyListResponse>(
      `/${encodeURIComponent(sandboxId)}/pty`
    );
  }

  getPty(
    sandboxId: string,
    ptyId: string,
    input: { since?: number } = {}
  ): Promise<SandboxPtyStatusResponse> {
    const query = new URLSearchParams();
    if (input.since !== undefined)
      query.set("since", String(Math.max(0, input.since)));
    return this.request<SandboxPtyStatusResponse>(
      `/${encodeURIComponent(sandboxId)}/pty/${encodeURIComponent(ptyId)}${
        query.size > 0 ? `?${query.toString()}` : ""
      }`
    );
  }

  writePtyInput(
    sandboxId: string,
    ptyId: string,
    input: string | Uint8Array | SandboxPtyInput
  ): Promise<SandboxPtyInputResponse> {
    return this.request<SandboxPtyInputResponse>(
      `/${encodeURIComponent(sandboxId)}/pty/${encodeURIComponent(
        ptyId
      )}/input`,
      {
        method: "POST",
        body: JSON.stringify(normalizePtyInput(input)),
      }
    );
  }

  stopPty(sandboxId: string, ptyId: string): Promise<SandboxPtyStopResponse> {
    return this.request<SandboxPtyStopResponse>(
      `/${encodeURIComponent(sandboxId)}/pty/${encodeURIComponent(ptyId)}`,
      {
        method: "DELETE",
      }
    );
  }

  async streamPtyOutput(
    sandboxId: string,
    ptyId: string,
    input: { since?: number } = {}
  ): Promise<void> {
    const query = new URLSearchParams();
    if (input.since !== undefined)
      query.set("since", String(Math.max(0, input.since)));
    await streamSandboxEventOutput({
      sandboxApiUrl: this.sandboxApiUrl,
      apiKey: this.apiKey,
      path: `/${encodeURIComponent(sandboxId)}/pty/${encodeURIComponent(
        ptyId
      )}/stream${query.size > 0 ? `?${query.toString()}` : ""}`,
    });
  }

  uploadFile(
    sandboxId: string,
    path: string,
    contents: string
  ): Promise<SandboxFileUploadResponse> {
    return this.uploadFileBase64(
      sandboxId,
      path,
      Buffer.from(contents, "utf-8").toString("base64")
    );
  }

  uploadFileBase64(
    sandboxId: string,
    path: string,
    contentsBase64: string
  ): Promise<SandboxFileUploadResponse> {
    return this.request<SandboxFileUploadResponse>(
      `/${encodeURIComponent(sandboxId)}/files`,
      {
        method: "POST",
        body: JSON.stringify({
          path,
          contentsBase64,
        }),
      }
    );
  }

  async downloadFile(sandboxId: string, path: string): Promise<string> {
    const payload = await this.downloadFileResponse(sandboxId, path);
    return Buffer.from(payload.file.contentsBase64, "base64").toString("utf-8");
  }

  downloadFileResponse(
    sandboxId: string,
    input: string | SandboxFileDownloadInput
  ): Promise<SandboxFileDownloadResponse> {
    const normalized = typeof input === "string" ? { path: input } : input;
    const query = new URLSearchParams({ path: normalized.path });
    if (normalized.offsetBytes !== undefined) {
      query.set("offsetBytes", String(normalized.offsetBytes));
    }
    if (normalized.maxBytes !== undefined) {
      query.set("maxBytes", String(normalized.maxBytes));
    }
    return this.request<SandboxFileDownloadResponse>(
      `/${encodeURIComponent(sandboxId)}/files?${query.toString()}`
    );
  }

  listFiles(
    sandboxId: string,
    input: SandboxFileListInput = {}
  ): Promise<SandboxFileListResponse> {
    const query = new URLSearchParams({ list: "1" });
    if (input.path) query.set("path", input.path);
    if (input.recursive !== undefined)
      query.set("recursive", String(input.recursive));
    if (input.maxEntries !== undefined)
      query.set("maxEntries", String(input.maxEntries));
    return this.request<SandboxFileListResponse>(
      `/${encodeURIComponent(sandboxId)}/files?${query.toString()}`
    );
  }

  deleteFile(
    sandboxId: string,
    path: string,
    input: { recursive?: boolean } = {}
  ): Promise<SandboxFileDeleteResponse> {
    const query = new URLSearchParams({ path });
    if (input.recursive !== undefined)
      query.set("recursive", String(input.recursive));
    return this.request<SandboxFileDeleteResponse>(
      `/${encodeURIComponent(sandboxId)}/files?${query.toString()}`,
      {
        method: "DELETE",
      }
    );
  }

  statFile(sandboxId: string, path: string): Promise<SandboxFileStatResponse> {
    const query = new URLSearchParams({ stat: "1", path });
    return this.request<SandboxFileStatResponse>(
      `/${encodeURIComponent(sandboxId)}/files?${query.toString()}`
    );
  }

  mkdir(
    sandboxId: string,
    input: string | SandboxFileMkdirInput
  ): Promise<SandboxFileMkdirResponse> {
    const normalized = typeof input === "string" ? { path: input } : input;
    const query = new URLSearchParams({ path: normalized.path });
    if (normalized.recursive !== undefined)
      query.set("recursive", String(normalized.recursive));
    return this.request<SandboxFileMkdirResponse>(
      `/${encodeURIComponent(sandboxId)}/files?${query.toString()}`,
      {
        method: "PUT",
      }
    );
  }

  moveFile(
    sandboxId: string,
    input: SandboxFileMoveInput
  ): Promise<SandboxFileMoveResponse> {
    const query = new URLSearchParams({
      fromPath: input.fromPath,
      toPath: input.toPath,
    });
    if (input.overwrite !== undefined)
      query.set("overwrite", String(input.overwrite));
    return this.request<SandboxFileMoveResponse>(
      `/${encodeURIComponent(sandboxId)}/files?${query.toString()}`,
      {
        method: "PATCH",
      }
    );
  }

  searchFiles(
    sandboxId: string,
    input: SandboxFileSearchInput
  ): Promise<SandboxFileSearchResponse> {
    const query = new URLSearchParams({
      search: "1",
      query: input.query,
    });
    if (input.path) query.set("path", input.path);
    if (input.maxResults !== undefined)
      query.set("maxResults", String(input.maxResults));
    return this.request<SandboxFileSearchResponse>(
      `/${encodeURIComponent(sandboxId)}/files?${query.toString()}`
    );
  }

  openPort(
    sandboxId: string,
    input: SandboxOpenPortInput
  ): Promise<SandboxOpenPortResponse> {
    return this.request<SandboxOpenPortResponse>(
      `/${encodeURIComponent(sandboxId)}/ports`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  createSnapshot(
    sandboxId: string,
    input: SandboxSnapshotInput
  ): Promise<SandboxSnapshotResponse> {
    return this.request<SandboxSnapshotResponse>(
      `/${encodeURIComponent(sandboxId)}/snapshots`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  updateSnapshot(
    sandboxId: string,
    snapshotId: string,
    input: SandboxSnapshotUpdateInput
  ): Promise<SandboxSnapshotResponse> {
    return this.request<SandboxSnapshotResponse>(
      `/${encodeURIComponent(sandboxId)}/snapshots/${encodeURIComponent(
        snapshotId
      )}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      }
    );
  }

  validateSnapshot(
    sandboxId: string,
    snapshotId: string,
    input: SandboxSnapshotValidateInput = {}
  ): Promise<SandboxSnapshotValidationResponse> {
    return this.request<SandboxSnapshotValidationResponse>(
      `/${encodeURIComponent(sandboxId)}/snapshots/${encodeURIComponent(
        snapshotId
      )}/validate`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  publishSnapshot(
    sandboxId: string,
    snapshotId: string
  ): Promise<SandboxSnapshotResponse> {
    return this.request<SandboxSnapshotResponse>(
      `/${encodeURIComponent(sandboxId)}/snapshots/${encodeURIComponent(
        snapshotId
      )}/publish`,
      {
        method: "POST",
      }
    );
  }

  fork(
    sandboxId: string,
    input: SandboxForkInput = {}
  ): Promise<SandboxForkResponse> {
    return this.request<SandboxForkResponse>(
      `/${encodeURIComponent(sandboxId)}/fork`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  stop(
    sandboxId: string,
    options: SandboxAsyncRequestOptions = {}
  ): Promise<SandboxReceiptResponse | SandboxLifecycleAcceptedResponse> {
    const query = new URLSearchParams();
    if (options.failOnUnpreservedChanges) {
      query.set("failOnUnpreservedChanges", "true");
    }
    return this.request<SandboxReceiptResponse>(
      `/${encodeURIComponent(sandboxId)}/stop${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "POST",
        headers: asyncRequestHeaders(options),
      }
    );
  }

  start(
    sandboxId: string,
    options: SandboxAsyncRequestOptions = {}
  ): Promise<SandboxStartResponse> {
    return this.request<SandboxStartResponse>(
      `/${encodeURIComponent(sandboxId)}/start`,
      {
        method: "POST",
        headers: asyncRequestHeaders(options),
      }
    );
  }

  restore(sandboxId: string): Promise<SandboxRestoreResponse> {
    return this.request<SandboxRestoreResponse>(
      `/${encodeURIComponent(sandboxId)}/restore`,
      {
        method: "POST",
      }
    );
  }

  delete(
    sandboxId: string,
    options: SandboxAsyncRequestOptions = {}
  ): Promise<SandboxRecord> {
    const query = new URLSearchParams();
    if (options.failOnUnpreservedChanges) {
      query.set("failOnUnpreservedChanges", "true");
    }
    return this.request<{ sandbox: SandboxRecord }>(
      `/${encodeURIComponent(sandboxId)}${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "DELETE",
        headers: asyncRequestHeaders(options),
      }
    ).then((payload) => payload.sandbox);
  }

  receipts(sandboxId: string): Promise<SandboxReceipt[]> {
    return this.request<SandboxReceiptsResponse>(
      `/${encodeURIComponent(sandboxId)}/receipts`
    ).then((payload) => payload.receipts);
  }

  logs(sandboxId: string): Promise<string[]> {
    return this.request<SandboxLogsResponse>(
      `/${encodeURIComponent(sandboxId)}/logs`
    ).then((payload) => payload.logs);
  }

  gitStatus(sandboxId: string): Promise<SandboxGitStatusResponse> {
    return this.request<SandboxGitStatusResponse>(
      `/${encodeURIComponent(sandboxId)}/git/status`
    );
  }

  gitDiff(
    sandboxId: string,
    input: SandboxGitDiffInput = {}
  ): Promise<SandboxGitDiffResponse> {
    return this.request<SandboxGitDiffResponse>(
      `/${encodeURIComponent(sandboxId)}/git/diff`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  gitExportPatch(
    sandboxId: string,
    input: SandboxGitPatchExportInput = {}
  ): Promise<SandboxGitPatchExportResponse> {
    return this.request<SandboxGitPatchExportResponse>(
      `/${encodeURIComponent(sandboxId)}/git/export-patch`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  gitBranch(
    sandboxId: string,
    input: SandboxGitBranchInput
  ): Promise<SandboxGitBranchResponse> {
    return this.request<SandboxGitBranchResponse>(
      `/${encodeURIComponent(sandboxId)}/git/branch`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  gitCommit(
    sandboxId: string,
    input: SandboxGitCommitInput
  ): Promise<SandboxGitCommitResponse> {
    return this.request<SandboxGitCommitResponse>(
      `/${encodeURIComponent(sandboxId)}/git/commit`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  gitPull(
    sandboxId: string,
    input: SandboxGitPullInput = {}
  ): Promise<SandboxGitPullResponse> {
    return this.request<SandboxGitPullResponse>(
      `/${encodeURIComponent(sandboxId)}/git/pull`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  gitPush(
    sandboxId: string,
    input: SandboxGitPushInput = {}
  ): Promise<SandboxGitPushResponse> {
    return this.request<SandboxGitPushResponse>(
      `/${encodeURIComponent(sandboxId)}/git/push`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  billing(sandboxId: string): Promise<SandboxBillingStatusResponse> {
    return this.request<SandboxBillingStatusResponse>(
      `/${encodeURIComponent(sandboxId)}/billing`
    );
  }

  pricing(): Promise<SandboxPricingResponse> {
    return this.request<SandboxPricingResponse>("/pricing");
  }

  costs(
    input: {
      teamId?: string;
      projectId?: string;
      agentId?: string;
    } = {}
  ): Promise<SandboxCostSummaryResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.agentId) query.set("agentId", input.agentId);
    return this.request<SandboxCostSummaryResponse>(
      `/costs${query.size > 0 ? `?${query.toString()}` : ""}`
    );
  }

  integrationLeases(
    sandboxId: string
  ): Promise<SandboxIntegrationLeasesResponse> {
    return this.request<SandboxIntegrationLeasesResponse>(
      `/${encodeURIComponent(sandboxId)}/integrations`
    );
  }

  attachIntegrationConnection(
    sandboxId: string,
    input: SandboxIntegrationConnectionLeaseInput
  ): Promise<SandboxIntegrationLeasesResponse> {
    return this.request<SandboxIntegrationLeasesResponse>(
      `/${encodeURIComponent(sandboxId)}/integrations`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  removeIntegrationLease(
    sandboxId: string,
    leaseId: string
  ): Promise<SandboxIntegrationLeasesResponse> {
    return this.request<SandboxIntegrationLeasesResponse>(
      `/${encodeURIComponent(sandboxId)}/integrations`,
      {
        method: "DELETE",
        body: JSON.stringify({ leaseId }),
      }
    );
  }

  protected async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await apiFetch(
      this.sandboxApiUrl,
      this.apiKey,
      path,
      init
    );
    return readApiJson<T>(response, "Sandbox request");
  }

  protected async requestApiRoot<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const response = await apiFetch(this.apiRootUrl, this.apiKey, path, init);
    return readApiJson<T>(response, "OpenPond API request");
  }
}
