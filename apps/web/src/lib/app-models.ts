import type { DragEvent } from "react";
import type {
  AppPreferences,
  ChatModelRef,
  ChatProvider,
  ChatAttachmentSummary,
  CloudProject,
  CodexPermissionMode,
  CodexReasoningEffort,
  CreatePipelineRequest,
  CreatePipelineSnapshot,
  LocalProject,
  PersonalizationSettings,
  ProviderModel,
  ProviderSettings,
  Session,
  WorkspaceDiffSummary,
  WorkspaceLspGlobalMode,
  WorkspaceLspLanguageMode,
} from "@openpond/contracts";
import {
  DEFAULT_CHAT_PROVIDER,
  DEFAULT_CODEX_CHAT_MODEL,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_OPENPOND_CHAT_MODEL,
  PROVIDER_IDS,
} from "@openpond/contracts";

export type AppView =
  | "chat"
  | "apps"
  | "cloud"
  | "get-started"
  | "insights"
  | "profile"
  | "settings";
export type SettingsSection =
  | "account"
  | "profile"
  | "wallet"
  | "defaults"
  | "editor"
  | "providers"
  | "remote"
  | "personalization"
  | "diagnostics";
export type ActivityItem = {
  id: string;
  label: string;
  content: string;
  timestamp: string;
  kind?: "command" | "control";
  controlKind?: "goal_context" | "turn_aborted";
  callId?: string;
  detail?: string;
  state?: "running" | "completed" | "failed" | "pending";
  imagePreview?: {
    path: string;
    appId: string | null;
    title: string;
  };
};

export type ActionRunRef = {
  id: string;
  kind: "artifact" | "trace" | "eval" | "source" | "output";
  label: string;
  target: string;
};

export type ActionRunChildCall = {
  id: string;
  label: string;
  status: "running" | "completed" | "failed" | "pending" | "unknown";
  detail: string | null;
};

export type ActionRunSummary = {
  actionName: string;
  title: string;
  status: "running" | "completed" | "failed" | "pending" | "unknown";
  responseText: string | null;
  runId: string | null;
  projectId: string | null;
  agentId: string | null;
  agentName?: string | null;
  sandboxId: string | null;
  runtimeId: string | null;
  implementationType: string | null;
  sourceRef: string | null;
  manifestHash: string | null;
  refs: ActionRunRef[];
  childCalls: ActionRunChildCall[];
};

export type InsightsRunPromptEvidenceItem = {
  evidenceSource: string;
  evidenceKey: string;
  fingerprint: string | null;
  severity: string | null;
  type: string | null;
  title: string | null;
  summary: string | null;
  sourceSessionId: string | null;
  sourceTurnId: string | null;
  createPipelineState: string | null;
  sourceEventSequence: number | null;
};

export type InsightsRunPromptSummary = {
  runId: string | null;
  trigger: string | null;
  status: string | null;
  evidenceSources: string[];
  eventCount: number | null;
  afterSequence: number | null;
  latestSequence: number | null;
  findingCount: number | null;
  promptLength: number;
  totalEvidenceCount: number;
  truncated: boolean;
  items: InsightsRunPromptEvidenceItem[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "activity_group" | "error" | "status_divider";
  content?: string;
  attachments?: ChatAttachmentSummary[];
  timestamp: string;
  turnId?: string;
  activities?: ActivityItem[];
  changeSummary?: WorkspaceDiffSummary;
  statusKind?: "compaction";
  statusState?: "running" | "completed" | "failed";
  statusTone?: "info" | "success" | "danger";
  actionRun?: ActionRunSummary;
  insightsRunPrompt?: InsightsRunPromptSummary;
  createPipelineRequest?: CreatePipelineRequest | null;
  createPipeline?: CreatePipelineSnapshot | null;
  createPipelineDebugActivities?: ActivityItem[];
};

export const SIDEBAR_SECTION_LIMIT = 5;
export const SIDEBAR_CHAT_PAGE_SIZE = 10;

export type DropdownOption = {
  value: string;
  label: string;
  shortLabel?: string;
  description?: string;
  icon?: "plus";
  separatorBefore?: boolean;
};

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  defaultChatProvider: DEFAULT_CHAT_PROVIDER,
  defaultChatModel: DEFAULT_OPENPOND_CHAT_MODEL,
  insightsEnabled: true,
  insightsModelRef: null,
  insightsEvidenceSources: {
    createEdit: true,
    stuckTurns: true,
    toolFailures: true,
    abandonedGoals: true,
    userCorrections: true,
    unresolvedConversations: true,
  },
  codexPermissionMode: DEFAULT_CODEX_PERMISSION_MODE,
  codexReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
  defaultBranchPrefix: "feat/",
  defaultNewProjectDirectory: "",
  goalStorageLocation: "global",
  defaultTeamId: null,
  advancedWorkspaceControls: false,
  sidebarWidth: 332,
  diffPanelWidth: 560,
  sidebarSectionsCollapsed: {
    pinned: false,
    projects: false,
    cloudProjects: false,
    chats: false,
  },
  editor: {
    languageServers: "auto",
    diagnosticsWhileEditing: true,
    checkOnSave: true,
    languages: {
      typescript: { mode: "auto", customCommand: "" },
      python: { mode: "auto", customCommand: "" },
      rust: { mode: "auto", customCommand: "" },
    },
  },
};

