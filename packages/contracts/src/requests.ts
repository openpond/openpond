import { z } from "zod";
import {
  CreateImproveRunActionSchema,
  CreateImproveRunSchema,
} from "./create-pipeline.js";
import {
  DEFAULT_CHAT_PROVIDER,
  OpenPondCommandAccessModeSchema,
  CodexReasoningEffortSchema,
  ChatProviderSchema,
  CodexPermissionModeSchema,
  ContextCompactionPreferencesSchema,
  GoalStorageLocationSchema,
  InsightsEvidenceSourceSettingsSchema,
  PersonalizationTemplateIdSchema,
  SidebarSectionsCollapsedSchema,
  TrainingPreferencesSchema,
  WorkspaceEditorPreferencesSchema,
  WorkspaceKindSchema,
} from "./settings.js";
import { SystemSessionKindSchema, type Session } from "./sessions.js";
import {
  SubagentDelegationModeSchema,
  SubagentPreferencesSchema,
  SubagentRoleIdSchema,
} from "./subagents.js";
import {
  ChatModelRefSchema,
  ProviderCredentialDeleteRequestSchema,
  ProviderCredentialWriteRequestSchema,
  ProviderModelsRefreshRequestSchema,
  ProviderModelsRequestSchema,
  ProviderSettingsUpdateSchema,
  ProviderValidationRequestSchema,
} from "./providers.js";
import { SidebarAppPreferenceSchema } from "./workspaces.js";
import { UsageRequestAttributionSchema } from "./usage.js";

const ConnectedAppProviderFamilyIdSchema = z.enum([
  "slack",
  "microsoft_teams",
  "github",
  "google",
  "x",
  "mcp",
]);

const ConnectedAppIdSchema = z.enum([
  "slack",
  "microsoft_teams",
  "github",
  "google",
  "x",
  "mcp",
]);

const ConnectedAppSetupSurfaceSchema = z.enum([
  "native_bot",
  "oauth_connector",
  "mcp_endpoint",
]);

export const MentionedConnectedAppRefSchema = z
  .object({
    kind: z.literal("integration"),
    provider: ConnectedAppProviderFamilyIdSchema,
    appIds: z.array(ConnectedAppIdSchema).min(1).max(4),
    setupSurfaces: z.array(ConnectedAppSetupSurfaceSchema).min(1).max(4),
    connectionIds: z.array(z.string().trim().min(1)).max(8).optional(),
    capabilities: z.array(z.string().trim().min(1)).max(64).optional(),
  })
  .strict();

export type MentionedConnectedAppRef = z.infer<typeof MentionedConnectedAppRefSchema>;

export const CHAT_ATTACHMENT_LIMITS = {
  maxAttachments: 10,
  maxAttachmentBytes: 12 * 1024 * 1024,
  maxAttachmentBase64Chars: Math.ceil((12 * 1024 * 1024 * 4) / 3) + 16,
  maxTextChars: 200_000,
} as const;

export const ChatAttachmentKindSchema = z.enum(["image", "text", "file"]);

export const ChatAttachmentImagePreviewSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  turnId: z.string().trim().min(1).max(200),
  attachmentId: z.string().trim().min(1).max(200),
  storageName: z.string().trim().min(1).max(240),
  contentType: z.string().trim().min(1).max(160),
});

export const ChatAttachmentSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(240),
  mediaType: z.string().trim().min(1).max(160),
  sizeBytes: z.number().int().nonnegative().max(CHAT_ATTACHMENT_LIMITS.maxAttachmentBytes),
  kind: ChatAttachmentKindSchema,
  text: z.string().max(CHAT_ATTACHMENT_LIMITS.maxTextChars).optional(),
  contentsBase64: z.string().max(CHAT_ATTACHMENT_LIMITS.maxAttachmentBase64Chars).optional(),
});

export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const ChatAttachmentSummarySchema = ChatAttachmentSchema.omit({
  text: true,
  contentsBase64: true,
}).extend({
  imagePreview: ChatAttachmentImagePreviewSchema.optional(),
});

export type ChatAttachmentSummary = z.infer<typeof ChatAttachmentSummarySchema>;

