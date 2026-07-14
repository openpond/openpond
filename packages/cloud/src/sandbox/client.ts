import {
  createSandboxAgentNamespace,
  createSandboxNamespace,
  createSandboxProfileNamespace,
  createSandboxProjectNamespace,
  createSandboxRuntimeNamespace,
  createSandboxWorkItemNamespace,
} from "./client-handles.js";
import { createSandboxRuntimeHandle } from "./runtime-handle.js";
import { runSandboxSmoke } from "./smoke.js";
import { asyncRequestHeaders } from "./async-request-options.js";
import { OpenPondSandboxInstanceClient } from "./sandbox-instance-client.js";
import type {
  SandboxIntegrationConnectionStatusFilter,
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
  SandboxSnapshotTemplateVisibility,
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
  SandboxSmokeOptions,
  SandboxSmokeSummary,
  OpenPondSandboxClientOptions,
  OpenPondSandboxMcpServerConfig,
  OpenPondSandboxRuntimeHandle,
} from "./types/index.js";
export class OpenPondSandboxClient extends OpenPondSandboxInstanceClient {

  readonly runtimes = createSandboxRuntimeNamespace(this);
  readonly sandboxes = createSandboxNamespace(this);
  readonly profile = createSandboxProfileNamespace(this);
  readonly projects = createSandboxProjectNamespace(this);
  readonly agents = createSandboxAgentNamespace(this);
  readonly workItems = createSandboxWorkItemNamespace(this);