export const EMPTY_PERSONALIZATION: PersonalizationSettings = {
  activeTemplateId: "default",
  customized: false,
  soul: "",
  soulPath: null,
  updatedAt: null,
  templates: [],
};

const OPENPOND_MODEL_OPTIONS = [
  { value: DEFAULT_OPENPOND_CHAT_MODEL, label: "OpenPond Chat" },
];
export const PROVIDER_OPTIONS: Array<DropdownOption & { value: ChatProvider }> = [
  { value: "openpond", label: "OpenPond Chat", description: "OpChat" },
  { value: "codex", label: "Codex", description: "Local Codex" },
];
export const OPENAI_COMPATIBLE_CHAT_PROVIDER_IDS = [
  "openai",
  "openrouter",
  "deepseek",
  "zai",
  "moonshot",
  "together",
  "groq",
  "fireworks",
  "custom-openai-compatible",
] as const satisfies readonly ChatProvider[];
export const RUNNABLE_CHAT_PROVIDER_IDS = [
  "openpond",
  "codex",
  ...OPENAI_COMPATIBLE_CHAT_PROVIDER_IDS,
] as const satisfies readonly ChatProvider[];
const RUNNABLE_CHAT_PROVIDER_ID_SET = new Set<ChatProvider>(RUNNABLE_CHAT_PROVIDER_IDS);
export const CODEX_MODEL_OPTIONS: DropdownOption[] = [
  { value: DEFAULT_CODEX_CHAT_MODEL, label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  { value: "gpt-5.2", label: "GPT-5.2" },
];
export const CODEX_PERMISSION_MODE_OPTIONS: Array<DropdownOption & { value: CodexPermissionMode }> =
  [
    {
      value: "default",
      label: "Default permissions",
      shortLabel: "Default",
      description: "Workspace sandbox; asks before crossing boundaries.",
    },
    {
      value: "auto-review",
      label: "Auto-review",
      description: "Workspace sandbox; reviewer handles eligible approvals.",
    },
    {
      value: "full-access",
      label: "Full access",
      description: "No sandbox or approval prompts.",
    },
  ];
export const CODEX_REASONING_EFFORT_OPTIONS: Array<DropdownOption & { value: CodexReasoningEffort }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High", shortLabel: "Extra High" },
];
export const LSP_GLOBAL_MODE_OPTIONS: Array<DropdownOption & { value: WorkspaceLspGlobalMode }> = [
  { value: "auto", label: "Auto", description: "Use installed language servers when available." },
  { value: "off", label: "Off", description: "Disable editor language servers." },
];
export const LSP_LANGUAGE_MODE_OPTIONS: Array<DropdownOption & { value: WorkspaceLspLanguageMode }> = [
  { value: "auto", label: "Auto", description: "Find the local executable automatically." },
  { value: "disabled", label: "Disabled", description: "Do not start this language server." },
  { value: "custom", label: "Custom", description: "Use a specific executable path or command name." },
];

export type SidebarProjectKind = "local" | "cloud";

export type ProjectSelection = {
  kind: SidebarProjectKind;
  id: string;
};

type SidebarProjectItemBase = {
  id: string;
  pinned: boolean;
  order: number;
};

export type SidebarProjectItem =
  | (SidebarProjectItemBase & {
      kind: "local";
      project: LocalProject;
    })
  | (SidebarProjectItemBase & {
      kind: "cloud";
      project: CloudProject;
    });

export function isLocalSidebarProjectItem(
  item: SidebarProjectItem,
): item is Extract<SidebarProjectItem, { kind: "local" }> {
  return item.kind === "local";
}

