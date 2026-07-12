import { z } from "zod";
import {
  ChatModelRefSchema,
  ProviderIdSchema,
  ProviderSettingsSchema,
  type ProviderSettings,
} from "./providers.js";
import { SubagentPreferencesSchema } from "./subagents.js";

export const DEFAULT_CODEX_CHAT_MODEL = "gpt-5.6-sol" as const;
export const DEFAULT_CHAT_PROVIDER = "openai" as const;
export const DEFAULT_CHAT_MODEL = DEFAULT_CODEX_CHAT_MODEL;
export const DEFAULT_CODEX_PERMISSION_MODE = "default" as const;
export const DEFAULT_CODEX_REASONING_EFFORT = "high" as const;
export const DEFAULT_OPENPOND_COMMAND_ACCESS_MODE = "ask" as const;
export const DEFAULT_OPENPOND_CHAT_MODEL = "openpond-chat" as const;

export const ChatProviderSchema = ProviderIdSchema;

export type ChatProvider = z.infer<typeof ChatProviderSchema>;

export const CodexPermissionModeSchema = z.enum(["default", "auto-review", "full-access"]);

export type CodexPermissionMode = z.infer<typeof CodexPermissionModeSchema>;

export const OpenPondCommandAccessModeSchema = z.enum(["ask", "full-access", "disabled"]);

export type OpenPondCommandAccessMode = z.infer<typeof OpenPondCommandAccessModeSchema>;

export const CodexReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);

export type CodexReasoningEffort = z.infer<typeof CodexReasoningEffortSchema>;

export const WorkspaceKindSchema = z.enum([
  "sandbox_app",
  "local_project",
  "sandbox",
  "sandbox_template",
]);

export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;

export const HostedContextProviderSchema = z.enum(["openpond"]);

export type HostedContextProvider = z.infer<typeof HostedContextProviderSchema>;

export const ContextUsageSourceSchema = z.enum(["provider_usage", "provider_tokenizer", "heuristic"]);

export type ContextUsageSource = z.infer<typeof ContextUsageSourceSchema>;

export const ContextUsageSnapshotSchema = z.object({
  provider: ChatProviderSchema,
  model: z.string().min(1),
  usedTokens: z.number().int().nonnegative(),
  maxContextTokens: z.number().int().positive(),
  usableContextTokens: z.number().int().positive(),
  percentFull: z.number().min(0).max(100),
  source: ContextUsageSourceSchema,
  updatedAtEventId: z.string().nullable(),
});

export type ContextUsageSnapshot = z.infer<typeof ContextUsageSnapshotSchema>;

export const SidebarSectionsCollapsedSchema = z.object({
  pinned: z.boolean().default(false),
  projects: z.boolean().default(false),
  cloudProjects: z.boolean().default(false),
  chats: z.boolean().default(false),
});

export type SidebarSectionsCollapsed = z.infer<typeof SidebarSectionsCollapsedSchema>;

export const WorkspaceLspGlobalModeSchema = z.enum(["auto", "off"]);

export type WorkspaceLspGlobalMode = z.infer<typeof WorkspaceLspGlobalModeSchema>;

export const WorkspaceLspLanguageIdSchema = z.enum(["typescript", "python", "rust"]);

export type WorkspaceLspLanguageId = z.infer<typeof WorkspaceLspLanguageIdSchema>;

export const WorkspaceLspLanguageModeSchema = z.enum(["auto", "disabled", "custom"]);

export type WorkspaceLspLanguageMode = z.infer<typeof WorkspaceLspLanguageModeSchema>;

export const WorkspaceLspLanguagePreferenceSchema = z.object({
  mode: WorkspaceLspLanguageModeSchema.default("auto"),
  customCommand: z.string().trim().max(4096).default(""),
});

export type WorkspaceLspLanguagePreference = z.infer<typeof WorkspaceLspLanguagePreferenceSchema>;

export const WorkspaceEditorPreferencesSchema = z.object({
  languageServers: WorkspaceLspGlobalModeSchema.default("auto"),
  diagnosticsWhileEditing: z.boolean().default(true),
  checkOnSave: z.boolean().default(true),
  languages: z
    .object({
      typescript: WorkspaceLspLanguagePreferenceSchema.optional().default(() =>
        WorkspaceLspLanguagePreferenceSchema.parse({}),
      ),
      python: WorkspaceLspLanguagePreferenceSchema.optional().default(() =>
        WorkspaceLspLanguagePreferenceSchema.parse({}),
      ),
      rust: WorkspaceLspLanguagePreferenceSchema.optional().default(() =>
        WorkspaceLspLanguagePreferenceSchema.parse({}),
      ),
    })
    .optional()
    .default(() => ({
      typescript: WorkspaceLspLanguagePreferenceSchema.parse({}),
      python: WorkspaceLspLanguagePreferenceSchema.parse({}),
      rust: WorkspaceLspLanguagePreferenceSchema.parse({}),
    })),
});