export const CreateSessionRequestSchema = z.object({
  provider: ChatProviderSchema.default(DEFAULT_CHAT_PROVIDER),
  modelRef: ChatModelRefSchema.optional(),
  openPondCommandAccessMode: OpenPondCommandAccessModeSchema.optional(),
  systemKind: SystemSessionKindSchema.nullable().optional(),
  hiddenFromDefaultSidebar: z.boolean().optional(),
  parentSessionId: z.string().trim().min(1).max(200).nullable().optional(),
  parentTurnId: z.string().trim().min(1).max(200).nullable().optional(),
  parentGoalId: z.string().trim().min(1).max(200).nullable().optional(),
  subagentRunId: z.string().trim().min(1).max(200).nullable().optional(),
  subagentRoleId: SubagentRoleIdSchema.nullable().optional(),
  subagentDelegationMode: SubagentDelegationModeSchema.nullable().optional(),
  appId: z.string().nullable().optional(),
  appName: z.string().nullable().optional(),
  workspaceKind: WorkspaceKindSchema.optional(),
  workspaceId: z.string().nullable().optional(),
  workspaceName: z.string().nullable().optional(),
  localProjectId: z.string().nullable().optional(),
  cloudProjectId: z.string().nullable().optional(),
  cloudTeamId: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  cwd: z.string().nullable().optional(),
  title: z.string().optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const UploadLocalProjectCloudSourceRequestSchema = z.object({
  teamId: z.string().trim().min(1),
  projectName: z.string().trim().min(1).max(120).optional(),
  branch: z.string().trim().min(1).max(120).optional(),
  chatSessionId: z.string().trim().min(1).max(200).optional(),
  displayPrompt: z.string().trim().min(1).max(2_000).optional(),
});

export type UploadLocalProjectCloudSourceRequest = z.infer<
  typeof UploadLocalProjectCloudSourceRequestSchema
>;

export const PreviewLocalProjectCloudSourceRequestSchema = z.object({
  branch: z.string().trim().min(1).max(120).optional(),
});

export type PreviewLocalProjectCloudSourceRequest = z.infer<
  typeof PreviewLocalProjectCloudSourceRequestSchema
>;

export const ListCloudWorkItemsRequestSchema = z.object({
  teamId: z.string().trim().min(1),
  projectIds: z.array(z.string().trim().min(1)).min(1).max(100),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export type ListCloudWorkItemsRequest = z.infer<typeof ListCloudWorkItemsRequestSchema>;

export const CreateCloudWorkItemRequestSchema = z.object({
  teamId: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(500),
  initialMessage: z.string().trim().min(1).max(20_000).optional().nullable(),
  sourceRef: z.string().trim().min(1).max(191).optional().nullable(),
  baseSha: z.string().trim().min(1).max(191).optional().nullable(),
  assignedAgentId: z.string().trim().min(1).max(191).optional().nullable(),
  localProjectId: z.string().trim().min(1).max(191).optional().nullable(),
  localProjectName: z.string().trim().min(1).max(500).optional().nullable(),
  localWorkspacePath: z.string().trim().min(1).max(2000).optional().nullable(),
  requestedExecutionTarget: z
    .enum(["queue_cloud", "cloud_workspace", "cloud_home"])
    .optional()
    .nullable(),
  createImproveRun: CreateImproveRunSchema.optional().nullable(),
  usageAttribution: UsageRequestAttributionSchema.optional().nullable(),
});

export type CreateCloudWorkItemRequest = z.infer<typeof CreateCloudWorkItemRequestSchema>;

export const SendCloudWorkItemMessageRequestSchema = z.object({
  teamId: z.string().trim().min(1),
  message: z.string().trim().min(1).max(200_000),
  createImproveRun: CreateImproveRunSchema.optional().nullable(),
  usageAttribution: UsageRequestAttributionSchema.optional().nullable(),
});

export type SendCloudWorkItemMessageRequest = z.infer<
  typeof SendCloudWorkItemMessageRequestSchema
>;

export const CloudWorkItemBackgroundRequestSchema = z.object({
  teamId: z.string().trim().min(1),
  prompt: z.string().trim().min(1).max(20_000).optional().nullable(),
  sourceRef: z.string().trim().min(1).max(191).optional().nullable(),
  baseSha: z.string().trim().min(1).max(191).optional().nullable(),
  sourceRuntimeId: z.string().trim().min(1).max(191).optional().nullable(),
  sourceSandboxId: z.string().trim().min(1).max(191).optional().nullable(),
  agentId: z.string().trim().min(1).max(191).optional().nullable(),
  provider: z.enum(["openai_api", "codex_exec", "codex_sdk", "custom"]).optional(),
  branchPolicy: z
    .object({
      mode: z
        .enum([
          "patch_only",
          "commit_to_runtime_ref",
          "create_branch",
          "open_pr",
          "checkpoint_only",
        ])
        .default("patch_only"),
      branchName: z.string().trim().min(1).max(191).optional().nullable(),
    })
    .optional()
    .nullable(),
  setup: z
    .object({
      commands: z.array(z.string().trim().min(1).max(1000)).max(20),
    })
    .optional()
    .nullable(),
  validation: z
    .object({
      commands: z.array(z.string().trim().min(1).max(1000)).max(20),
    })
    .optional()
    .nullable(),
  budget: z
    .object({
      maxUsd: z.number().nonnegative().optional().nullable(),
      maxDurationSeconds: z.number().int().positive().optional().nullable(),
    })
    .optional()
    .nullable(),
  createImproveRun: CreateImproveRunSchema.optional().nullable(),
  usageAttribution: UsageRequestAttributionSchema.optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type CloudWorkItemBackgroundRequest = z.infer<
  typeof CloudWorkItemBackgroundRequestSchema
>;

export const OpenPondActionCatalogEntrySchema = z.object({
  id: z.string().trim().min(1).max(191),
  agentId: z.string().trim().min(1).max(191).optional().nullable(),
  sourcePath: z.string().trim().min(1).max(2000).optional().nullable(),
  sourceActionId: z.string().trim().min(1).max(191).optional().nullable(),
  name: z.string().trim().min(1).max(191).optional().nullable(),
  label: z.string().trim().min(1).max(160).optional().nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
  visibility: z.string().trim().max(80).optional().nullable(),
  inputSchema: z.union([z.string().trim().max(191), z.record(z.string(), z.unknown())]).optional().nullable(),
  outputSchema: z.union([z.string().trim().max(191), z.record(z.string(), z.unknown())]).optional().nullable(),
  approvalPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
  artifactPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
  setupRequirements: z.array(z.record(z.string(), z.unknown())).optional(),
  mcp: z.record(z.string(), z.unknown()).optional().nullable(),
  schedulePolicy: z.record(z.string(), z.unknown()).optional().nullable(),
  trace: z.record(z.string(), z.unknown()).optional().nullable(),
  implementation: z.record(z.string(), z.unknown()).optional().nullable(),
  invokesModel: z.boolean().optional(),
});

export type OpenPondActionCatalogEntry = z.infer<
  typeof OpenPondActionCatalogEntrySchema
>;

export const OpenCloudWorkItemRequestSchema = z.object({
  teamId: z.string().trim().min(1),
  runtimeId: z.string().trim().min(1).max(191).optional().nullable(),
  sandboxId: z.string().trim().min(1).max(191).optional().nullable(),
  sourceRef: z.string().trim().min(1).max(191).optional().nullable(),
  baseSha: z.string().trim().min(1).max(191).optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type OpenCloudWorkItemRequest = z.infer<typeof OpenCloudWorkItemRequestSchema>;

export const ApplyCloudWorkItemLocalPatchRequestSchema = z.object({
  teamId: z.string().trim().min(1),
  localProjectId: z.string().trim().min(1).optional().nullable(),
  sandboxId: z.string().trim().min(1).max(191).optional().nullable(),
  baseRef: z.string().trim().min(1).max(191).optional().nullable(),
});

export type ApplyCloudWorkItemLocalPatchRequest = z.infer<
  typeof ApplyCloudWorkItemLocalPatchRequestSchema
>;

export const SendTurnRequestSchema = z.object({
  prompt: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  usageAttribution: UsageRequestAttributionSchema.optional().nullable(),
  cwd: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  modelRef: ChatModelRefSchema.optional(),
  mentionedAppIds: z.array(z.string().trim().min(1)).max(8).optional(),
  mentionedConnectedApps: z.array(MentionedConnectedAppRefSchema).max(8).optional(),
  openPondActionCatalog: z.array(OpenPondActionCatalogEntrySchema).max(100).optional(),
  attachments: z.array(ChatAttachmentSchema).max(CHAT_ATTACHMENT_LIMITS.maxAttachments).optional(),
  createImproveRun: CreateImproveRunSchema.optional().nullable(),
  approvalPolicy: z.enum(["untrusted", "on-failure", "on-request", "never"]).default("on-request"),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  codexPermissionMode: CodexPermissionModeSchema.default("default"),
  codexReasoningEffort: CodexReasoningEffortSchema.optional(),
});

export type SendTurnRequest = z.infer<typeof SendTurnRequestSchema>;

export const RecordPreflightTurnFailureRequestSchema = z.object({
  prompt: z.string().min(1),
  error: z.string().min(1),
  target: z.enum(["cloud_workspace", "hybrid_sandbox"]),
});

export type RecordPreflightTurnFailureRequest = z.infer<
  typeof RecordPreflightTurnFailureRequestSchema
>;

export const ApplyCreateImproveRunActionRequestSchema = CreateImproveRunActionSchema;

export type ApplyCreateImproveRunActionRequest = z.infer<
  typeof ApplyCreateImproveRunActionRequestSchema
>;

export const CompactSessionRequestSchema = z.object({
  reason: z.enum(["manual"]).default("manual"),
  model: z.string().nullable().optional(),
  modelRef: ChatModelRefSchema.optional(),
});

export type CompactSessionRequest = z.infer<typeof CompactSessionRequestSchema>;

export const PatchSessionRequestSchema = z.object({
  provider: ChatProviderSchema.optional(),
  modelRef: ChatModelRefSchema.nullable().optional(),
  openPondCommandAccessMode: OpenPondCommandAccessModeSchema.optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  order: z.number().optional(),
  title: z.string().optional(),
  parentSessionId: z.string().trim().min(1).max(200).nullable().optional(),
  parentTurnId: z.string().trim().min(1).max(200).nullable().optional(),
  parentGoalId: z.string().trim().min(1).max(200).nullable().optional(),
  subagentRunId: z.string().trim().min(1).max(200).nullable().optional(),
  subagentRoleId: SubagentRoleIdSchema.nullable().optional(),
  subagentDelegationMode: SubagentDelegationModeSchema.nullable().optional(),
  appId: z.string().nullable().optional(),
  appName: z.string().nullable().optional(),
  workspaceKind: WorkspaceKindSchema.optional(),
  workspaceId: z.string().nullable().optional(),
  workspaceName: z.string().nullable().optional(),
  localProjectId: z.string().nullable().optional(),
  cloudProjectId: z.string().nullable().optional(),
  cloudTeamId: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  cwd: z.string().nullable().optional(),
});

export type PatchSessionRequest = z.infer<typeof PatchSessionRequestSchema>;

export const RunSessionCommandRequestSchema = z.object({
  command: z.string().trim().min(1),
  cwd: z.string().trim().min(1).max(4096).nullable().optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
});

export type RunSessionCommandRequest = z.infer<typeof RunSessionCommandRequestSchema>;

export const PatchSidebarAppPreferenceRequestSchema = SidebarAppPreferenceSchema;

export type PatchSidebarAppPreferenceRequest = z.infer<typeof PatchSidebarAppPreferenceRequestSchema>;

export const ReorderSidebarAppsRequestSchema = z.object({
  appIds: z.array(z.string()).min(1),
});

export type ReorderSidebarAppsRequest = z.infer<typeof ReorderSidebarAppsRequestSchema>;

export const UpdateAppPreferencesRequestSchema = z.object({
  defaultChatProvider: ChatProviderSchema.optional(),
  defaultChatModel: z.string().min(1).optional(),
  defaultChatModelRef: ChatModelRefSchema.nullable().optional(),
  insightsEnabled: z.boolean().optional(),
  insightsModelRef: ChatModelRefSchema.nullable().optional(),
  insightsEvidenceSources: InsightsEvidenceSourceSettingsSchema.optional(),
  subagents: SubagentPreferencesSchema.optional(),
  codexPermissionMode: CodexPermissionModeSchema.optional(),
  codexReasoningEffort: CodexReasoningEffortSchema.optional(),
  openPondCommandAccessMode: OpenPondCommandAccessModeSchema.optional(),
  defaultBranchPrefix: z.string().trim().max(48).optional(),
  defaultNewProjectDirectory: z.string().trim().max(4096).optional(),
  goalStorageLocation: GoalStorageLocationSchema.optional(),
  defaultTeamId: z.string().trim().max(191).nullable().optional(),
  advancedWorkspaceControls: z.boolean().optional(),
  contextCompaction: ContextCompactionPreferencesSchema.optional(),
  training: TrainingPreferencesSchema.optional(),
  sidebarWidth: z.number().int().min(244).max(560).optional(),
  diffPanelWidth: z.number().int().min(320).max(2400).optional(),
  sidebarSectionsCollapsed: SidebarSectionsCollapsedSchema.optional(),
  editor: WorkspaceEditorPreferencesSchema.optional(),
});

export type UpdateAppPreferencesRequest = z.infer<typeof UpdateAppPreferencesRequestSchema>;

export const UpdateProviderSettingsRequestSchema = ProviderSettingsUpdateSchema;

export type UpdateProviderSettingsRequest = z.infer<typeof UpdateProviderSettingsRequestSchema>;

export const RecordClientDiagnosticRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    surface: z.string().trim().min(1).max(120).default("app"),
    stack: z.string().max(12000).nullable().optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type RecordClientDiagnosticRequest = z.infer<typeof RecordClientDiagnosticRequestSchema>;

export const SetProviderCredentialRequestSchema = ProviderCredentialWriteRequestSchema;

export type SetProviderCredentialRequest = z.infer<typeof SetProviderCredentialRequestSchema>;

export const DeleteProviderCredentialRequestSchema = ProviderCredentialDeleteRequestSchema;

export type DeleteProviderCredentialRequest = z.infer<typeof DeleteProviderCredentialRequestSchema>;

export const ValidateProviderRequestSchema = ProviderValidationRequestSchema;

export type ValidateProviderRequest = z.infer<typeof ValidateProviderRequestSchema>;

export const ListProviderModelsRequestSchema = ProviderModelsRequestSchema;

export type ListProviderModelsRequest = z.infer<typeof ListProviderModelsRequestSchema>;

export const RefreshProviderModelsRequestSchema = ProviderModelsRefreshRequestSchema;

export type RefreshProviderModelsRequest = z.infer<typeof RefreshProviderModelsRequestSchema>;

export const UpdatePersonalizationRequestSchema = z.object({
  activeTemplateId: PersonalizationTemplateIdSchema,
  templateName: z.string().trim().min(1).max(80),
  soul: z.string().trim().min(1).max(8000),
  saveAsNew: z.boolean().optional().default(false),
});

export type UpdatePersonalizationRequest = z.infer<typeof UpdatePersonalizationRequestSchema>;

export const ResolveApprovalRequestSchema = z.object({
  decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
});

export type ResolveApprovalRequest = z.infer<typeof ResolveApprovalRequestSchema>;

export const EnsureCloudWorkspaceReadyRequestSchema = z.object({
  branch: z.string().trim().min(1).max(240).nullable().optional(),
  surface: z.enum(["desktop", "terminal"]),
});

export type EnsureCloudWorkspaceReadyRequest = z.infer<typeof EnsureCloudWorkspaceReadyRequestSchema>;

export type CloudWorkspaceReadyStatus =
  | "already_running"
  | "waited_for_creating"
  | "started"
  | "resumed"
  | "restored"
  | "recreated";

export type EnsureCloudWorkspaceReadyResponse = {
  output?: string;
  session: Session;
  status: CloudWorkspaceReadyStatus;
};

export const SwitchOpenPondAccountRequestSchema = z.object({
  handle: z.string().min(1),
  baseUrl: z.string().nullable().optional(),
});

export type SwitchOpenPondAccountRequest = z.infer<typeof SwitchOpenPondAccountRequestSchema>;

export const SaveOpenPondAccountRequestSchema = z.object({
  handle: z.string().min(1).optional(),
  apiKey: z.string().min(1),
  baseUrl: z.string().nullable().optional(),
  apiBaseUrl: z.string().nullable().optional(),
  chatApiBaseUrl: z.string().nullable().optional(),
  environment: z.string().nullable().optional(),
  setActive: z.boolean().optional(),
});

export type SaveOpenPondAccountRequest = z.infer<typeof SaveOpenPondAccountRequestSchema>;

export const UpdateOpenPondAccountConfigRequestSchema = z.object({
  handle: z.string().min(1),
  currentBaseUrl: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
  apiBaseUrl: z.string().nullable().optional(),
  chatApiBaseUrl: z.string().nullable().optional(),
  environment: z.string().nullable().optional(),
  setActive: z.boolean().optional(),
});

export type UpdateOpenPondAccountConfigRequest = z.infer<
  typeof UpdateOpenPondAccountConfigRequestSchema
>;