export function isCloudSidebarProjectItem(
  item: SidebarProjectItem,
): item is Extract<SidebarProjectItem, { kind: "cloud" }> {
  return item.kind === "cloud";
}

export function projectSelectionKey(kind: SidebarProjectKind, id: string): string {
  return `${kind}:${id}`;
}

export function sidebarProjectItemKey(item: SidebarProjectItem): string {
  return projectSelectionKey(item.kind, item.project.id);
}

export function parseProjectSelection(value: string | null | undefined): ProjectSelection | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0) return { kind: "local", id: trimmed };
  const kind = trimmed.slice(0, separatorIndex);
  const id = trimmed.slice(separatorIndex + 1);
  if ((kind === "local" || kind === "cloud") && id) return { kind, id };
  return { kind: "local", id: trimmed };
}

export type SidebarDragItem = {
  type: "project" | "session";
  id: string;
};

export type PinnedSidebarItem =
  | {
      type: "project";
      key: string;
      id: string;
      item: SidebarProjectItem;
      order: number;
    }
  | {
      type: "session";
      key: string;
      id: string;
      session: Session;
      order: number;
    };

export type SidebarDropPosition = "before" | "after";

export function sidebarDragKey(item: SidebarDragItem) {
  return `${item.type}:${item.id}`;
}

export function getSidebarDropPosition(event: DragEvent<HTMLDivElement>): SidebarDropPosition {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

export function reorderIds(
  ids: string[],
  sourceId: string,
  targetId: string,
  position: SidebarDropPosition = "before",
) {
  if (sourceId === targetId) return ids;
  const next = ids.filter((id) => id !== sourceId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex === -1) return ids;
  next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, sourceId);
  return next;
}

export function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function orderPinnedItemsByKeys(items: PinnedSidebarItem[], keys: string[] | null) {
  if (!keys) return items;
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  const ordered = keys
    .map((key) => itemByKey.get(key))
    .filter((item): item is PinnedSidebarItem => Boolean(item));
  const orderedKeys = new Set(ordered.map((item) => item.key));
  return [...ordered, ...items.filter((item) => !orderedKeys.has(item.key))];
}

function providerStatus(settings: ProviderSettings | null | undefined, provider: ChatProvider) {
  return settings?.statuses?.[provider] ?? null;
}

function providerConfig(settings: ProviderSettings | null | undefined, provider: ChatProvider) {
  return settings?.providers?.[provider] ?? null;
}

function providerModelCache(settings: ProviderSettings | null | undefined, provider: ChatProvider) {
  return settings?.modelCaches?.[provider] ?? null;
}