export type WorkspaceEditorPreferences = z.infer<typeof WorkspaceEditorPreferencesSchema>;

export const WorkspaceLspSettingsStatusSchema = z.object({
  language: WorkspaceLspLanguageIdSchema,
  label: z.string(),
  mode: WorkspaceLspLanguageModeSchema,
  status: z.enum(["found", "missing", "disabled", "error"]),
  command: z.string().nullable(),
  message: z.string().nullable(),
});

export type WorkspaceLspSettingsStatus = z.infer<typeof WorkspaceLspSettingsStatusSchema>;

export const WorkspaceLspSettingsStatusResponseSchema = z.object({
  settings: WorkspaceEditorPreferencesSchema,
  languages: z.array(WorkspaceLspSettingsStatusSchema),
  updatedAt: z.string(),
});

export type WorkspaceLspSettingsStatusResponse = z.infer<typeof WorkspaceLspSettingsStatusResponseSchema>;

export const WorkspaceLspRuntimeClientStatusSchema = z.object({
  id: z.string(),
  root: z.string(),
  status: z.enum(["starting", "connected", "unavailable", "error"]),
  message: z.string().nullable().optional().default(null),
  openedDocuments: z.number().int().nonnegative(),
  pendingRequests: z.number().int().nonnegative(),
  lastUsedAt: z.string(),
  stderrTail: z.string(),
});

export type WorkspaceLspRuntimeClientStatus = z.infer<typeof WorkspaceLspRuntimeClientStatusSchema>;

export const WorkspaceLspRuntimeStatusResponseSchema = z.object({
  clients: z.array(WorkspaceLspRuntimeClientStatusSchema),
  maxClients: z.number().int().positive(),
  idleTimeoutMs: z.number().int().positive(),
  updatedAt: z.string(),
});

export type WorkspaceLspRuntimeStatusResponse = z.infer<typeof WorkspaceLspRuntimeStatusResponseSchema>;

export const GoalStorageLocationSchema = z.enum(["global", "workspace"]);

export type GoalStorageLocation = z.infer<typeof GoalStorageLocationSchema>;

export const InsightsEvidenceSourceSettingsSchema = z.object({
  createEdit: z.boolean().default(true),
  stuckTurns: z.boolean().default(true),
  toolFailures: z.boolean().default(true),
  abandonedGoals: z.boolean().default(true),
  userCorrections: z.boolean().default(true),
  unresolvedConversations: z.boolean().default(true),
  usageAnomalies: z.boolean().default(true),
});

export type InsightsEvidenceSourceSettings = z.infer<typeof InsightsEvidenceSourceSettingsSchema>;

export const ContextCompactionPreferencesSchema = z.object({
  autoEnabled: z.boolean().default(true),
  triggerPercent: z.number().int().min(50).max(95).default(85),
  summaryModel: z.enum(["same_model"]).default("same_model"),
});

export type ContextCompactionPreferences = z.infer<typeof ContextCompactionPreferencesSchema>;

export const TrainingPreferencesSchema = z.object({
  defaultModelRef: ChatModelRefSchema.nullable().default(null),
  creationMode: z.enum(["defaults", "customize"]).default("customize"),
  autoApproveEvidence: z.boolean().default(false),
});

export type TrainingPreferences = z.infer<typeof TrainingPreferencesSchema>;

