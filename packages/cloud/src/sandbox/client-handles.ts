import type { OpenPondSandboxClient } from "./client.js";
import type {
  SandboxAgentRunInput,
  SandboxAgentEditWorkItemOpenInput,
  SandboxAgentSourceChecksRequestInput,
  SandboxAgentSourcePublishInput,
  SandboxAgentUpdateInput,
  SandboxAgentUpsertInput,
  SandboxCodingWorkItemActivityListInput,
  SandboxCodingWorkItemBackgroundInput,
  SandboxCodingWorkItemChatInput,
  SandboxCodingWorkItemGetInput,
  SandboxCodingWorkItemPromotionInput,
  SandboxCreateInput,
  SandboxAsyncRequestOptions,
  SandboxProjectUpdateInput,
  SandboxProjectUpsertInput,
  SandboxProjectSourceUploadInput,
  SandboxRuntime,
  SandboxRuntimeCheckpointInput,
  SandboxRuntimeCreateInput,
  SandboxRuntimeEventInput,
  SandboxRuntimePromoteInput,
  SandboxRuntimeSourcePreserveInput,
  SandboxRuntimeSandboxCreateInput,
  SandboxRuntimeTransitionInput,
  OpenPondHostedProfilePushInput,
  OpenPondHostedProfilePushResponse,
  OpenPondHostedProfileSummary,
} from "./types/index.js";

export function createSandboxRuntimeNamespace(client: OpenPondSandboxClient) {
  return {
    list: (
      input: {
        teamId?: string;
        projectId?: string;
        agentId?: string;
      } = {}
    ) => client.listSandboxRuntimes(input),
    create: (input: SandboxRuntimeCreateInput) =>
      client.createSandboxRuntime(input),
    handle: (runtimeId: string, initial: SandboxRuntime | null = null) =>
      client.sandboxRuntime(runtimeId, initial),
    get: (runtimeId: string) => client.getSandboxRuntime(runtimeId),
    createSandbox: (
      runtimeId: string,
      input: SandboxRuntimeSandboxCreateInput = {},
      options: SandboxAsyncRequestOptions = {}
    ) => client.createSandboxRuntimeSandbox(runtimeId, input, options),
    updateStatus: (runtimeId: string, input: SandboxRuntimeTransitionInput) =>
      client.updateSandboxRuntimeStatus(runtimeId, input),
    events: (runtimeId: string) => client.listSandboxRuntimeEvents(runtimeId),
    event: (runtimeId: string, input: SandboxRuntimeEventInput) =>
      client.emitSandboxRuntimeEvent(runtimeId, input),
    checkpoint: (
      runtimeId: string,
      input: SandboxRuntimeCheckpointInput = {}
    ) => client.checkpointSandboxRuntime(runtimeId, input),
    promote: (
      runtimeId: string,
      input: SandboxRuntimePromoteInput,
      options: { teamId?: string } = {}
    ) => client.promoteSandboxRuntime(runtimeId, input, options),
    preserveSource: (
      runtimeId: string,
      input: SandboxRuntimeSourcePreserveInput = {},
      options: { teamId?: string } = {}
    ) => client.preserveSandboxRuntimeSource(runtimeId, input, options),
  };
}

export function createSandboxNamespace(client: OpenPondSandboxClient) {
  return {
    list: (
      input: {
        teamId?: string;
        projectId?: string;
        agentId?: string;
      } = {}
    ) => client.list(input),
    create: (input: SandboxCreateInput) => client.create(input),
    get: (sandboxId: string) => client.get(sandboxId),
    pricing: () => client.pricing(),
    costs: (
      input: {
        teamId?: string;
        projectId?: string;
        agentId?: string;
      } = {}
    ) => client.costs(input),
  };
}

export function createSandboxProjectNamespace(client: OpenPondSandboxClient) {
  return {
    list: (input: { teamId: string }) => client.listProjects(input),
    upsert: (input: SandboxProjectUpsertInput) => client.upsertProject(input),
    upsertGitRemote: (input: SandboxProjectUpsertInput) =>
      client.upsertProjectGitRemote(input),
    get: (projectId: string, input: { teamId: string }) =>
      client.getProject(projectId, input),
    update: (projectId: string, input: SandboxProjectUpdateInput) =>
      client.updateProject(projectId, input),
    sync: (projectId: string, input: { teamId: string }) =>
      client.syncProject(projectId, input),
    ensureGitRemote: (projectId: string, input: { teamId: string }) =>
      client.ensureProjectGitRemote(projectId, input),
    getGitRemote: (projectId: string, input: { teamId: string }) =>
      client.ensureProjectGitRemote(projectId, input),
    git: (projectId: string, input: { teamId: string }) =>
      client.ensureProjectGitRemote(projectId, input),
    uploadSource: (
      projectId: string,
      input: SandboxProjectSourceUploadInput
    ) => client.uploadProjectSource(projectId, input),
    archive: (projectId: string, input: { teamId: string }) =>
      client.archiveProject(projectId, input),
  };
}

