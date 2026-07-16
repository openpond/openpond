import type { IncomingMessage, ServerResponse } from "node:http";
import type { BootstrapPayload } from "@openpond/contracts";
import type { OrganizationRequestAction } from "../openpond/organizations.js";
import type { SandboxRequestAction } from "../openpond/sandboxes.js";
import type { TeamChatRequestAction } from "../openpond/team-chat-client.js";
import type { CommunityRequestAction } from "../openpond/community-client.js";

export type HttpRouteLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
};

export type WorkspaceImagePayload = {
  path: string;
  contentType: string;
  bytes: Buffer;
  sizeBytes: number;
};

export type ChatAttachmentImagePayloadRequest = {
  sessionId: string;
  turnId: string;
  attachmentId: string;
  storageName: string;
  contentType: string;
};

export type HttpRouteDeps = {
  host: string;
  getActualPort: () => number;
  token: string;
  version: string;
  runtimeVersion: string;
  logger: HttpRouteLogger;
  slowRouteThresholdMs?: number;
  openEventSubscriber: (input: {
    response: ServerResponse;
    afterSequence: number;
    sessionId: string | null;
  }) => Promise<() => void>;
  refreshCodexStatus: (force?: boolean) => Promise<unknown>;
  bootstrapPayload: (options?: { forceOpenPond?: boolean; ensureProfile?: boolean }) => Promise<BootstrapPayload>;
  eventPagePayload: (requestUrl: URL) => Promise<unknown>;
  usageSummaryPayload: (requestUrl: URL) => Promise<unknown>;
  usageRecordsPayload: (requestUrl: URL) => Promise<unknown>;
  listInsightsPayload: (requestUrl: URL) => Promise<unknown>;
  runInsightsScanPayload: (requestUrl?: URL) => Promise<unknown>;
  askInsightsPayload: (payload: unknown) => Promise<unknown>;
  patchInsightPayload: (insightId: string, payload: unknown) => Promise<unknown>;
  trainingPayload: (action: string, payload: unknown, requestUrl?: URL) => Promise<unknown>;
  computePayload: (action: string, payload: unknown) => Promise<unknown>;
  listLocalAgentSchedulesPayload: (payload?: unknown) => Promise<unknown>;
  syncLocalAgentSchedulesPayload: () => Promise<unknown>;
  patchLocalAgentSchedulePayload: (scheduleId: string, payload: unknown) => Promise<unknown>;
  runLocalAgentSchedulePayload: (scheduleId: string, payload: unknown) => Promise<unknown>;
  listLocalAgentScheduleRunsPayload: (scheduleId: string, payload?: unknown) => Promise<unknown>;
  loadMoreOpenPondAppsPayload: (requestUrl: URL) => Promise<unknown>;
  workspaceTemplateConfigPayload: (appId: string) => Promise<unknown>;
  refreshOpenPondPayload: () => Promise<unknown>;
  codexHistoryThreadPayload: (sessionId: string, requestUrl?: URL) => Promise<unknown>;
  sendCodexHistoryTurnPayload: (sessionId: string, payload: unknown) => Promise<unknown>;
  interruptCodexHistoryTurnPayload: (sessionId: string) => Promise<unknown>;
  switchOpenPondPayload: (payload: unknown) => Promise<unknown>;
  saveOpenPondAccountPayload: (payload: unknown) => Promise<unknown>;
  updateOpenPondAccountConfigPayload: (payload: unknown) => Promise<unknown>;
  profileCurrentPayload: () => Promise<unknown>;
  profileCatalogPayload: () => Promise<unknown>;
  profileInitPayload: (payload: unknown) => Promise<unknown>;
  profileLoadPayload: (payload: unknown) => Promise<unknown>;
  profileCheckPayload: (payload: unknown) => Promise<unknown>;
  profileCommitPayload: (payload: unknown) => Promise<unknown>;
  profilePushPayload: (payload: unknown) => Promise<unknown>;
  profileRunPayload: (payload: unknown) => Promise<unknown>;
  updateAppPreferencesPayload: (payload: unknown) => Promise<unknown>;
  providerSettingsPayload: () => Promise<unknown>;
  updateProviderSettingsPayload: (payload: unknown) => Promise<unknown>;
  listProviderModelsPayload: (providerId: string, payload: unknown) => Promise<unknown>;
  refreshProviderModelsPayload: (providerId: string, payload: unknown) => Promise<unknown>;
  writeProviderCredentialPayload: (providerId: string, payload: unknown) => Promise<unknown>;
  deleteProviderCredentialPayload: (providerId: string, payload: unknown) => Promise<unknown>;
  startOpenAiSubscriptionAuthPayload: (payload: unknown) => Promise<unknown>;
  validateProviderCredentialPayload: (providerId: string, payload: unknown) => Promise<unknown>;
  providerDiagnosticsPayload: () => Promise<unknown>;
  recordClientDiagnosticPayload: (payload: unknown) => Promise<unknown>;
  updatePersonalizationPayload: (payload: unknown) => Promise<unknown>;
  reorderSidebarApps: (payload: unknown) => Promise<unknown>;
  patchSidebarAppPreference: (appId: string, payload: unknown) => Promise<unknown>;
  workspaceStatePayload: (appId: string, ensureWorkspace: boolean) => Promise<unknown>;
  createWorkspaceBranchPayload: (appId: string, payload: unknown) => Promise<unknown>;
  checkoutWorkspaceBranchPayload: (appId: string, payload: unknown) => Promise<unknown>;
  workspaceDiffPayload: (appId: string) => Promise<unknown>;
  workspaceFilePayload: (appId: string, filePath: string | null) => Promise<unknown>;
  saveWorkspaceFilePayload: (appId: string, payload: unknown) => Promise<unknown>;
  workspaceImagePayload: (appId: string, filePath: string | null) => Promise<WorkspaceImagePayload>;
  localImagePayload: (filePath: string) => Promise<WorkspaceImagePayload>;
  chatAttachmentImagePayload: (input: ChatAttachmentImagePayloadRequest) => Promise<WorkspaceImagePayload>;
  workspaceLspTouchPayload: (appId: string, payload: unknown) => Promise<unknown>;
  workspaceLspActionPayload: (appId: string, payload: unknown) => Promise<unknown>;
  workspaceLspSettingsStatusPayload: () => Promise<unknown>;
  workspaceLspRuntimeStatusPayload: () => Promise<unknown>;
  restartWorkspaceLspPayload: () => Promise<unknown>;
  createLocalProjectPayload: (payload: unknown) => Promise<unknown>;
  deleteLocalProjectPayload: (projectId: string) => Promise<unknown>;
  updateLocalProjectAgentSetupPayload: (projectId: string, payload: unknown) => Promise<unknown>;
  previewLocalProjectCloudSourcePayload: (projectId: string, payload?: unknown) => Promise<unknown>;
  uploadLocalProjectCloudSourcePayload: (projectId: string, payload: unknown) => Promise<unknown>;
  listCloudWorkItemsPayload: (payload: unknown) => Promise<unknown>;
  getCloudWorkItemPayload: (workItemId: string, payload: unknown) => Promise<unknown>;
  createCloudWorkItemPayload: (payload: unknown) => Promise<unknown>;
  sendCloudWorkItemMessagePayload: (workItemId: string, payload: unknown) => Promise<unknown>;
  handleCloudWorkItemBackgroundPayload: (workItemId: string, payload: unknown) => Promise<unknown>;
  cancelCloudWorkItemTaskPayload: (workItemId: string, payload: unknown) => Promise<unknown>;
  openCloudWorkItemPayload: (workItemId: string, payload: unknown) => Promise<unknown>;
  applyCloudWorkItemLocalPatchPayload: (workItemId: string, payload: unknown) => Promise<unknown>;
  organizationPayload: (action: OrganizationRequestAction) => Promise<unknown>;
  sandboxPayload: (action: SandboxRequestAction) => Promise<unknown>;
  teamChatPayload: (action: TeamChatRequestAction) => Promise<unknown>;
  communityPayload: (action: CommunityRequestAction) => Promise<unknown>;
  executeTeamChatAiTurn: (turnId: string, teamId: string) => { accepted: true };
  cancelTeamChatAiTurnExecution: (turnId: string, teamId?: string) => Promise<{ cancelled: boolean }>;
  gitAvailabilityPayload: () => Promise<unknown>;
  startGitInstallPayload: () => Promise<unknown>;
  remoteAccessPayload: () => Promise<unknown>;
  enableRemoteAccessPayload: () => Promise<unknown>;
  disableRemoteAccessPayload: () => Promise<unknown>;
  voiceTranscriptionStatusPayload: () => Promise<unknown>;
  transcribeVoicePayload: (payload: unknown) => Promise<unknown>;
  browserControlRegister: (payload: unknown) => unknown;
  browserControlNext: (request: IncomingMessage) => Promise<unknown>;
  browserControlComplete: (request: IncomingMessage, requestId: string, payload: unknown) => unknown;
  browserControlStatus: () => unknown;
  createSession: (payload: unknown) => Promise<unknown>;
  patchSession: (sessionId: string, payload: unknown) => Promise<unknown>;
  sendTurn: (sessionId: string, payload: unknown) => Promise<unknown>;
  runSessionCommand: (sessionId: string, payload: unknown) => Promise<unknown>;
  ensureCloudWorkspaceReady: (sessionId: string, payload: unknown) => Promise<unknown>;
  recordPreflightTurnFailure: (sessionId: string, payload: unknown) => Promise<unknown>;
  updateTurnCreatePipeline: (
    sessionId: string,
    turnId: string,
    payload: unknown,
  ) => Promise<unknown>;
  interruptSessionTurn: (sessionId: string) => Promise<unknown>;
  pauseSessionGoal: (sessionId: string) => Promise<unknown>;
  compactSession: (sessionId: string, payload: unknown) => Promise<unknown>;
  executeWorkspaceTool: (sessionId: string, payload: unknown) => Promise<unknown>;
  runSubagentLifecycleAction: (runId: string, payload: unknown) => Promise<unknown>;
  resolveApproval: (approvalId: string, payload: unknown) => Promise<unknown>;
};

export type HttpRouteContext = {
  deps: HttpRouteDeps;
  request: IncomingMessage;
  requestUrl: URL;
  response: ServerResponse;
};

export type HttpRouteModule = {
  id: string;
  handle: (context: HttpRouteContext) => Promise<boolean>;
};