export const AppPreferencesSchema = z.object({
  defaultChatProvider: ChatProviderSchema.default(DEFAULT_CHAT_PROVIDER),
  defaultChatModel: z.string().min(1).default(DEFAULT_CHAT_MODEL),
  defaultChatModelRef: ChatModelRefSchema.nullable().optional(),
  insightsEnabled: z.boolean().default(true),
  insightsModelRef: ChatModelRefSchema.nullable().optional().default(null),
  insightsEvidenceSources: InsightsEvidenceSourceSettingsSchema.optional().default(() =>
    InsightsEvidenceSourceSettingsSchema.parse({}),
  ),
  subagents: SubagentPreferencesSchema.optional().default(() => SubagentPreferencesSchema.parse({})),
  codexPermissionMode: CodexPermissionModeSchema.default(DEFAULT_CODEX_PERMISSION_MODE),
  codexReasoningEffort: CodexReasoningEffortSchema.default(DEFAULT_CODEX_REASONING_EFFORT),
  openPondCommandAccessMode: OpenPondCommandAccessModeSchema.default(DEFAULT_OPENPOND_COMMAND_ACCESS_MODE),
  defaultBranchPrefix: z.string().trim().max(48).default("feat/"),
  defaultNewProjectDirectory: z.string().trim().max(4096).default(""),
  goalStorageLocation: GoalStorageLocationSchema.default("global"),
  defaultTeamId: z.string().trim().max(191).nullable().default(null),
  advancedWorkspaceControls: z.boolean().default(false),
  contextCompaction: ContextCompactionPreferencesSchema.optional().default(() =>
    ContextCompactionPreferencesSchema.parse({}),
  ),
  training: TrainingPreferencesSchema.optional().default(() => TrainingPreferencesSchema.parse({})),
  sidebarWidth: z.number().int().min(244).max(560).default(332),
  diffPanelWidth: z.number().int().min(320).max(2400).default(560),
  sidebarSectionsCollapsed: SidebarSectionsCollapsedSchema.optional().default(() => SidebarSectionsCollapsedSchema.parse({})),
  editor: WorkspaceEditorPreferencesSchema.optional().default(() => WorkspaceEditorPreferencesSchema.parse({})),
});

export type AppPreferences = z.infer<typeof AppPreferencesSchema>;

export { ProviderSettingsSchema, type ProviderSettings };

export const DEFAULT_PERSONALIZATION_TEMPLATE_ID = "default" as const;

export const PERSONALIZATION_TEMPLATES = [
  {
    id: "default",
    name: "Balanced",
    source: "built_in",
    description: "Clear, useful, and concise.",
    content:
      "You are OpenPond Chat, a clear and useful AI assistant.\nBe concise, accurate, and direct.\nDo not use emojis.\nAsk only when missing information would materially change the answer.\nPrioritize practical next steps.",
  },
  {
    id: "pragmatic",
    name: "Pragmatic",
    source: "built_in",
    description: "Direct, practical, and engineering-minded.",
    content:
      "You are a pragmatic AI assistant with strong engineering judgment.\nBe direct, concrete, and outcome-focused.\nDo not use emojis.\nPrefer simple working solutions over clever abstractions.\nCall out weak assumptions plainly.",
  },
  {
    id: "friendly",
    name: "Friendly",
    source: "built_in",
    description: "Warm, conversational, and approachable.",
    content:
      "You are a friendly AI assistant.\nUse a warm, conversational tone without filler.\nDo not use emojis.\nExplain decisions clearly and keep the user moving.\nBe patient when clarifying tradeoffs.",
  },
  {
    id: "formal",
    name: "Formal",
    source: "built_in",
    description: "Polished, careful, and professional.",
    content:
      "You are a formal AI assistant.\nUse precise, professional language.\nDo not use emojis.\nStructure answers clearly and avoid casual phrasing.\nState uncertainty and assumptions explicitly.",
  },
  {
    id: "technical",
    name: "Technical",
    source: "built_in",
    description: "Precise, detailed, and implementation-focused.",
    content:
      "You are a technical AI assistant.\nPrioritize correctness, implementation detail, and edge cases.\nDo not use emojis.\nUse concise explanations, but include necessary specifics.\nSurface risks, constraints, and verification steps.",
  },
] as const;

export const PersonalizationTemplateIdSchema = z.string().trim().min(1).max(120);

export type PersonalizationTemplateId = z.infer<typeof PersonalizationTemplateIdSchema>;

export const PersonalizationTemplateSchema = z.object({
  id: PersonalizationTemplateIdSchema,
  name: z.string(),
  source: z.enum(["built_in", "custom"]).default("custom"),
  description: z.string(),
  content: z.string(),
});

export type PersonalizationTemplate = z.infer<typeof PersonalizationTemplateSchema>;

export const PersonalizationSettingsSchema = z.object({
  activeTemplateId: PersonalizationTemplateIdSchema.default(DEFAULT_PERSONALIZATION_TEMPLATE_ID),
  customized: z.boolean().default(false),
  soul: z.string(),
  soulPath: z.string().nullable(),
  updatedAt: z.string().nullable(),
  templates: z.array(PersonalizationTemplateSchema).default(() => [...PERSONALIZATION_TEMPLATES]),
});

export type PersonalizationSettings = z.infer<typeof PersonalizationSettingsSchema>;

export const ServerStatusSchema = z.object({
  id: z.string(),
  host: z.string(),
  port: z.number(),
  startedAt: z.string(),
  storePath: z.string(),
  version: z.string(),
  runtimeVersion: z.string(),
});

export type ServerStatus = z.infer<typeof ServerStatusSchema>;