export function createSandboxProfileNamespace(client: OpenPondSandboxClient): {
  get(input: { teamId: string }): Promise<OpenPondHostedProfileSummary | null>;
  status(input: { teamId: string }): Promise<OpenPondHostedProfileSummary | null>;
  ensureHosted(input: { teamId: string }): Promise<OpenPondHostedProfileSummary>;
  push(input: OpenPondHostedProfilePushInput): Promise<OpenPondHostedProfilePushResponse>;
} {
  return {
    get: (input: { teamId: string }) => client.getHostedProfile(input),
    status: (input: { teamId: string }) => client.getHostedProfile(input),
    ensureHosted: (input: { teamId: string }) =>
      client.ensureHostedProfile(input),
    push: (input: OpenPondHostedProfilePushInput) =>
      client.pushHostedProfile(input),
  };
}

export function createSandboxAgentNamespace(client: OpenPondSandboxClient) {
  return {
    list: (input: { teamId: string }) => client.listAgents(input),
    upsert: (input: SandboxAgentUpsertInput) => client.upsertAgent(input),
    get: (agentId: string, input: { teamId: string }) =>
      client.getAgent(agentId, input),
    update: (agentId: string, input: SandboxAgentUpdateInput) =>
      client.updateAgent(agentId, input),
    archive: (agentId: string, input: { teamId: string }) =>
      client.archiveAgent(agentId, input),
    run: (agentId: string, input: SandboxAgentRunInput) =>
      client.runAgent(agentId, input),
    sourceDeployPlan: (agentId: string, input: { teamId: string }) =>
      client.getAgentSourceDeployPlan(agentId, input),
    manifestSnapshots: (
      agentId: string,
      input: { teamId: string; limit?: number }
    ) => client.listAgentManifestSnapshots(agentId, input),
    requestSourceChecks: (
      agentId: string,
      input: SandboxAgentSourceChecksRequestInput
    ) => client.requestAgentSourceChecks(agentId, input),
    publishSource: (agentId: string, input: SandboxAgentSourcePublishInput) =>
      client.publishAgentSource(agentId, input),
    openEditWorkItem: (
      agentId: string,
      input: SandboxAgentEditWorkItemOpenInput
    ) => client.openAgentEditWorkItem(agentId, input),
  };
}

export function createSandboxWorkItemNamespace(client: OpenPondSandboxClient) {
  return {
    get: (workItemId: string, input: SandboxCodingWorkItemGetInput) =>
      client.getCodingWorkItem(workItemId, input),
    chat: (workItemId: string, input: SandboxCodingWorkItemChatInput) =>
      client.sendCodingWorkItemChat(workItemId, input),
    activity: (
      workItemId: string,
      input: SandboxCodingWorkItemActivityListInput
    ) => client.listCodingWorkItemActivity(workItemId, input),
    status: (
      workItemId: string,
      input: SandboxCodingWorkItemActivityListInput & {
        includeArchived?: boolean;
      }
    ) => client.getCodingWorkItemStatus(workItemId, input),
    handleBackground: (
      workItemId: string,
      input: SandboxCodingWorkItemBackgroundInput
    ) => client.handleCodingWorkItemInBackground(workItemId, input),
    promoteCheckpoint: (
      workItemId: string,
      input: SandboxCodingWorkItemPromotionInput
    ) => client.promoteCodingWorkItemResult(workItemId, "checkpoint", input),
    promoteCommit: (
      workItemId: string,
      input: SandboxCodingWorkItemPromotionInput
    ) => client.promoteCodingWorkItemResult(workItemId, "commit", input),
    promotePullRequest: (
      workItemId: string,
      input: SandboxCodingWorkItemPromotionInput
    ) => client.promoteCodingWorkItemResult(workItemId, "pr", input),
  };
}