function modelOptionFromProviderModel(model: ProviderModel): DropdownOption {
  const details = [
    model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K context` : "",
    model.capabilities.reasoning ? "reasoning" : "",
    model.source,
  ].filter(Boolean);
  return {
    value: model.id,
    label: model.displayName || model.id,
    description: details.join(" · ") || undefined,
  };
}

function fallbackModelOptions(provider: ChatProvider): DropdownOption[] {
  if (provider === "openpond") return OPENPOND_MODEL_OPTIONS;
  if (provider === "codex") return CODEX_MODEL_OPTIONS;
  return [];
}

function uniqueDropdownOptions(options: DropdownOption[]): DropdownOption[] {
  const seen = new Set<string>();
  const output: DropdownOption[] = [];
  for (const option of options) {
    if (!option.value || seen.has(option.value)) continue;
    seen.add(option.value);
    output.push(option);
  }
  return output;
}

export function isRunnableChatProvider(provider: ChatProvider): boolean {
  return RUNNABLE_CHAT_PROVIDER_ID_SET.has(provider);
}

export function providerOptionsFromSettings(
  settings?: ProviderSettings | null,
  options: { includeUnavailable?: boolean; localOnly?: boolean; enabledOnly?: boolean } = {},
): Array<DropdownOption & { value: ChatProvider }> {
  if (!settings) return options.localOnly ? PROVIDER_OPTIONS : PROVIDER_OPTIONS;
  const includeUnavailable = options.includeUnavailable ?? false;
  const enabledOnly = options.enabledOnly ?? false;
  const rows: Array<DropdownOption & { value: ChatProvider }> = [];
  for (const providerId of PROVIDER_IDS) {
    if (!RUNNABLE_CHAT_PROVIDER_ID_SET.has(providerId)) continue;
    if (options.localOnly && providerId === "openpond") continue;
    const status = providerStatus(settings, providerId);
    if (!status) continue;
    if (!includeUnavailable) {
      if (providerId === "codex" && !status.available && !status.credential.connected) continue;
      if (providerId !== "openpond" && providerId !== "codex" && !status.enabled) continue;
    }
    if (enabledOnly && providerId !== "openpond" && !status.enabled) continue;
    if (enabledOnly && providerId === "codex" && !status.available && !status.credential.connected) {
      continue;
    }
    rows.push({
      value: providerId,
      label: providerId === "openpond" ? "OpenPond Chat" : status.displayName,
      description: status.available
        ? "Connected"
        : status.credential.connected
          ? "Configured"
          : status.routing.localByok
            ? "Set up key"
            : status.enabled
              ? "Enabled"
              : undefined,
    });
  }
  return rows.length > 0 ? rows : PROVIDER_OPTIONS;
}

export function modelOptionsForProvider(
  provider: ChatProvider,
  settings?: ProviderSettings | null,
): DropdownOption[] {
  const cached = providerModelCache(settings, provider)?.models ?? [];
  const fromCache = cached.map(modelOptionFromProviderModel);
  const config = providerConfig(settings, provider);
  const manual = [...(config?.modelOverrides ?? []), config?.defaultModel]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => ({ value, label: value }));
  return uniqueDropdownOptions([...fromCache, ...manual, ...fallbackModelOptions(provider)]);
}

export function defaultModelForProvider(
  provider: ChatProvider,
  settings?: ProviderSettings | null,
): string {
  const configDefault = providerConfig(settings, provider)?.defaultModel?.trim();
  if (configDefault) return configDefault;
  const statusDefault = providerStatus(settings, provider)?.defaultModel?.trim();
  if (statusDefault) return statusDefault;
  const firstOption = modelOptionsForProvider(provider, settings)[0]?.value?.trim();
  if (firstOption) return firstOption;
  if (provider === "codex") return DEFAULT_CODEX_CHAT_MODEL;
  if (provider === "openpond") return DEFAULT_OPENPOND_CHAT_MODEL;
  return "";
}

export function normalizeChatModel(
  provider: ChatProvider,
  model?: string | null,
  settings?: ProviderSettings | null,
): string {
  const trimmed = model?.trim();
  const options = modelOptionsForProvider(provider, settings);
  if (trimmed && options.some((option) => option.value === trimmed)) return trimmed;
  if (trimmed && provider !== "codex" && options.length === 0 && !settings) return trimmed;
  return defaultModelForProvider(provider, settings);
}

export function modelForTurn(
  provider: ChatProvider,
  model: string,
  settings?: ProviderSettings | null,
): string | undefined {
  const normalized = normalizeChatModel(provider, model, settings);
  return normalized || undefined;
}

export function modelRefForTurn(
  provider: ChatProvider,
  model: string,
  settings?: ProviderSettings | null,
): ChatModelRef | undefined {
  const modelId = modelForTurn(provider, model, settings);
  return modelId ? { providerId: provider, modelId } : undefined;
}

export function codexPermissionTurnInput(mode: CodexPermissionMode): {
  approvalPolicy: "on-request" | "never";
  sandbox: "workspace-write" | "danger-full-access";
} {
  if (mode === "full-access") {
    return {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    };
  }
  return {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  };
}

export function normalizePreferences(preferences?: AppPreferences | null): AppPreferences {
  const provider = preferences?.defaultChatProvider ?? DEFAULT_APP_PREFERENCES.defaultChatProvider;
  return {
    defaultChatProvider: provider,
    defaultChatModel: normalizeChatModel(provider, preferences?.defaultChatModel),
    insightsEnabled: preferences?.insightsEnabled ?? DEFAULT_APP_PREFERENCES.insightsEnabled,
    insightsModelRef: preferences?.insightsModelRef ?? DEFAULT_APP_PREFERENCES.insightsModelRef,
    insightsEvidenceSources: {
      ...DEFAULT_APP_PREFERENCES.insightsEvidenceSources,
      ...(preferences?.insightsEvidenceSources ?? {}),
    },
    codexPermissionMode:
      preferences?.codexPermissionMode ?? DEFAULT_APP_PREFERENCES.codexPermissionMode,
    codexReasoningEffort:
      preferences?.codexReasoningEffort ?? DEFAULT_APP_PREFERENCES.codexReasoningEffort,
    defaultBranchPrefix: normalizeBranchPrefix(preferences?.defaultBranchPrefix),
    defaultNewProjectDirectory:
      preferences?.defaultNewProjectDirectory ?? DEFAULT_APP_PREFERENCES.defaultNewProjectDirectory,
    goalStorageLocation:
      preferences?.goalStorageLocation ?? DEFAULT_APP_PREFERENCES.goalStorageLocation,
    defaultTeamId: preferences?.defaultTeamId?.trim() || null,
    advancedWorkspaceControls:
      preferences?.advancedWorkspaceControls ?? DEFAULT_APP_PREFERENCES.advancedWorkspaceControls,
    sidebarWidth: preferences?.sidebarWidth ?? DEFAULT_APP_PREFERENCES.sidebarWidth,
    diffPanelWidth: preferences?.diffPanelWidth ?? DEFAULT_APP_PREFERENCES.diffPanelWidth,
    sidebarSectionsCollapsed: {
      pinned:
        preferences?.sidebarSectionsCollapsed?.pinned ??
        DEFAULT_APP_PREFERENCES.sidebarSectionsCollapsed.pinned,
      projects:
        preferences?.sidebarSectionsCollapsed?.projects ??
        DEFAULT_APP_PREFERENCES.sidebarSectionsCollapsed.projects,
      cloudProjects:
        preferences?.sidebarSectionsCollapsed?.cloudProjects ??
        DEFAULT_APP_PREFERENCES.sidebarSectionsCollapsed.cloudProjects,
      chats:
        preferences?.sidebarSectionsCollapsed?.chats ??
        DEFAULT_APP_PREFERENCES.sidebarSectionsCollapsed.chats,
    },
    editor: {
      languageServers:
        preferences?.editor?.languageServers ?? DEFAULT_APP_PREFERENCES.editor.languageServers,
      diagnosticsWhileEditing:
        preferences?.editor?.diagnosticsWhileEditing ??
        DEFAULT_APP_PREFERENCES.editor.diagnosticsWhileEditing,
      checkOnSave:
        preferences?.editor?.checkOnSave ?? DEFAULT_APP_PREFERENCES.editor.checkOnSave,
      languages: {
        typescript: {
          mode:
            preferences?.editor?.languages?.typescript?.mode ??
            DEFAULT_APP_PREFERENCES.editor.languages.typescript.mode,
          customCommand:
            preferences?.editor?.languages?.typescript?.customCommand ??
            DEFAULT_APP_PREFERENCES.editor.languages.typescript.customCommand,
        },
        python: {
          mode:
            preferences?.editor?.languages?.python?.mode ??
            DEFAULT_APP_PREFERENCES.editor.languages.python.mode,
          customCommand:
            preferences?.editor?.languages?.python?.customCommand ??
            DEFAULT_APP_PREFERENCES.editor.languages.python.customCommand,
        },
        rust: {
          mode:
            preferences?.editor?.languages?.rust?.mode ??
            DEFAULT_APP_PREFERENCES.editor.languages.rust.mode,
          customCommand:
            preferences?.editor?.languages?.rust?.customCommand ??
            DEFAULT_APP_PREFERENCES.editor.languages.rust.customCommand,
        },
      },
    },
  };
}

export function normalizeBranchPrefix(value?: string | null): string {
  const trimmed = value?.trim() ?? DEFAULT_APP_PREFERENCES.defaultBranchPrefix;
  if (!trimmed) return "";
  const compact = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^-+/, "")
    .slice(0, 48);
  const cleaned = compact
    .split("/")
    .map((part) => part.replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("/");
  return cleaned ? `${cleaned}/` : "";
}

export function chatProviderLabel(provider: ChatProvider, settings?: ProviderSettings | null): string {
  if (provider === "openpond") return "OpenPond Chat";
  return providerStatus(settings, provider)?.displayName ?? (provider === "codex" ? "Codex" : provider);
}

export function chatModelLabel(model: string, settings?: ProviderSettings | null, provider?: ChatProvider): string {
  if (provider) {
    const option = modelOptionsForProvider(provider, settings).find((candidate) => candidate.value === model);
    if (option) return option.label;
  }
  if (settings) {
    for (const providerId of PROVIDER_IDS) {
      const option = modelOptionsForProvider(providerId, settings).find((candidate) => candidate.value === model);
      if (option) return option.label;
    }
  }
  return (
    [...OPENPOND_MODEL_OPTIONS, ...CODEX_MODEL_OPTIONS].find(
      (option) => option.value === model,
    )?.label ?? model
  );
}