  list(
    input: {
      teamId?: string;
      projectId?: string;
      agentId?: string;
    } = {}
  ): Promise<SandboxRecord[]> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.agentId) query.set("agentId", input.agentId);
    return this.request<{ sandboxes: SandboxRecord[] }>(
      query.size > 0 ? `?${query.toString()}` : ""
    ).then((payload) => payload.sandboxes);
  }

  listSecrets(
    input: {
      teamId?: string;
    } = {}
  ): Promise<SandboxSecretMetadata[]> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    return this.requestApiRoot<SandboxSecretListResponse>(
      `/sandbox-secrets${query.size > 0 ? `?${query.toString()}` : ""}`
    ).then((payload) => payload.secrets);
  }

  getSecret(
    secretId: string,
    input: { teamId?: string } = {}
  ): Promise<SandboxSecretMetadata> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    return this.requestApiRoot<SandboxSecretResponse>(
      `/sandbox-secrets/${encodeURIComponent(secretId)}${
        query.size > 0 ? `?${query.toString()}` : ""
      }`
    ).then((payload) => payload.secret);
  }

  createSecret(
    input: SandboxSecretCreateInput
  ): Promise<SandboxSecretMetadata> {
    return this.requestApiRoot<SandboxSecretResponse>("/sandbox-secrets", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((payload) => payload.secret);
  }

  rotateSecret(
    secretId: string,
    input: SandboxSecretRotateInput
  ): Promise<SandboxSecretMetadata> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    const { teamId: _teamId, ...body } = input;
    return this.requestApiRoot<SandboxSecretResponse>(
      `/sandbox-secrets/${encodeURIComponent(secretId)}/rotate${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    ).then((payload) => payload.secret);
  }

  attachSecret(
    secretId: string,
    input: SandboxSecretAttachInput
  ): Promise<SandboxSecretMetadata> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    const { teamId: _teamId, ...body } = input;
    return this.requestApiRoot<SandboxSecretResponse>(
      `/sandbox-secrets/${encodeURIComponent(secretId)}/attach${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    ).then((payload) => payload.secret);
  }

  revokeSecret(
    secretId: string,
    input: { teamId?: string } = {}
  ): Promise<SandboxSecretMetadata> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    return this.requestApiRoot<SandboxSecretResponse>(
      `/sandbox-secrets/${encodeURIComponent(secretId)}/revoke${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      { method: "POST" }
    ).then((payload) => payload.secret);
  }

  deleteSecret(
    secretId: string,
    input: { teamId?: string } = {}
  ): Promise<SandboxSecretMetadata> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    return this.requestApiRoot<SandboxSecretResponse>(
      `/sandbox-secrets/${encodeURIComponent(secretId)}${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      { method: "DELETE" }
    ).then((payload) => payload.secret);
  }

  snapshotCatalog(
    input: {
      teamId?: string;
      projectId?: string;
      agentId?: string;
      q?: string;
      kind?: "snapshot" | "archive";
      replayState?: "draft" | "validated" | "published";
      visibility?: SandboxSnapshotTemplateVisibility;
      tag?: string;
      useCase?: string;
      limit?: number;
    } = {}
  ): Promise<SandboxSnapshotCatalogResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.agentId) query.set("agentId", input.agentId);
    if (input.q) query.set("q", input.q);
    if (input.kind) query.set("kind", input.kind);
    if (input.replayState) query.set("replayState", input.replayState);
    if (input.visibility) query.set("visibility", input.visibility);
    if (input.tag) query.set("tag", input.tag);
    if (input.useCase) query.set("useCase", input.useCase);
    if (input.limit) query.set("limit", String(input.limit));
    return this.request<SandboxSnapshotCatalogResponse>(
      `/catalog/snapshots${query.size > 0 ? `?${query.toString()}` : ""}`
    );
  }

  listSandboxRuntimes(
    input: {
      teamId?: string;
      projectId?: string;
      agentId?: string;
    } = {}
  ): Promise<SandboxRuntime[]> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.agentId) query.set("agentId", input.agentId);
    return this.requestApiRoot<SandboxRuntimeListResponse>(
      `/runtimes${query.size > 0 ? `?${query.toString()}` : ""}`
    ).then((payload) => payload.runtimes);
  }

  listProjects(input: { teamId: string }): Promise<SandboxProject[]> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<SandboxProjectListResponse>(
      `/projects?${query.toString()}`
    ).then((payload) => payload.projects);
  }

  upsertProject(input: SandboxProjectUpsertInput): Promise<SandboxProject> {
    return this.requestApiRoot<SandboxProjectResponse>("/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((payload) => payload.project);
  }

  getHostedProfile(input: {
    teamId: string;
  }): Promise<OpenPondHostedProfileSummary | null> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<OpenPondHostedProfileResponse>(
      `/profile?${query.toString()}`
    ).then((payload) => payload.profile);
  }

  ensureHostedProfile(input: {
    teamId: string;
  }): Promise<OpenPondHostedProfileSummary> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<OpenPondHostedProfileResponse>(
      `/profile/ensure?${query.toString()}`,
      { method: "POST" }
    ).then((payload) => {
      if (!payload.profile) {
        throw new Error("hosted_profile_missing");
      }
      return payload.profile;
    });
  }

  pushHostedProfile(input: OpenPondHostedProfilePushInput): Promise<OpenPondHostedProfilePushResponse> {
    const query = new URLSearchParams({ teamId: input.teamId });
    const { teamId: _teamId, ...body } = input;
    return this.requestApiRoot<OpenPondHostedProfilePushResponse>(
      `/profile/push?${query.toString()}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  }

  async upsertProjectGitRemote(
    input: SandboxProjectUpsertInput
  ): Promise<SandboxProjectGitRemoteResponse> {
    const project = await this.upsertProject(input);
    return this.ensureProjectGitRemote(project.id, { teamId: input.teamId });
  }

  getProject(
    projectId: string,
    input: { teamId: string }
  ): Promise<SandboxProject> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<SandboxProjectResponse>(
      `/projects/${encodeURIComponent(projectId)}?${query.toString()}`
    ).then((payload) => payload.project);
  }

  syncProject(
    projectId: string,
    input: { teamId: string }
  ): Promise<SandboxProject> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<SandboxProjectResponse>(
      `/projects/${encodeURIComponent(projectId)}/sync?${query.toString()}`,
      { method: "POST" }
    ).then((payload) => payload.project);
  }

  ensureProjectGitRemote(
    projectId: string,
    input: { teamId: string }
  ): Promise<SandboxProjectGitRemoteResponse> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<SandboxProjectGitRemoteResponse>(
      `/projects/${encodeURIComponent(projectId)}/git?${query.toString()}`,
      { method: "POST" }
    );
  }

  uploadProjectSource(
    projectId: string,
    input: SandboxProjectSourceUploadInput
  ): Promise<SandboxProject> {
    const query = new URLSearchParams({ teamId: input.teamId });
    const { teamId: _teamId, ...body } = input;
    return this.requestApiRoot<SandboxProjectResponse>(
      `/projects/${encodeURIComponent(projectId)}/source?${query.toString()}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    ).then((payload) => payload.project);
  }

  updateProject(
    projectId: string,
    input: SandboxProjectUpdateInput
  ): Promise<SandboxProject> {
    const query = new URLSearchParams({ teamId: input.teamId });
    const { teamId: _teamId, ...body } = input;
    return this.requestApiRoot<SandboxProjectResponse>(
      `/projects/${encodeURIComponent(projectId)}?${query.toString()}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      }
    ).then((payload) => payload.project);
  }

  archiveProject(
    projectId: string,
    input: { teamId: string }
  ): Promise<SandboxProject> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<SandboxProjectResponse>(
      `/projects/${encodeURIComponent(projectId)}?${query.toString()}`,
      { method: "DELETE" }
    ).then((payload) => payload.project);
  }

  listAgents(input: { teamId: string }): Promise<SandboxAgent[]> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<SandboxAgentListResponse>(
      `/agents?${query.toString()}`
    ).then((payload) => payload.agents);
  }

  upsertAgent(input: SandboxAgentUpsertInput): Promise<SandboxAgent> {
    return this.requestApiRoot<SandboxAgentResponse>("/agents", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((payload) => payload.agent);
  }

  getAgent(agentId: string, input: { teamId: string }): Promise<SandboxAgent> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<SandboxAgentResponse>(
      `/agents/${encodeURIComponent(agentId)}?${query.toString()}`
    ).then((payload) => payload.agent);
  }

  archiveAgent(
    agentId: string,
    input: { teamId: string }
  ): Promise<SandboxAgent> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<SandboxAgentResponse>(
      `/agents/${encodeURIComponent(agentId)}?${query.toString()}`,
      { method: "DELETE" }
    ).then((payload) => payload.agent);
  }

  updateAgent(
    agentId: string,
    input: SandboxAgentUpdateInput
  ): Promise<SandboxAgent> {
    const query = new URLSearchParams({ teamId: input.teamId });
    const { teamId: _teamId, ...body } = input;
    return this.requestApiRoot<SandboxAgentResponse>(
      `/agents/${encodeURIComponent(agentId)}?${query.toString()}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      }
    ).then((payload) => payload.agent);
  }

  runAgent(
    agentId: string,
    input: SandboxAgentRunInput
  ): Promise<SandboxAgentRunResponse> {
    return this.requestApiRoot<SandboxAgentRunResponse>(
      `/agents/${encodeURIComponent(agentId)}/run`,
      {
        method: "POST",
        headers: {
          Prefer: "respond-async",
        },
        body: JSON.stringify(input),
      }
    );
  }

  getAgentSourceDeployPlan(
    agentId: string,
    input: { teamId: string }
  ): Promise<SandboxAgentSourceDeployPlan> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<SandboxAgentSourceDeployPlanResponse>(
      `/agents/${encodeURIComponent(
        agentId
      )}/source/deploy-plan?${query.toString()}`
    ).then((payload) => payload.deployPlan);
  }

  listAgentManifestSnapshots(
    agentId: string,
    input: { teamId: string; limit?: number }
  ): Promise<SandboxAgentManifestSnapshot[]> {
    const query = new URLSearchParams({ teamId: input.teamId });
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    return this.requestApiRoot<SandboxAgentManifestSnapshotsResponse>(
      `/agents/${encodeURIComponent(
        agentId
      )}/source/manifest-snapshots?${query.toString()}`
    ).then((payload) => payload.manifestSnapshots);
  }

  requestAgentSourceChecks(
    agentId: string,
    input: SandboxAgentSourceChecksRequestInput
  ): Promise<SandboxAgentSourceChecksRequestResult> {
    const query = new URLSearchParams({ teamId: input.teamId });
    const { teamId: _teamId, ...body } = input;
    return this.requestApiRoot<SandboxAgentSourceChecksRequestResult>(
      `/agents/${encodeURIComponent(
        agentId
      )}/source/checks?${query.toString()}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  }

  publishAgentSource(
    agentId: string,
    input: SandboxAgentSourcePublishInput
  ): Promise<SandboxAgentSourcePublishResult> {
    const query = new URLSearchParams({ teamId: input.teamId });
    const { teamId: _teamId, ...body } = input;
    return this.requestApiRoot<SandboxAgentSourcePublishResult>(
      `/agents/${encodeURIComponent(
        agentId
      )}/source/publish?${query.toString()}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  }

  openAgentEditWorkItem(
    agentId: string,
    input: SandboxAgentEditWorkItemOpenInput
  ): Promise<SandboxAgentEditWorkItemOpenResult> {
    const query = new URLSearchParams({ teamId: input.teamId });
    const { teamId: _teamId, ...body } = input;
    return this.requestApiRoot<SandboxAgentEditWorkItemOpenResult>(
      `/agents/${encodeURIComponent(
        agentId
      )}/edit-work-item?${query.toString()}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  }

  getCodingWorkItem(
    workItemId: string,
    input: SandboxCodingWorkItemGetInput
  ): Promise<SandboxCodingWorkItem> {
    const query = new URLSearchParams({ teamId: input.teamId });
    if (input.includeArchived) query.set("includeArchived", "true");
    return this.requestApiRoot<{ workItem: SandboxCodingWorkItem }>(
      `/work-items/${encodeURIComponent(workItemId)}?${query.toString()}`
    ).then((payload) => payload.workItem);
  }

  sendCodingWorkItemChat(
    workItemId: string,
    input: SandboxCodingWorkItemChatInput
  ): Promise<SandboxCodingWorkItemChatResult> {
    return this.requestApiRoot<SandboxCodingWorkItemChatResult>(
      `/work-items/${encodeURIComponent(workItemId)}/chat`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  listCodingWorkItemActivity(
    workItemId: string,
    input: SandboxCodingWorkItemActivityListInput
  ): Promise<SandboxCodingWorkItemActivity[]> {
    const query = new URLSearchParams({ teamId: input.teamId });
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    return this.requestApiRoot<{ activity: SandboxCodingWorkItemActivity[] }>(
      `/work-items/${encodeURIComponent(
        workItemId
      )}/activity?${query.toString()}`
    ).then((payload) => payload.activity);
  }

  getCodingWorkItemStatus(
    workItemId: string,
    input: SandboxCodingWorkItemActivityListInput & { includeArchived?: boolean }
  ): Promise<SandboxCodingWorkItemStatusResult> {
    const query = new URLSearchParams({ teamId: input.teamId });
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.includeArchived) query.set("includeArchived", "true");
    return this.requestApiRoot<SandboxCodingWorkItemStatusResult>(
      `/work-items/${encodeURIComponent(workItemId)}/status?${query.toString()}`
    );
  }

  handleCodingWorkItemInBackground(
    workItemId: string,
    input: SandboxCodingWorkItemBackgroundInput
  ): Promise<SandboxCodingWorkItemBackgroundResult> {
    return this.requestApiRoot<SandboxCodingWorkItemBackgroundResult>(
      `/work-items/${encodeURIComponent(workItemId)}/handle-background`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  promoteCodingWorkItemResult(
    workItemId: string,
    action: "checkpoint" | "commit" | "pr",
    input: SandboxCodingWorkItemPromotionInput
  ): Promise<SandboxCodingWorkItemArtifact> {
    return this.requestApiRoot<{ artifact: SandboxCodingWorkItemArtifact }>(
      `/work-items/${encodeURIComponent(workItemId)}/result/${action}`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    ).then((payload) => payload.artifact);
  }

  getMicrosoftTeamsBotOverview(input: {
    teamId: string;
  }): Promise<MicrosoftTeamsBotOverview> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<MicrosoftTeamsBotOverview>(
      `/teams/bot/overview?${query.toString()}`
    );
  }

  bindMicrosoftTeamsBotConversation(
    input: MicrosoftTeamsBotBindingTargetInput & { token: string }
  ): Promise<MicrosoftTeamsBotBindingResponse> {
    return this.requestApiRoot<MicrosoftTeamsBotBindingResponse>(
      "/teams/bot/bindings",
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  rebindMicrosoftTeamsBotConversation(
    bindingId: string,
    input: MicrosoftTeamsBotBindingTargetInput
  ): Promise<MicrosoftTeamsBotBindingResponse> {
    return this.requestApiRoot<MicrosoftTeamsBotBindingResponse>(
      `/teams/bot/bindings/${encodeURIComponent(bindingId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      }
    );
  }

  unlinkMicrosoftTeamsBotConversation(input: {
    teamId: string;
    bindingId: string;
  }): Promise<MicrosoftTeamsBotBindingResponse> {
    return this.requestApiRoot<MicrosoftTeamsBotBindingResponse>(
      `/teams/bot/bindings/${encodeURIComponent(input.bindingId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ teamId: input.teamId }),
      }
    );
  }

  sendMicrosoftTeamsBotDiagnostic(input: {
    teamId: string;
    bindingId: string;
  }): Promise<MicrosoftTeamsBotBindingResponse & { diagnosticStatus: string }> {
    return this.requestApiRoot<
      MicrosoftTeamsBotBindingResponse & { diagnosticStatus: string }
    >("/teams/bot/diagnostics", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  sendMicrosoftTeamsBotDiagnosticRun(
    input: MicrosoftTeamsBotDiagnosticRunInput
  ): Promise<MicrosoftTeamsBotDiagnosticRunResponse> {
    return this.requestApiRoot<MicrosoftTeamsBotDiagnosticRunResponse>(
      "/teams/bot/diagnostics/run",
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  createSandboxRuntime(
    input: SandboxRuntimeCreateInput
  ): Promise<SandboxRuntime> {
    return this.requestApiRoot<SandboxRuntimeResponse>("/runtimes", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((payload) => payload.runtime);
  }

  sandboxRuntime(
    runtimeId: string,
    initial: SandboxRuntime | null = null
  ): OpenPondSandboxRuntimeHandle {
    return createSandboxRuntimeHandle(this, runtimeId, initial);
  }

  getSandboxRuntime(runtimeId: string): Promise<SandboxRuntime> {
    return this.requestApiRoot<SandboxRuntimeResponse>(
      `/runtimes/${encodeURIComponent(runtimeId)}`
    ).then((payload) => payload.runtime);
  }

  createSandboxRuntimeSandbox(
    runtimeId: string,
    input: SandboxRuntimeSandboxCreateInput = {},
    options: SandboxAsyncRequestOptions = {}
  ): Promise<SandboxRuntimeSandboxResponse> {
    return this.requestApiRoot<SandboxRuntimeSandboxResponse>(
      `/runtimes/${encodeURIComponent(runtimeId)}/sandbox`,
      {
        method: "POST",
        headers: asyncRequestHeaders(options),
        body: JSON.stringify(input),
      }
    );
  }

  updateSandboxRuntimeStatus(
    runtimeId: string,
    input: SandboxRuntimeTransitionInput
  ): Promise<SandboxRuntime> {
    return this.requestApiRoot<SandboxRuntimeResponse>(
      `/runtimes/${encodeURIComponent(runtimeId)}/status`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      }
    ).then((payload) => payload.runtime);
  }

  listSandboxRuntimeEvents(
    runtimeId: string
  ): Promise<SandboxRuntimeEventsResponse> {
    return this.requestApiRoot<SandboxRuntimeEventsResponse>(
      `/runtimes/${encodeURIComponent(runtimeId)}/events`
    );
  }

  emitSandboxRuntimeEvent(
    runtimeId: string,
    input: SandboxRuntimeEventInput
  ): Promise<SandboxRuntimeEventResponse> {
    return this.requestApiRoot<SandboxRuntimeEventResponse>(
      `/runtimes/${encodeURIComponent(runtimeId)}/events`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  checkpointSandboxRuntime(
    runtimeId: string,
    input: SandboxRuntimeCheckpointInput
  ): Promise<SandboxRuntime> {
    return this.requestApiRoot<SandboxRuntimeResponse>(
      `/runtimes/${encodeURIComponent(runtimeId)}/checkpoints`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    ).then((payload) => payload.runtime);
  }

  promoteSandboxRuntime(
    runtimeId: string,
    input: SandboxRuntimePromoteInput,
    options: { teamId?: string } = {}
  ): Promise<SandboxRuntimePromoteResponse> {
    const query = new URLSearchParams();
    if (options.teamId) query.set("teamId", options.teamId);
    return this.requestApiRoot<SandboxRuntimePromoteResponse>(
      `/runtimes/${encodeURIComponent(runtimeId)}/promote${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  preserveSandboxRuntimeSource(
    runtimeId: string,
    input: SandboxRuntimeSourcePreserveInput = {},
    options: { teamId?: string } = {}
  ): Promise<SandboxRuntimeSourcePreserveResponse> {
    const query = new URLSearchParams();
    if (options.teamId) query.set("teamId", options.teamId);
    return this.requestApiRoot<SandboxRuntimeSourcePreserveResponse>(
      `/runtimes/${encodeURIComponent(runtimeId)}/preserve-source${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  forkSnapshot(
    snapshotId: string,
    input: SandboxForkInput & { teamId?: string; projectId?: string } = {},
    options: SandboxForkOptions = {}
  ): Promise<SandboxForkResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    if (options.async) query.set("async", "1");
    const { teamId: _teamId, projectId: _projectId, ...body } = input;
    return this.request<SandboxForkResponse>(
      `/catalog/snapshots/${encodeURIComponent(snapshotId)}/fork${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "POST",
        headers: options.async ? { Prefer: "respond-async" } : undefined,
        body: JSON.stringify({
          ...body,
          snapshotId,
        }),
      }
    );
  }

  templates(
    input: {
      teamId?: string;
      projectId?: string;
      q?: string;
      name?: string;
      version?: string;
      visibility?: SandboxSnapshotTemplateVisibility;
      tag?: string;
      useCase?: string;
      limit?: number;
    } = {}
  ): Promise<SandboxTemplateCatalogResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.q) query.set("q", input.q);
    if (input.name) query.set("name", input.name);
    if (input.version) query.set("version", input.version);
    if (input.visibility) query.set("visibility", input.visibility);
    if (input.tag) query.set("tag", input.tag);
    if (input.useCase) query.set("useCase", input.useCase);
    if (input.limit) query.set("limit", String(input.limit));
    return this.request<SandboxTemplateCatalogResponse>(
      `/templates${query.size > 0 ? `?${query.toString()}` : ""}`
    );
  }

  publishedSnapshots(
    input: {
      teamId?: string;
      projectId?: string;
      q?: string;
      name?: string;
      version?: string;
      visibility?: SandboxSnapshotTemplateVisibility;
      tag?: string;
      useCase?: string;
      limit?: number;
    } = {}
  ): Promise<SandboxPublishedSnapshotCatalogResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.q) query.set("q", input.q);
    if (input.name) query.set("name", input.name);
    if (input.version) query.set("version", input.version);
    if (input.visibility) query.set("visibility", input.visibility);
    if (input.tag) query.set("tag", input.tag);
    if (input.useCase) query.set("useCase", input.useCase);
    if (input.limit) query.set("limit", String(input.limit));
    return this.request<
      SandboxTemplateCatalogResponse &
        Partial<
          Pick<SandboxPublishedSnapshotCatalogResponse, "publishedSnapshots">
        >
    >(
      `/published-snapshots${query.size > 0 ? `?${query.toString()}` : ""}`
    ).then((payload) => {
      const publishedSnapshots =
        payload.publishedSnapshots ?? payload.templates;
      return {
        ...payload,
        templates: publishedSnapshots,
        publishedSnapshots,
      };
    });
  }

  launchTemplate(
    input: SandboxTemplateLaunchInput & { teamId?: string; projectId?: string }
  ): Promise<SandboxTemplateLaunchResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    const { teamId: _teamId, projectId: _projectId, ...body } = input;
    return this.request<SandboxTemplateLaunchResponse>(
      `/templates/launch${query.size > 0 ? `?${query.toString()}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  }

  runPublishedSnapshot(
    input: SandboxTemplateLaunchInput & { teamId?: string; projectId?: string }
  ): Promise<SandboxPublishedSnapshotLaunchResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    const { teamId: _teamId, projectId: _projectId, ...body } = input;
    return this.request<
      SandboxTemplateLaunchResponse &
        Partial<Pick<SandboxPublishedSnapshotLaunchResponse, "publishedSnapshot">>
    >(
      `/published-snapshots/launch${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    ).then((payload) => {
      const publishedSnapshot = payload.publishedSnapshot ?? payload.template;
      return {
        ...payload,
        template: publishedSnapshot,
        publishedSnapshot,
      };
    });
  }

  listSchedules(
    input: {
      teamId?: string;
      projectId?: string;
      sourceSandboxId?: string;
    } = {}
  ): Promise<SandboxScheduleListResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.sourceSandboxId)
      query.set("sourceSandboxId", input.sourceSandboxId);
    return this.request<SandboxScheduleListResponse>(
      `/schedules${query.size > 0 ? `?${query.toString()}` : ""}`
    );
  }

  createSchedule(
    input: SandboxScheduleCreateInput
  ): Promise<SandboxScheduleResponse> {
    const query = new URLSearchParams();
    if (input.projectId) query.set("projectId", input.projectId);
    const { projectId: _projectId, ...body } = input;
    return this.request<SandboxScheduleResponse>(
      `/schedules${query.size > 0 ? `?${query.toString()}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  }

  getSchedule(scheduleId: string): Promise<SandboxScheduleResponse> {
    return this.request<SandboxScheduleResponse>(
      `/schedules/${encodeURIComponent(scheduleId)}`
    );
  }

  updateSchedule(
    scheduleId: string,
    input: SandboxScheduleUpdateInput
  ): Promise<SandboxScheduleResponse> {
    return this.request<SandboxScheduleResponse>(
      `/schedules/${encodeURIComponent(scheduleId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      }
    );
  }

  deleteSchedule(scheduleId: string): Promise<SandboxScheduleResponse> {
    return this.request<SandboxScheduleResponse>(
      `/schedules/${encodeURIComponent(scheduleId)}`,
      {
        method: "DELETE",
      }
    );
  }

  listScheduleRuns(
    scheduleId: string,
    input: { limit?: number } = {}
  ): Promise<SandboxScheduleRunListResponse> {
    const query = new URLSearchParams();
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    return this.request<SandboxScheduleRunListResponse>(
      `/schedules/${encodeURIComponent(scheduleId)}/runs${
        query.size > 0 ? `?${query.toString()}` : ""
      }`
    );
  }

  runScheduleNow(
    scheduleId: string,
    input: { idempotencyKey?: string } = {}
  ): Promise<SandboxScheduleRunResponse> {
    return this.request<SandboxScheduleRunResponse>(
      `/schedules/${encodeURIComponent(scheduleId)}/run`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    );
  }

  listTemplateBuilds(input: {
    teamId: string;
  }): Promise<SandboxTemplateBuildRecord[]> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<SandboxTemplateBuildListResponse>(
      `/sandbox-template-builds?${query.toString()}`
    ).then((payload) => payload.builds);
  }

  createTemplateBuild(
    input: SandboxTemplateBuildCreateInput
  ): Promise<SandboxTemplateBuildRecord> {
    return this.requestApiRoot<SandboxTemplateBuildResponse>(
      "/sandbox-template-builds",
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    ).then((payload) => payload.build);
  }

  getTemplateBuild(buildId: string): Promise<SandboxTemplateBuildRecord> {
    return this.requestApiRoot<SandboxTemplateBuildResponse>(
      `/sandbox-template-builds/${encodeURIComponent(buildId)}`
    ).then((payload) => payload.build);
  }

  getTemplateBuildLogs(
    buildId: string
  ): Promise<SandboxTemplateBuildLogsResponse> {
    return this.requestApiRoot<SandboxTemplateBuildLogsResponse>(
      `/sandbox-template-builds/${encodeURIComponent(buildId)}/logs`
    );
  }

  cancelTemplateBuild(buildId: string): Promise<SandboxTemplateBuildRecord> {
    return this.requestApiRoot<SandboxTemplateBuildResponse>(
      `/sandbox-template-builds/${encodeURIComponent(buildId)}/cancel`,
      {
        method: "POST",
      }
    ).then((payload) => payload.build);
  }

  listPublishedSnapshotBuilds(input: {
    teamId: string;
  }): Promise<SandboxPublishedSnapshotBuildRecord[]> {
    const query = new URLSearchParams({ teamId: input.teamId });
    return this.requestApiRoot<SandboxPublishedSnapshotBuildListResponse>(
      `/published-snapshot-builds?${query.toString()}`
    ).then((payload) => payload.builds);
  }

  createPublishedSnapshotBuild(
    input: SandboxPublishedSnapshotBuildCreateInput
  ): Promise<SandboxPublishedSnapshotBuildRecord> {
    return this.requestApiRoot<SandboxPublishedSnapshotBuildResponse>(
      "/published-snapshot-builds",
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    ).then((payload) => payload.build);
  }

  getPublishedSnapshotBuild(
    buildId: string
  ): Promise<SandboxPublishedSnapshotBuildRecord> {
    return this.requestApiRoot<SandboxPublishedSnapshotBuildResponse>(
      `/published-snapshot-builds/${encodeURIComponent(buildId)}`
    ).then((payload) => payload.build);
  }

  getPublishedSnapshotBuildLogs(
    buildId: string
  ): Promise<SandboxPublishedSnapshotBuildLogsResponse> {
    return this.requestApiRoot<SandboxPublishedSnapshotBuildLogsResponse>(
      `/published-snapshot-builds/${encodeURIComponent(buildId)}/logs`
    );
  }

  cancelPublishedSnapshotBuild(
    buildId: string
  ): Promise<SandboxPublishedSnapshotBuildRecord> {
    return this.requestApiRoot<SandboxPublishedSnapshotBuildResponse>(
      `/published-snapshot-builds/${encodeURIComponent(buildId)}/cancel`,
      {
        method: "POST",
      }
    ).then((payload) => payload.build);
  }

  listOrganizations(): Promise<OpenPondOrganization[]> {
    return this.requestApiRoot<OpenPondOrganizationsResponse & { teams?: OpenPondOrganization[] }>(
      "/organizations"
    ).then((payload) => payload.organizations ?? payload.teams ?? []);
  }

  createOrganization(
    input: OpenPondOrganizationCreateInput
  ): Promise<OpenPondOrganization> {
    return this.requestApiRoot<OpenPondOrganizationResponse>("/organizations", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((payload) => payload.organization);
  }

  getOrganization(slug: string): Promise<OpenPondOrganization> {
    return this.requestApiRoot<OpenPondOrganizationResponse>(
      `/organizations/${encodeURIComponent(slug)}`
    ).then((payload) => payload.organization);
  }

  updateOrganization(
    slug: string,
    input: OpenPondOrganizationUpdateInput
  ): Promise<OpenPondOrganization> {
    return this.requestApiRoot<OpenPondOrganizationResponse>(
      `/organizations/${encodeURIComponent(slug)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      }
    ).then((payload) => payload.organization);
  }

  listOrganizationMembers(slug: string): Promise<OpenPondOrganizationMember[]> {
    return this.requestApiRoot<OpenPondOrganizationMembersResponse>(
      `/organizations/${encodeURIComponent(slug)}/members`
    ).then((payload) => payload.members);
  }

  upsertOrganizationMember(
    slug: string,
    input: OpenPondOrganizationMemberUpsertInput
  ): Promise<OpenPondOrganizationMember> {
    return this.requestApiRoot<OpenPondOrganizationMemberResponse>(
      `/organizations/${encodeURIComponent(slug)}/members`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    ).then((payload) => payload.member);
  }

  getOrganizationMcpServer(
    slug: string
  ): Promise<OpenPondOrganizationMcpServer | null> {
    return this.requestApiRoot<OpenPondOrganizationMcpServerResponse>(
      `/organizations/${encodeURIComponent(slug)}/mcp-server`
    ).then((payload) => payload.mcpServer);
  }

  generateOrganizationMcpServer(
    slug: string,
    input: OpenPondOrganizationMcpGenerateInput = {}
  ): Promise<OpenPondOrganizationMcpServer | null> {
    return this.requestApiRoot<OpenPondOrganizationMcpServerResponse>(
      `/organizations/${encodeURIComponent(slug)}/mcp-server`,
      {
        method: "POST",
        body: JSON.stringify(input),
      }
    ).then((payload) => payload.mcpServer);
  }

  rotateOrganizationMcpServer(
    slug: string
  ): Promise<OpenPondOrganizationMcpServer | null> {
    return this.requestApiRoot<OpenPondOrganizationMcpServerResponse>(
      `/organizations/${encodeURIComponent(slug)}/mcp-server/rotate`,
      {
        method: "POST",
      }
    ).then((payload) => payload.mcpServer);
  }

  disableOrganizationMcpServer(
    slug: string
  ): Promise<OpenPondOrganizationMcpServer | null> {
    return this.requestApiRoot<OpenPondOrganizationMcpServerResponse>(
      `/organizations/${encodeURIComponent(slug)}/mcp-server/disable`,
      {
        method: "POST",
      }
    ).then((payload) => payload.mcpServer);
  }

  enableOrganizationMcpServer(
    slug: string
  ): Promise<OpenPondOrganizationMcpServer | null> {
    return this.requestApiRoot<OpenPondOrganizationMcpServerResponse>(
      `/organizations/${encodeURIComponent(slug)}/mcp-server/enable`,
      {
        method: "POST",
      }
    ).then((payload) => payload.mcpServer);
  }

  startReplay(
    input: SandboxReplayInput & { teamId?: string; projectId?: string }
  ): Promise<SandboxReplayResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    const { teamId: _teamId, projectId: _projectId, ...body } = input;
    return this.requestApiRoot<SandboxReplayResponse>(
      `/sandbox-replays${query.size > 0 ? `?${query.toString()}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  }

  listReplays(
    input: { teamId?: string; projectId?: string } = {}
  ): Promise<SandboxReplayListResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return this.requestApiRoot<SandboxReplayListResponse>(
      `/sandbox-replays${query.size > 0 ? `?${query.toString()}` : ""}`
    );
  }

  getReplay(
    replayId: string,
    input: { teamId?: string; projectId?: string } = {}
  ): Promise<SandboxReplayResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return this.requestApiRoot<SandboxReplayResponse>(
      `/sandbox-replays/${encodeURIComponent(replayId)}${
        query.size > 0 ? `?${query.toString()}` : ""
      }`
    );
  }

  getReplayLogs(
    replayId: string,
    input: { teamId?: string; projectId?: string } = {}
  ): Promise<SandboxReplayLogsResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return this.requestApiRoot<SandboxReplayLogsResponse>(
      `/sandbox-replays/${encodeURIComponent(replayId)}/logs${
        query.size > 0 ? `?${query.toString()}` : ""
      }`
    );
  }

  getReplayArtifacts(
    replayId: string,
    input: { teamId?: string; projectId?: string } = {}
  ): Promise<SandboxReplayArtifactsResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return this.requestApiRoot<SandboxReplayArtifactsResponse>(
      `/sandbox-replays/${encodeURIComponent(replayId)}/artifacts${
        query.size > 0 ? `?${query.toString()}` : ""
      }`
    );
  }

  cancelReplay(
    replayId: string,
    input: { teamId?: string; projectId?: string } = {}
  ): Promise<SandboxReplayResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    return this.requestApiRoot<SandboxReplayResponse>(
      `/sandbox-replays/${encodeURIComponent(replayId)}/cancel${
        query.size > 0 ? `?${query.toString()}` : ""
      }`,
      {
        method: "POST",
      }
    );
  }

  integrationConnections(
    input: {
      teamId?: string;
      projectId?: string;
      agentId?: string;
      status?: SandboxIntegrationConnectionStatusFilter;
    } = {}
  ): Promise<SandboxIntegrationConnectionsResponse> {
    const query = new URLSearchParams();
    if (input.teamId) query.set("teamId", input.teamId);
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.agentId) query.set("agentId", input.agentId);
    if (input.status) query.set("status", input.status);
    return this.requestApiRoot<SandboxIntegrationConnectionsResponse>(
      `/integrations/connections${query.size > 0 ? `?${query.toString()}` : ""}`
    );
  }

  mcpServerConfig(): OpenPondSandboxMcpServerConfig {
    return {
      name: "openpond-sandboxes",
      transport: "streamable-http",
      url: `${this.sandboxApiUrl}/mcp`,
      headers: {
        "openpond-api-key": this.apiKey,
      },
    };
  }

  smoke(options: SandboxSmokeOptions = {}): Promise<SandboxSmokeSummary> {
    return runSandboxSmoke(this, options);
  }

}

export function createOpenPondSandboxClient(
  options: OpenPondSandboxClientOptions
): OpenPondSandboxClient {
  return new OpenPondSandboxClient(options);
}

export { normalizeSandboxApiUrl } from "./url.js";
