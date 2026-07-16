import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  ChatAttachment,
  ChatProvider,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondCommandAccessMode,
  OpenPondApp,
  OpenPondProfileSkill,
  ProviderSettings,
  SubagentDelegationMode,
  TeamChatMember,
} from "@openpond/contracts";
import {
  chatProviderLabel,
  modelOptionsForProvider,
  normalizeChatModel,
  providerOptionsFromSettings,
  type DropdownOption,
} from "../../lib/app-models";
import type { ContextWindowStatus } from "../../lib/context-window";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import type { WorkspaceTargetState, WorkspaceTargetValue } from "../../lib/workspace-location";
import type { ClientConnection } from "../../api";
import type { ShowAppToast } from "../../app/app-state";
import {
  activeMentionQuery,
  mentionTextForChatApp,
  mentionTokenForChatApp,
  normalizeMentionToken,
  promptContainsChatAppMention,
} from "../../lib/chat-app-mentions";
import { actionMentionMatchesForQuery } from "../../lib/action-mentions";
import {
  connectedAppMentionMatchesForQuery,
  connectedAppMentionText,
  type ConnectedAppMentionOption,
} from "../../lib/connected-app-mentions";
import {
  composerActionCatalogLabel,
} from "../../lib/composer-action-catalog";
import {
  COMPOSER_SLASH_COMMANDS,
  composerSlashCommandMatches,
  parseComposerSlashCommandPrompt,
  type ComposerSlashCommand,
} from "../../lib/composer-slash-commands";
import { formatSubmitIssueFormInput, type SubmitIssueFormInput } from "../../lib/submit-issue-command";
import {
  activeProfileSkillInvocationContext,
  profileSkillInvocationMatchesForQuery,
  replaceActiveProfileSkillInvocation,
} from "../../lib/profile-skill-invocations";
import { insertVoiceTranscript } from "../../lib/voice-text";
import {
  ComposerProjectTargetControl,
  WorkspaceActionControl,
  type ComposerProjectTargetState,
} from "./ComposerControls";
import { ComposerGoalStrip } from "./ComposerGoalStrip";
import {
  ComposerCreatePipelineStrip,
  type ComposerCreatePipelineRuntime,
} from "./ComposerCreatePipelineStrip";
import { ComposerSteerQueue } from "./ComposerSteerQueue";
import {
  composerSteerDraftsForScope,
  composerSteerDraftsAfterSubmit,
  composerSteerEditTarget,
  createComposerSteerDraft,
  removeComposerSteerDraft,
  shouldAutoDispatchComposerSteer,
  updateComposerSteerDraftScope,
  updateComposerSteerDraft,
  type ComposerSteerDraft,
  type ComposerSteerDraftScopeState,
} from "./composer-steer-queue";
import { slashMenuAnchorStyle } from "./ComposerLayout";
import {
  ComposerInlineInput,
  type ComposerInlineInputHandle,
  type ComposerInlineToken,
} from "./ComposerInlineInput";
import { ComposerMentionMenu, type ComposerMentionMenuItem } from "./ComposerMentionMenu";
import { ComposerPrimaryControls } from "./ComposerPrimaryControls";
import { ComposerSkillMenu, type ComposerSkillMenuItem } from "./ComposerSkillMenu";
import { ComposerSlashMenu, type SlashMenuItem } from "./ComposerSlashMenu";
import { SubmitIssueDialog } from "./SubmitIssueDialog";
import {
  ComposerAttachmentPreview,
  readComposerAttachmentPayload,
} from "./ComposerAttachments";
import { useComposerAttachments } from "./useComposerAttachments";

export type {
  ComposerProjectTargetOption,
  ComposerProjectTargetOptionKind,
  ComposerProjectTargetState,
} from "./ComposerControls";

export type ComposerProps = {
  mode: "dock" | "start";
  surface?: "chat" | "team";
  teamUseModel?: boolean;
  teamUseModelLocked?: boolean;
  teamMentionMembers?: TeamChatMember[];
  onTeamUseModelChange?: (value: boolean) => void;
  prompt: string;
  composeNotice?: ComposerNotice | null;
  mentionApps?: OpenPondApp[];
  connectedAppMentions?: ConnectedAppMentionOption[];
  profileSkills?: OpenPondProfileSkill[];
  selectedMentionAppId?: string | null;
  contextWindowStatus: ContextWindowStatus;
  goalRuntime?: GoalRuntimeStatus | null;
  subagentRuntime?: SubagentRuntimeStatus | null;
  createPipelineRuntime?: ComposerCreatePipelineRuntime | null;
  busy: boolean;
  running?: boolean;
  submissionScopeKey?: string;
  initialSteerDrafts?: ComposerSteerDraft[];
  steerAutoDispatchReady?: boolean;
  steerAutoDispatchBlocked?: boolean;
  showProjectFooter?: boolean;
  autoFocus?: boolean;
  focusRequestId?: number;
  connection: ClientConnection | null;
  providerSettings?: ProviderSettings | null;
  provider: ChatProvider;
  model: string;
  projectTarget: ComposerProjectTargetState;
  actionCatalog?: SandboxActionCatalogEntry[];
  workspaceTarget: WorkspaceTargetState;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  openPondCommandAccessMode: OpenPondCommandAccessMode;
  subagentDelegationDefaultMode?: SubagentDelegationMode;
  subagentDelegationMode?: SubagentDelegationMode | null;
  onProviderChange: (value: ChatProvider) => void;
  onProviderSetupOpen?: () => void;
  onProjectTargetChange: (value: string) => void;
  onWorkspaceTargetChange: (value: WorkspaceTargetValue) => void;
  onModelChange: (value: string) => void;
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
  onCodexReasoningEffortChange: (value: CodexReasoningEffort) => void;
  onOpenPondCommandAccessModeChange: (value: OpenPondCommandAccessMode) => void;
  onSubagentDelegationModeChange?: (mode: SubagentDelegationMode | null) => void;
  onPromptChange: (value: string) => void;
  onMentionAppSelect?: (appId: string | null) => void;
  showToast: ShowAppToast;
  onSubmit: (
    attachments?: ChatAttachment[],
    action?: SandboxActionCatalogEntry | null,
    command?: ComposerSlashCommand | null,
    options?: ComposerSubmitOptions,
  ) => Promise<boolean>;
  onStop: () => Promise<boolean | void> | boolean | void;
  onPauseGoal?: () => Promise<boolean | void> | boolean | void;
};

export type ComposerSubmitOptions = {
  displayPrompt?: string;
  preservePrompt?: boolean;
  promptOverride?: string;
};

export type ComposerNotice = {
  message: string;
  tone: "info" | "warning";
};

type ActiveSlashContext = {
  end: number;
  query: string;
  start: number;
};

const EMPTY_STEER_DRAFTS: ComposerSteerDraft[] = [];

const SUBMIT_ISSUE_COMMAND = COMPOSER_SLASH_COMMANDS.find(
  (command) => command.id === "submit-issue",
) as ComposerSlashCommand;

function activeSlashCommandContext(input: string, cursor: number): ActiveSlashContext | null {
  const beforeCursor = input.slice(0, Math.max(0, Math.min(cursor, input.length)));
  const match = /(?:^|\s)\/([a-zA-Z0-9_-]*)$/.exec(beforeCursor);
  if (!match || typeof match.index !== "number") return null;
  const slashOffset = match[0].lastIndexOf("/");
  if (slashOffset < 0) return null;
  const start = match.index + slashOffset;
  return {
    end: beforeCursor.length,
    query: (match[1] ?? "").toLowerCase(),
    start,
  };
}

function completedTypedSlashCommand(input: string, cursor: number): { command: ComposerSlashCommand; end: number; start: number } | null {
  const beforeCursor = input.slice(0, Math.max(0, Math.min(cursor, input.length)));
  const match = /(?:^|\s)\/([a-z][a-z0-9_-]*)\s$/.exec(beforeCursor);
  if (!match) return null;
  const command = COMPOSER_SLASH_COMMANDS.find((candidate) => candidate.id === match[1]);
  if (!command) return null;
  const slashOffset = match[0].lastIndexOf("/");
  if (slashOffset < 0 || typeof match.index !== "number") return null;
  return {
    command,
    end: beforeCursor.length,
    start: match.index + slashOffset,
  };
}

function slashCommandMatchesForQuery(query: string): ComposerSlashCommand[] {
  return composerSlashCommandMatches({ prompt: `/${query}` });
}

function slashActionMatchesForQuery(actions: SandboxActionCatalogEntry[], query: string): SandboxActionCatalogEntry[] {
  if (actions.length === 0) return [];
  return actions
    .filter((action) => {
      if (!query) return true;
      return [
        action.id,
        action.name ?? "",
        action.label ?? "",
        action.description ?? "",
        typeof action.implementation?.type === "string" ? action.implementation.type : "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .slice(0, 8);
}

function slashAppContextMatchesForQuery(apps: OpenPondApp[], query: string): OpenPondApp[] {
  if (apps.length === 0) return [];
  return apps
    .filter((app) => {
      if (!query) return true;
      return [
        app.id,
        app.name,
        app.description ?? "",
        app.gitRepo ?? "",
        mentionTokenForChatApp(app),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .slice(0, 8);
}

export function promptWithSelectedInvocationText(
  prompt: string,
  invocationText: string | null,
  position: number | null,
): string {
  const invocation = invocationText?.trim();
  if (!invocation) return prompt;
  const insertionPoint = Math.max(0, Math.min(position ?? 0, prompt.length));
  const before = prompt.slice(0, insertionPoint);
  const after = prompt.slice(insertionPoint);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";
  return `${before}${prefix}${invocation}${suffix}${after}`.replace(/\s+/g, " ").trim();
}

function synthesizedActionMentionText(action: SandboxActionCatalogEntry): string | null {
  const token = normalizeMentionToken(composerActionCatalogLabel(action) || action.name || action.id);
  return token ? `@${token}` : null;
}

export function selectedActionDisplayPrompt({
  action,
  prompt,
  selectedActionMentionText,
  selectedInvocationPosition,
}: {
  action: SandboxActionCatalogEntry | null;
  prompt: string;
  selectedActionMentionText: string | null;
  selectedInvocationPosition: number | null;
}): string | null {
  if (!action) return null;
  const explicitMention = selectedActionMentionText?.trim();
  const mentionText = explicitMention?.startsWith("@")
    ? explicitMention
    : synthesizedActionMentionText(action);
  return mentionText
    ? promptWithSelectedInvocationText(prompt, mentionText, selectedInvocationPosition)
    : null;
}

export function hasComposerSubmittableInput({
  attachmentCount,
  prompt,
  selectedAction,
  selectedCommand,
}: {
  attachmentCount: number;
  prompt: string;
  selectedAction: SandboxActionCatalogEntry | null;
  selectedCommand: ComposerSlashCommand | null;
}): boolean {
  return Boolean(prompt.trim() || attachmentCount > 0 || selectedAction || selectedCommand);
}

export function Composer({
  mode,
  surface = "chat",
  teamUseModel = false,
  teamUseModelLocked = false,
  teamMentionMembers = [],
  onTeamUseModelChange,
  prompt,
  composeNotice = null,
  mentionApps = [],
  connectedAppMentions = [],
  profileSkills = [],
  selectedMentionAppId = null,
  contextWindowStatus,
  goalRuntime = null,
  subagentRuntime = null,
  createPipelineRuntime = null,
  busy,
  running = busy,
  submissionScopeKey = "default",
  initialSteerDrafts = EMPTY_STEER_DRAFTS,
  steerAutoDispatchReady = false,
  steerAutoDispatchBlocked = false,
  showProjectFooter = true,
  autoFocus = false,
  focusRequestId = 0,
  connection,
  providerSettings = null,
  provider,
  model,
  projectTarget,
  actionCatalog = [],
  workspaceTarget,
  codexPermissionMode,
  codexReasoningEffort,
  openPondCommandAccessMode,
  subagentDelegationDefaultMode,
  subagentDelegationMode,
  onProviderChange,
  onProviderSetupOpen,
  onProjectTargetChange,
  onWorkspaceTargetChange,
  onModelChange,
  onCodexPermissionModeChange,
  onCodexReasoningEffortChange,
  onOpenPondCommandAccessModeChange,
  onSubagentDelegationModeChange,
  onPromptChange,
  onMentionAppSelect,
  showToast,
  onSubmit,
  onStop,
  onPauseGoal,
}: ComposerProps) {
  const composerRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<ComposerInlineInputHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const autoFocusAppliedRef = useRef(false);
  const focusRequestAppliedRef = useRef(0);
  const submittingScopeKeysRef = useRef<Set<string>>(new Set());
  const previousRunningScopeKeysRef = useRef<Set<string>>(running ? new Set([submissionScopeKey]) : new Set());
  const autoDispatchWaitingForStartedTurnScopeKeysRef = useRef<Set<string>>(new Set());
  const suppressNextAutoDispatchScopeKeysRef = useRef<Set<string>>(new Set());
  const [cursorIndex, setCursorIndex] = useState(prompt.length);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [skillIndex, setSkillIndex] = useState(0);
  const [actionIndex, setActionIndex] = useState(0);
  const [actionMenuDismissedPrompt, setActionMenuDismissedPrompt] = useState<string | null>(null);
  const [skillMenuDismissedPrompt, setSkillMenuDismissedPrompt] = useState<string | null>(null);
  const [mentionMenuStyle, setMentionMenuStyle] = useState<CSSProperties>({});
  const [skillMenuStyle, setSkillMenuStyle] = useState<CSSProperties>({});
  const [actionMenuStyle, setActionMenuStyle] = useState<CSSProperties>({});
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [selectedCommandId, setSelectedCommandId] = useState<ComposerSlashCommand["id"] | null>(null);
  const [selectedInvocationPosition, setSelectedInvocationPosition] = useState<number | null>(null);
  const [selectedActionMentionText, setSelectedActionMentionText] = useState<string | null>(null);
  const [serializingAttachmentScopeKey, setSerializingAttachmentScopeKey] = useState<string | null>(null);
  const [goalDetailsOpen, setGoalDetailsOpen] = useState(false);
  const [steerDraftsByScope, setSteerDraftsByScope] = useState<ComposerSteerDraftScopeState>(() => ({
    [submissionScopeKey]: initialSteerDrafts,
  }));
  const [sendingSteerDraft, setSendingSteerDraft] = useState<{ draftId: string; scopeKey: string } | null>(null);
  const [editingSteerDraftId, setEditingSteerDraftId] = useState<string | null>(null);
  const [editSteerDraftValue, setEditSteerDraftValue] = useState("");
  const [submitIssueDialogOpen, setSubmitIssueDialogOpen] = useState(false);
  const [submitIssueInitialDescription, setSubmitIssueInitialDescription] = useState("");
  const [submitIssueSubmitting, setSubmitIssueSubmitting] = useState(false);
  const {
    attachmentError,
    attachments,
    addFiles,
    removeAttachment,
    settleStagedAttachments,
    setAttachmentError,
    stageAttachmentsForSubmit,
  } = useComposerAttachments();
  const placeholder =
    surface === "team"
      ? "Message team"
      : mode === "start"
        ? "Ask Openpond Anything"
        : "Ask for follow-up changes";
  const modelValue = normalizeChatModel(provider, model, providerSettings);
  const dropdownPlacement = mode === "dock" || showProjectFooter ? "top" : "bottom";
  const contextStatusTooltipId = useId();
  const goalDetailsId = useId();
  const contextStatusStyle = {
    "--context-fill": `${Math.round(((contextWindowStatus.percent ?? 0) / 100) * 360)}deg`,
    "--context-bar-fill": `${contextWindowStatus.percent ?? 0}%`,
  } as CSSProperties;
  const selectedAction = useMemo(
    () => actionCatalog.find((action) => action.id === selectedActionId) ?? null,
    [actionCatalog, selectedActionId],
  );
  const selectedCommand = useMemo(
    () => COMPOSER_SLASH_COMMANDS.find((command) => command.id === selectedCommandId) ?? null,
    [selectedCommandId],
  );
  const selectedDisplayPrompt = selectedActionDisplayPrompt({
    action: selectedAction,
    prompt,
    selectedActionMentionText,
    selectedInvocationPosition,
  });
  const hasComposerInput = hasComposerSubmittableInput({
    attachmentCount: attachments.length,
    prompt,
    selectedAction,
    selectedCommand,
  });
  const selectedInvocationToken = useMemo<ComposerInlineToken | null>(() => {
    const position = Math.max(0, Math.min(selectedInvocationPosition ?? 0, prompt.length));
    if (selectedCommand) {
      return {
        icon: selectedCommand.id === "create" ? "plus" : "workflow",
        key: `command:${selectedCommand.id}`,
        label: selectedCommand.id === "create" ? "Make Agent" : selectedCommand.id,
        position,
        onRemove: () => {
          setSelectedCommandId(null);
          setSelectedInvocationPosition(null);
          setSelectedActionMentionText(null);
        },
      };
    }
    if (selectedAction) {
      return {
        icon: selectedAction.implementation?.type === "openpond-agent" ? "bot" : "workflow",
        key: `action:${selectedAction.id}`,
        label: composerActionCatalogLabel(selectedAction),
        position,
        onRemove: () => {
          setSelectedActionId(null);
          setSelectedInvocationPosition(null);
          setSelectedActionMentionText(null);
        },
      };
    }
    return null;
  }, [prompt.length, selectedAction, selectedCommand, selectedInvocationPosition]);
  const serializingAttachments = serializingAttachmentScopeKey === submissionScopeKey;
  const steering = running && hasComposerInput;
  const sendDisabled = serializingAttachments || !hasComposerInput;
  const sendTooltip = serializingAttachments ? "Preparing files" : steering ? "Steer" : "Send";
  const inputDisabled = serializingAttachments;
  const controlsDisabled = busy || serializingAttachments;
  const queueDraftDisabled = !running ||
    !prompt.trim() ||
    attachments.length > 0 ||
    Boolean(selectedAction || selectedCommand) ||
    serializingAttachments;
  const queueDraftTooltip = attachments.length > 0
    ? "Queue supports text drafts"
    : selectedAction || selectedCommand
      ? "Queue plain text drafts"
      : prompt.trim()
        ? "Queue steer draft"
        : "Type a draft to queue";

  function beginSubmissionForScope(scopeKey = submissionScopeKey): boolean {
    const activeScopes = submittingScopeKeysRef.current;
    if (activeScopes.has(scopeKey)) return false;
    activeScopes.add(scopeKey);
    return true;
  }

  function finishSubmissionForScope(scopeKey: string) {
    submittingScopeKeysRef.current.delete(scopeKey);
  }

  function isSubmittingScope(scopeKey: string): boolean {
    return submittingScopeKeysRef.current.has(scopeKey);
  }

  function isSubmittingCurrentScope(): boolean {
    return isSubmittingScope(submissionScopeKey);
  }

  function clearSerializingAttachmentsForScope(scopeKey: string) {
    setSerializingAttachmentScopeKey((current) => (current === scopeKey ? null : current));
  }
  const providerOptions = useMemo(
    () => {
      const options = providerOptionsFromSettings(providerSettings, { enabledOnly: true })
        .map((option) => ({ ...option, description: undefined }));
      const scopedOptions = workspaceTarget.value === "cloud"
        ? options.filter((option) => option.value === "openpond")
        : options;
      const withCurrent = scopedOptions.some((option) => option.value === provider)
        ? scopedOptions
        : [
            {
              value: provider,
              label: chatProviderLabel(provider, providerSettings),
              description: "Current",
            },
            ...scopedOptions,
          ];
      const setupProviderOption: DropdownOption = {
        value: "setup-provider",
        label: "Setup new provider",
        icon: "plus",
        separatorBefore: true,
      };
      return [
        ...withCurrent,
        setupProviderOption,
      ];
    },
    [provider, providerSettings, workspaceTarget.value],
  );
  const modelOptions = useMemo(
    () => modelOptionsForProvider(provider, providerSettings),
    [provider, providerSettings],
  );
  const mentionContext = useMemo(
    () => activeMentionQuery(prompt, Math.min(cursorIndex, prompt.length)),
    [cursorIndex, prompt],
  );
  const mentionMatches = useMemo<ComposerMentionMenuItem[]>(() => {
    if (!mentionContext) return [];
    const needle = mentionContext.query;
    if (surface === "team") {
      const memberMatches = teamMentionMembers
        .filter((member) => {
          if (!needle) return true;
          return [member.name, member.handle ?? ""]
            .map(normalizeMentionToken)
            .some((token) => token.includes(needle));
        })
        .map((member) => ({ kind: "team-member" as const, member }));
      const teamActionMatches = actionMentionMatchesForQuery(actionCatalog, needle)
        .map((action) => ({ kind: "action" as const, action }));
      return [...memberMatches, ...teamActionMatches].slice(0, 8);
    }
    const appMatches = mentionApps
      .filter((app) => {
        if (!needle) return true;
        const tokens = [
          normalizeMentionToken(app.id),
          normalizeMentionToken(app.name),
          app.gitRepo ? normalizeMentionToken(app.gitRepo) : "",
          mentionTokenForChatApp(app),
        ];
        return tokens.some((token) => token.includes(needle));
      })
      .map((app) => ({ kind: "app" as const, app }));
    const actionMatches = actionMentionMatchesForQuery(actionCatalog, needle)
      .map((action) => ({ kind: "action" as const, action }));
    const connectedAppMatches = connectedAppMentionMatchesForQuery(connectedAppMentions, needle)
      .map((app) => ({ kind: "connected-app" as const, app }));
    return [...appMatches, ...connectedAppMatches, ...actionMatches].slice(0, 8);
  }, [actionCatalog, connectedAppMentions, mentionApps, mentionContext, surface, teamMentionMembers]);
  const showMentionMenu = Boolean(!inputDisabled && mentionContext && mentionMatches.length > 0);
  const activeSkillContext = useMemo(
    () => activeProfileSkillInvocationContext(prompt, Math.min(cursorIndex, prompt.length)),
    [cursorIndex, prompt],
  );
  const activeSkillKey = activeSkillContext
    ? `${prompt}:${activeSkillContext.start}:${activeSkillContext.end}`
    : null;
  const skillMatches = useMemo<ComposerSkillMenuItem[]>(() => {
    return activeSkillContext
      ? profileSkillInvocationMatchesForQuery(profileSkills, activeSkillContext.query)
      : [];
  }, [activeSkillContext, profileSkills]);
  const showSkillMenu = Boolean(
    !inputDisabled &&
    activeSkillContext &&
    activeSkillKey &&
    skillMenuDismissedPrompt !== activeSkillKey,
  );
  const activeSlashContext = useMemo(
    () => activeSlashCommandContext(prompt, Math.min(cursorIndex, prompt.length)),
    [cursorIndex, prompt],
  );
  const activeSlashKey = activeSlashContext
    ? `${prompt}:${activeSlashContext.start}:${activeSlashContext.end}`
    : null;
  const actionMatches = useMemo(() => {
    return activeSlashContext ? slashActionMatchesForQuery(actionCatalog, activeSlashContext.query) : [];
  }, [actionCatalog, activeSlashContext]);
  const appContextMatches = useMemo(() => {
    return activeSlashContext && surface !== "team"
      ? slashAppContextMatchesForQuery(mentionApps, activeSlashContext.query)
      : [];
  }, [activeSlashContext, mentionApps, surface]);
  const commandMatches = useMemo(() => {
    return activeSlashContext && surface !== "team"
      ? slashCommandMatchesForQuery(activeSlashContext.query)
      : [];
  }, [activeSlashContext, surface]);
  const slashMatches = useMemo<SlashMenuItem[]>(
    () => [
      ...commandMatches.map((command) => ({ kind: "command" as const, command })),
      ...appContextMatches.map((app) => ({ kind: "app-context" as const, app })),
      ...actionMatches.map((action) => ({ kind: "action" as const, action })),
    ].slice(0, 10),
    [actionMatches, appContextMatches, commandMatches],
  );
  const showActionMenu = Boolean(
    !inputDisabled &&
    activeSlashContext &&
    activeSlashKey &&
    actionMenuDismissedPrompt !== activeSlashKey,
  );

  const showGoalRuntime = Boolean(goalRuntime && !createPipelineRuntime);
  const activeGoalRuntime = showGoalRuntime && goalRuntime?.tone === "active";
  const stopControlLabel = activeGoalRuntime ? "Pause goal" : "Stop response";
  const stopControlIcon = activeGoalRuntime ? "pause" : "stop";
  const showWorkspaceFooterControls = projectTarget.value !== "none";
  const steerDrafts = composerSteerDraftsForScope(
    steerDraftsByScope,
    submissionScopeKey,
    initialSteerDrafts,
  );
  const sendingSteerDraftId =
    sendingSteerDraft?.scopeKey === submissionScopeKey ? sendingSteerDraft.draftId : null;
  const editingSteerDraft = useMemo(
    () => steerDrafts.find((draft) => draft.id === editingSteerDraftId) ?? null,
    [editingSteerDraftId, steerDrafts],
  );

  function updateSteerDraftsForScope(
    scopeKey: string,
    updateDrafts: (drafts: ComposerSteerDraft[]) => ComposerSteerDraft[],
  ) {
    setSteerDraftsByScope((current) =>
      updateComposerSteerDraftScope(
        current,
        scopeKey,
        updateDrafts,
        scopeKey === submissionScopeKey ? initialSteerDrafts : [],
      )
    );
  }

  useLayoutEffect(() => {
    inputRef.current?.resize();
  }, [attachments.length, attachmentError, createPipelineRuntime, goalRuntime, prompt, selectedActionId, selectedCommandId, selectedInvocationPosition]);

  useEffect(() => {
    if (!autoFocus) {
      autoFocusAppliedRef.current = false;
      return;
    }
    if (autoFocusAppliedRef.current || inputDisabled) return;
    autoFocusAppliedRef.current = true;
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(prompt.length);
    });
  }, [autoFocus, inputDisabled, prompt.length]);

  useEffect(() => {
    if (!focusRequestId || focusRequestAppliedRef.current === focusRequestId || inputDisabled) return;
    focusRequestAppliedRef.current = focusRequestId;
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(prompt.length);
    });
  }, [focusRequestId, inputDisabled, prompt.length]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionContext?.query]);

  useEffect(() => {
    setSkillIndex(0);
  }, [activeSkillContext?.query, skillMatches.length]);

  useEffect(() => {
    setActionIndex(0);
  }, [activeSlashContext?.query, slashMatches.length]);

  useEffect(() => {
    if (!goalRuntime) setGoalDetailsOpen(false);
  }, [goalRuntime]);

  useEffect(() => {
    if (selectedActionId && !actionCatalog.some((action) => action.id === selectedActionId)) {
      setSelectedActionId(null);
      setSelectedInvocationPosition(null);
    }
  }, [actionCatalog, selectedActionId]);

  useEffect(() => {
    if (!selectedAction && !selectedCommand) return;
    setSelectedInvocationPosition((position) => {
      if (position === null) return 0;
      return Math.max(0, Math.min(position, prompt.length));
    });
  }, [prompt.length, selectedAction, selectedCommand]);

  useEffect(() => {
    if (!selectedMentionAppId || !onMentionAppSelect) return;
    const selected = mentionApps.find((app) => app.id === selectedMentionAppId);
    if (!selected || !promptContainsChatAppMention(prompt, selected)) {
      onMentionAppSelect(null);
    }
  }, [mentionApps, onMentionAppSelect, prompt, selectedMentionAppId]);

  useEffect(() => {
    const input = inputRef.current?.element;
    const container = input?.parentElement;
    if (!input || !container || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => inputRef.current?.resize());
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!addMenuOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setAddMenuOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [addMenuOpen]);

  useLayoutEffect(() => {
    if (!showActionMenu) return;
    const input = inputRef.current?.element;
    const composer = composerRef.current;
    if (!input || !composer) return;
    const inputElement = input;
    const composerElement = composer;

    function updateSlashMenuPosition() {
      setActionMenuStyle(slashMenuAnchorStyle(inputElement, composerElement));
    }

    updateSlashMenuPosition();
    window.addEventListener("resize", updateSlashMenuPosition);
    window.addEventListener("scroll", updateSlashMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateSlashMenuPosition);
      window.removeEventListener("scroll", updateSlashMenuPosition, true);
    };
  }, [attachments.length, createPipelineRuntime, goalRuntime, prompt, selectedActionId, showActionMenu]);

  useLayoutEffect(() => {
    if (!showSkillMenu) return;
    const input = inputRef.current?.element;
    const composer = composerRef.current;
    if (!input || !composer) return;
    const inputElement = input;
    const composerElement = composer;

    function updateSkillMenuPosition() {
      setSkillMenuStyle(slashMenuAnchorStyle(inputElement, composerElement));
    }

    updateSkillMenuPosition();
    window.addEventListener("resize", updateSkillMenuPosition);
    window.addEventListener("scroll", updateSkillMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateSkillMenuPosition);
      window.removeEventListener("scroll", updateSkillMenuPosition, true);
    };
  }, [attachments.length, createPipelineRuntime, goalRuntime, prompt, selectedActionId, showSkillMenu]);

  useLayoutEffect(() => {
    if (!showMentionMenu) return;
    const input = inputRef.current?.element;
    const composer = composerRef.current;
    if (!input || !composer) return;
    const inputElement = input;
    const composerElement = composer;

    function updateMentionMenuPosition() {
      setMentionMenuStyle(slashMenuAnchorStyle(inputElement, composerElement));
    }

    updateMentionMenuPosition();
    window.addEventListener("resize", updateMentionMenuPosition);
    window.addEventListener("scroll", updateMentionMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMentionMenuPosition);
      window.removeEventListener("scroll", updateMentionMenuPosition, true);
    };
  }, [attachments.length, createPipelineRuntime, goalRuntime, prompt, selectedActionId, showMentionMenu]);

  function clearSelectedInvocation() {
    setSelectedActionId(null);
    setSelectedCommandId(null);
    setSelectedInvocationPosition(null);
    setSelectedActionMentionText(null);
  }

  function openSubmitIssueDialog(initialDescription: string) {
    setSubmitIssueInitialDescription(initialDescription.trim());
    setSubmitIssueDialogOpen(true);
  }

  function closeSubmitIssueDialog() {
    if (submitIssueSubmitting) return;
    setSubmitIssueDialogOpen(false);
    clearSelectedInvocation();
  }

  function clearComposerPrompt() {
    clearSelectedInvocation();
    onPromptChange("");
    setCursorIndex(0);
  }

  async function stopCurrentTurn() {
    const scopeKey = submissionScopeKey;
    suppressNextAutoDispatchScopeKeysRef.current.add(scopeKey);
    const stopped = await (activeGoalRuntime && onPauseGoal ? onPauseGoal() : onStop());
    if (stopped === false) suppressNextAutoDispatchScopeKeysRef.current.delete(scopeKey);
    return stopped;
  }

  function insertPlanningAppMention(app: OpenPondApp, range?: { end: number; start: number }) {
    const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
    const start = range ? Math.max(0, Math.min(range.start, prompt.length)) : cursor;
    const end = range ? Math.max(start, Math.min(range.end, prompt.length)) : start;
    const before = prompt.slice(0, start);
    const after = prompt.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const nextMention = `${mentionTextForChatApp(app)} `;
    const inserted = `${prefix}${nextMention}${suffix}`;
    const nextPrompt = `${before}${inserted}${after}`;
    const nextCursor = before.length + inserted.length;
    onPromptChange(nextPrompt);
    onMentionAppSelect?.(app.id);
    setCursorIndex(nextCursor);
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(nextCursor);
    });
  }

  function selectMentionApp(app: OpenPondApp) {
    if (!mentionContext) return;
    const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
    insertPlanningAppMention(app, { start: mentionContext.start, end: cursor });
  }

  function selectMentionAction(action: SandboxActionCatalogEntry) {
    if (!mentionContext) return;
    const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
    const start = Math.max(0, Math.min(mentionContext.start, prompt.length));
    const end = Math.max(start, Math.min(cursor, prompt.length));
    const mentionText = prompt.slice(start, end).trim();
    const nextPrompt = `${prompt.slice(0, start)}${prompt.slice(end)}`;
    setSelectedActionId(action.id);
    setSelectedCommandId(null);
    setSelectedInvocationPosition(start);
    setSelectedActionMentionText(mentionText.startsWith("@") ? mentionText : null);
    onPromptChange(nextPrompt);
    setCursorIndex(start);
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(start, { afterToken: true });
    });
  }

  function selectConnectedAppMention(app: ConnectedAppMentionOption) {
    if (!mentionContext) return;
    const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
    const start = Math.max(0, Math.min(mentionContext.start, prompt.length));
    const end = Math.max(start, Math.min(cursor, prompt.length));
    const before = prompt.slice(0, start);
    const after = prompt.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const nextMention = `${connectedAppMentionText(app)} `;
    const inserted = `${prefix}${nextMention}${suffix}`;
    const nextPrompt = `${before}${inserted}${after}`;
    const nextCursor = before.length + inserted.length;
    onPromptChange(nextPrompt);
    setCursorIndex(nextCursor);
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(nextCursor);
    });
  }

  function selectMentionItem(item: ComposerMentionMenuItem) {
    if (item.kind === "team-member") {
      if (!mentionContext) return;
      const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
      const token = item.member.handle || normalizeMentionToken(item.member.name);
      const before = prompt.slice(0, mentionContext.start);
      const after = prompt.slice(cursor);
      const inserted = `@${token} `;
      const nextPrompt = `${before}${inserted}${after}`;
      const nextCursor = before.length + inserted.length;
      onPromptChange(nextPrompt);
      setCursorIndex(nextCursor);
      window.requestAnimationFrame(() => inputRef.current?.focusAtPromptIndex(nextCursor));
      return;
    }
    if (item.kind === "app") {
      selectMentionApp(item.app);
      return;
    }
    if (item.kind === "connected-app") {
      selectConnectedAppMention(item.app);
      return;
    }
    selectMentionAction(item.action);
  }

  function selectSlashPlanningApp(app: OpenPondApp) {
    if (!activeSlashContext) return;
    setActionMenuDismissedPrompt(null);
    insertPlanningAppMention(app, {
      start: activeSlashContext.start,
      end: activeSlashContext.end,
    });
  }

  function selectSlashAction(action: SandboxActionCatalogEntry) {
    if (!activeSlashContext) return;
    const nextPrompt = `${prompt.slice(0, activeSlashContext.start)}${prompt.slice(activeSlashContext.end)}`;
    const nextCursor = activeSlashContext.start;
    setSelectedActionId(action.id);
    setSelectedCommandId(null);
    setSelectedInvocationPosition(nextCursor);
    setSelectedActionMentionText(null);
    setActionMenuDismissedPrompt(null);
    onPromptChange(nextPrompt);
    setCursorIndex(nextCursor);
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(nextCursor, { afterToken: true });
    });
  }

  function selectSlashCommand(command: ComposerSlashCommand) {
    if (!activeSlashContext) return;
    const nextPrompt = `${prompt.slice(0, activeSlashContext.start)}${prompt.slice(activeSlashContext.end)}`;
    const nextCursor = activeSlashContext.start;
    setSelectedCommandId(command.id);
    setSelectedActionId(null);
    setSelectedInvocationPosition(nextCursor);
    setSelectedActionMentionText(null);
    setActionMenuDismissedPrompt(null);
    onPromptChange(nextPrompt);
    setCursorIndex(nextCursor);
    if (command.id === "submit-issue") {
      openSubmitIssueDialog(nextPrompt);
    }
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(nextCursor, { afterToken: true });
    });
  }

  function selectSlashMenuItem(item: SlashMenuItem) {
    if (item.kind === "command") {
      selectSlashCommand(item.command);
      return;
    }
    if (item.kind === "app-context") {
      selectSlashPlanningApp(item.app);
      return;
    }
    selectSlashAction(item.action);
  }

  function selectProfileSkill(item: ComposerSkillMenuItem) {
    if (!activeSkillContext) return;
    const replacement = replaceActiveProfileSkillInvocation(prompt, activeSkillContext, item);
    setSkillMenuDismissedPrompt(null);
    onPromptChange(replacement.value);
    setCursorIndex(replacement.cursor);
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(replacement.cursor);
    });
  }

  function openFilePicker() {
    setAddMenuOpen(false);
    fileInputRef.current?.click();
  }

  function selectCreateAsAgent() {
    setAddMenuOpen(false);
    setSelectedCommandId("create");
    setSelectedActionId(null);
    setSelectedInvocationPosition(0);
    setSelectedActionMentionText(null);
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(0, { afterToken: true });
    });
  }

  function selectPlanningAppFromAddMenu(app: OpenPondApp) {
    setAddMenuOpen(false);
    insertPlanningAppMention(app);
  }

  function queueCurrentSteerDraft() {
    const value = prompt.trim();
    if (!value || queueDraftDisabled) return;
    const scopeKey = submissionScopeKey;
    updateSteerDraftsForScope(scopeKey, (current) => [...current, createComposerSteerDraft(value)]);
    clearComposerPrompt();
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(0);
    });
  }

  async function submitQueuedSteerDraft(draftId: string, source: "auto" | "manual" = "manual"): Promise<boolean> {
    const submissionScope = submissionScopeKey;
    if (isSubmittingScope(submissionScope) || sendingSteerDraft?.scopeKey === submissionScope) return false;
    const draft = composerSteerDraftsForScope(
      steerDraftsByScope,
      submissionScope,
      initialSteerDrafts,
    ).find((candidate) => candidate.id === draftId);
    if (!draft) return false;
    if (!beginSubmissionForScope(submissionScope)) return false;
    setSendingSteerDraft({ draftId, scopeKey: submissionScope });
    setAttachmentError(null);
    try {
      if (running) {
        const stopped = await onStop();
        if (stopped === false) return false;
      }
      const sent = await onSubmit([], null, null, {
        preservePrompt: true,
        promptOverride: draft.prompt,
      });
      if (sent) {
        if (source === "auto") autoDispatchWaitingForStartedTurnScopeKeysRef.current.add(submissionScope);
      }
      updateSteerDraftsForScope(
        submissionScope,
        (current) => composerSteerDraftsAfterSubmit(current, draftId, sent),
      );
      return sent;
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      finishSubmissionForScope(submissionScope);
      setSendingSteerDraft((current) =>
        current?.scopeKey === submissionScope && current.draftId === draftId ? null : current
      );
    }
  }

  function deleteQueuedSteerDraft(draftId: string) {
    if (sendingSteerDraftId === draftId) return;
    if (editingSteerDraftId === draftId) {
      setEditingSteerDraftId(null);
      setEditSteerDraftValue("");
    }
    updateSteerDraftsForScope(submissionScopeKey, (current) => removeComposerSteerDraft(current, draftId));
  }

  function editQueuedSteerDraft(draft: ComposerSteerDraft) {
    const editTarget = composerSteerEditTarget({
      attachmentCount: attachments.length,
      hasSelectedAction: Boolean(selectedActionId),
      hasSelectedCommand: Boolean(selectedCommandId),
      prompt,
    });
    if (editTarget === "load_composer") {
      updateSteerDraftsForScope(submissionScopeKey, (current) => removeComposerSteerDraft(current, draft.id));
      onPromptChange(draft.prompt);
      setCursorIndex(draft.prompt.length);
      window.requestAnimationFrame(() => {
        inputRef.current?.focusAtPromptIndex(draft.prompt.length);
      });
      return;
    }
    setEditingSteerDraftId(draft.id);
    setEditSteerDraftValue(draft.prompt);
  }

  function cancelQueuedSteerEdit() {
    setEditingSteerDraftId(null);
    setEditSteerDraftValue("");
  }

  function saveQueuedSteerEdit() {
    if (!editingSteerDraft || !editSteerDraftValue.trim()) return;
    updateSteerDraftsForScope(submissionScopeKey, (current) =>
      updateComposerSteerDraft(current, editingSteerDraft.id, editSteerDraftValue.trim())
    );
    cancelQueuedSteerEdit();
  }

  function replaceComposerWithQueuedSteerEdit() {
    if (!editingSteerDraft || !editSteerDraftValue.trim()) return;
    const nextPrompt = editSteerDraftValue.trim();
    updateSteerDraftsForScope(submissionScopeKey, (current) =>
      removeComposerSteerDraft(current, editingSteerDraft.id)
    );
    cancelQueuedSteerEdit();
    onPromptChange(nextPrompt);
    setCursorIndex(nextPrompt.length);
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(nextPrompt.length);
    });
  }

  async function submitComposer() {
    if (isSubmittingCurrentScope()) return;
    const parsedSubmitIssuePrompt = selectedAction || selectedCommand
      ? null
      : parseComposerSlashCommandPrompt(prompt);
    if (selectedCommand?.id === "submit-issue" || parsedSubmitIssuePrompt?.command === "submit-issue") {
      openSubmitIssueDialog(
        parsedSubmitIssuePrompt?.command === "submit-issue"
          ? parsedSubmitIssuePrompt.args
          : prompt,
      );
      return;
    }
    if (sendDisabled) return;
    const submissionScope = submissionScopeKey;
    if (!beginSubmissionForScope(submissionScope)) return;
    setAddMenuOpen(false);
    setAttachmentError(null);
    try {
      if (running) {
        const stopped = await onStop();
        if (stopped === false) return;
      }
      const stagedAttachments = stageAttachmentsForSubmit();
      try {
        setSerializingAttachmentScopeKey(stagedAttachments.length > 0 ? submissionScope : null);
        let payloads: ChatAttachment[];
        try {
          payloads = await Promise.all(stagedAttachments.map(readComposerAttachmentPayload));
        } finally {
          clearSerializingAttachmentsForScope(submissionScope);
        }
        const promptOverride =
          selectedAction && selectedDisplayPrompt && !prompt.trim()
            ? selectedDisplayPrompt
            : undefined;
        const sent = await onSubmit(
          payloads,
          selectedAction,
          selectedCommand,
          selectedDisplayPrompt || promptOverride
            ? {
                ...(selectedDisplayPrompt ? { displayPrompt: selectedDisplayPrompt } : {}),
                ...(promptOverride ? { promptOverride } : {}),
              }
            : undefined,
        );
        settleStagedAttachments(stagedAttachments, sent ? "dispose" : "restore");
        if (sent) clearSelectedInvocation();
      } catch (submitError) {
        settleStagedAttachments(stagedAttachments, "restore");
        throw submitError;
      }
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      finishSubmissionForScope(submissionScope);
      clearSerializingAttachmentsForScope(submissionScope);
    }
  }

  async function submitIssueForm(input: SubmitIssueFormInput): Promise<boolean> {
    if (isSubmittingCurrentScope() || submitIssueSubmitting) return false;
    const submissionScope = submissionScopeKey;
    if (!beginSubmissionForScope(submissionScope)) return false;
    setSubmitIssueSubmitting(true);
    setAddMenuOpen(false);
    setAttachmentError(null);
    try {
      if (running) {
        const stopped = await onStop();
        if (stopped === false) return false;
      }
      const sent = await onSubmit([], null, SUBMIT_ISSUE_COMMAND, {
        displayPrompt: `/submit-issue ${input.title.trim()}`,
        promptOverride: formatSubmitIssueFormInput(input),
      });
      if (sent) {
        setSubmitIssueDialogOpen(false);
        clearSelectedInvocation();
      }
      return sent;
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      finishSubmissionForScope(submissionScope);
      setSubmitIssueSubmitting(false);
    }
  }

  useEffect(() => {
    const scopeKey = submissionScopeKey;
    if (running) {
      autoDispatchWaitingForStartedTurnScopeKeysRef.current.delete(scopeKey);
      previousRunningScopeKeysRef.current.add(scopeKey);
      return;
    }
    if (suppressNextAutoDispatchScopeKeysRef.current.has(scopeKey) || steerAutoDispatchBlocked) {
      suppressNextAutoDispatchScopeKeysRef.current.delete(scopeKey);
      previousRunningScopeKeysRef.current.delete(scopeKey);
      return;
    }
    const wasRunning = previousRunningScopeKeysRef.current.has(scopeKey);
    if (wasRunning && !steerAutoDispatchReady) return;
    const shouldDispatch = shouldAutoDispatchComposerSteer({
      autoDispatchReady: steerAutoDispatchReady && !createPipelineRuntime,
      hasQueuedDrafts: steerDrafts.length > 0,
      running,
      sending: Boolean(sendingSteerDraftId) || isSubmittingScope(scopeKey),
      waitingForStartedTurn: autoDispatchWaitingForStartedTurnScopeKeysRef.current.has(scopeKey),
      wasRunning,
    });
    previousRunningScopeKeysRef.current.delete(scopeKey);
    if (!shouldDispatch) return;
    const nextDraft = steerDrafts[0];
    if (!nextDraft) return;
    void submitQueuedSteerDraft(nextDraft.id, "auto");
  }, [
    createPipelineRuntime,
    running,
    sendingSteerDraftId,
    steerAutoDispatchBlocked,
    steerAutoDispatchReady,
    steerDrafts,
    submissionScopeKey,
  ]);

  function insertDictationTranscript(text: string) {
    const cursor = cursorIndex;
    const next = insertVoiceTranscript(prompt, text, cursor);
    onPromptChange(next.value);
    setCursorIndex(next.cursorIndex);
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(next.cursorIndex);
    });
  }

  return (
    <form
      ref={composerRef}
      className={`composer ${mode} ${createPipelineRuntime ? "has-create-runtime" : ""} ${showGoalRuntime ? "has-goal-runtime" : ""} ${steering ? "is-steering" : ""} ${attachments.length > 0 ? "has-attachments" : ""} ${selectedAction || selectedCommand ? "has-selected-action" : ""} ${attachmentError ? "has-attachment-error" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submitComposer();
      }}
    >
      {showMentionMenu && (
        <ComposerMentionMenu
          items={mentionMatches}
          mentionIndex={mentionIndex}
          onSelect={selectMentionItem}
          onSelectIndex={setMentionIndex}
          style={mentionMenuStyle}
        />
      )}
      {showSkillMenu && (
        <ComposerSkillMenu
          items={skillMatches}
          onSelect={selectProfileSkill}
          onSelectIndex={setSkillIndex}
          skillIndex={skillIndex}
          style={skillMenuStyle}
        />
      )}
      {showActionMenu && (
        <ComposerSlashMenu
          actionCatalogCount={actionCatalog.length}
          actionIndex={actionIndex}
          items={slashMatches}
          onSelect={selectSlashMenuItem}
          onSelectIndex={setActionIndex}
          style={actionMenuStyle}
        />
      )}
      <SubmitIssueDialog
        busy={submitIssueSubmitting}
        initialDescription={submitIssueInitialDescription}
        open={submitIssueDialogOpen}
        onClose={closeSubmitIssueDialog}
        onSubmit={submitIssueForm}
      />
      {createPipelineRuntime && (
        <ComposerCreatePipelineStrip runtime={createPipelineRuntime} />
      )}
      <ComposerSteerQueue
        drafts={steerDrafts}
        editDraftValue={editSteerDraftValue}
        editingDraft={editingSteerDraft}
        sendingDraftId={sendingSteerDraftId}
        onCancelEdit={cancelQueuedSteerEdit}
        onDeleteDraft={deleteQueuedSteerDraft}
        onEditDraft={editQueuedSteerDraft}
        onEditDraftValueChange={setEditSteerDraftValue}
        onReplaceComposerDraft={replaceComposerWithQueuedSteerEdit}
        onSaveQueuedDraft={saveQueuedSteerEdit}
        onSteerDraft={(draftId) => {
          void submitQueuedSteerDraft(draftId);
        }}
      />
      {showGoalRuntime && goalRuntime && (
        <ComposerGoalStrip
          detailsOpen={goalDetailsOpen}
          goalRuntime={goalRuntime}
          objectiveId={goalDetailsId}
          subagentRuntime={subagentRuntime}
          onToggleDetails={() => setGoalDetailsOpen((open) => !open)}
        />
      )}
      {composeNotice && (
        <div className={`composer-notice ${composeNotice.tone}`} role="status">
          {composeNotice.message}
        </div>
      )}
      <div className="composer-input-shell">
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="Selected attachments">
            {attachments.map((attachment) => (
              <ComposerAttachmentPreview
                attachment={attachment}
                key={attachment.id}
                onRemove={() => removeAttachment(attachment.id)}
              />
            ))}
          </div>
        )}
        {attachmentError && (
          <div className="composer-attachment-error" role="status">
            {attachmentError}
          </div>
        )}
        <div
          className="composer-textarea-frame"
          onClick={(event) => {
            if (event.target === event.currentTarget) inputRef.current?.focusAtPromptIndex(cursorIndex);
          }}
        >
          <ComposerInlineInput
            ref={inputRef}
            connectedAppMentions={connectedAppMentions}
            disabled={inputDisabled}
            onCursorChange={setCursorIndex}
            onKeyDown={(event) => {
              if (showMentionMenu) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionIndex((current) => (current + 1) % mentionMatches.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionIndex((current) => (current - 1 + mentionMatches.length) % mentionMatches.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  selectMentionItem(mentionMatches[mentionIndex] ?? mentionMatches[0]!);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCursorIndex(-1);
                  return;
                }
              }
              if (showSkillMenu) {
                if (skillMatches.length > 0 && event.key === "ArrowDown") {
                  event.preventDefault();
                  setSkillIndex((current) => (current + 1) % skillMatches.length);
                  return;
                }
                if (skillMatches.length > 0 && event.key === "ArrowUp") {
                  event.preventDefault();
                  setSkillIndex((current) => (current - 1 + skillMatches.length) % skillMatches.length);
                  return;
                }
                if (skillMatches.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
                  event.preventDefault();
                  selectProfileSkill(skillMatches[skillIndex] ?? skillMatches[0]!);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSkillMenuDismissedPrompt(activeSkillKey ?? prompt);
                  return;
                }
              }
              if (showActionMenu) {
                if (slashMatches.length > 0 && event.key === "ArrowDown") {
                  event.preventDefault();
                  setActionIndex((current) => (current + 1) % slashMatches.length);
                  return;
                }
                if (slashMatches.length > 0 && event.key === "ArrowUp") {
                  event.preventDefault();
                  setActionIndex((current) => (current - 1 + slashMatches.length) % slashMatches.length);
                  return;
                }
                if (slashMatches.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
                  event.preventDefault();
                  selectSlashMenuItem(slashMatches[actionIndex] ?? slashMatches[0]!);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setActionMenuDismissedPrompt(activeSlashKey ?? prompt);
                  return;
                }
              }
              if (
                (selectedAction || selectedCommand) &&
                event.key === "Backspace" &&
                cursorIndex === (selectedInvocationPosition ?? 0)
              ) {
                event.preventDefault();
                clearSelectedInvocation();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (hasComposerInput && !serializingAttachments) void submitComposer();
              }
            }}
            onPromptChange={(nextValue, nextPromptCursor) => {
              const completedCommand =
                surface === "team"
                  ? null
                  : completedTypedSlashCommand(nextValue, nextPromptCursor);
              if (completedCommand) {
                const nextPrompt = `${nextValue.slice(0, completedCommand.start)}${nextValue.slice(completedCommand.end)}`;
                const nextCursor = completedCommand.start;
                onPromptChange(nextValue);
                setCursorIndex(nextPromptCursor);
                window.requestAnimationFrame(() => {
                  setSelectedCommandId(completedCommand.command.id);
                  setSelectedActionId(null);
                  setSelectedInvocationPosition(nextCursor);
                  setActionMenuDismissedPrompt(null);
                  onPromptChange(nextPrompt);
                  setCursorIndex(nextCursor);
                  if (completedCommand.command.id === "submit-issue") {
                    openSubmitIssueDialog(nextPrompt);
                  }
                  window.requestAnimationFrame(() => {
                    inputRef.current?.focusAtPromptIndex(nextCursor, { afterToken: true });
                  });
                });
                return;
              }
              onPromptChange(nextValue);
            }}
            onTokenPositionChange={(position) => {
              if (!selectedAction && !selectedCommand) return;
              if (position === null) {
                clearSelectedInvocation();
                return;
              }
              setSelectedInvocationPosition(position);
            }}
            placeholder={placeholder}
            prompt={prompt}
            token={selectedInvocationToken}
          />
        </div>
        <ComposerPrimaryControls
          surface={surface}
          teamUseModel={teamUseModel}
          teamUseModelLocked={teamUseModelLocked}
          onTeamUseModelChange={onTeamUseModelChange}
          addFiles={addFiles}
          addMenuOpen={addMenuOpen}
          addMenuRef={addMenuRef}
          busy={busy}
          codexPermissionMode={codexPermissionMode}
          codexReasoningEffort={codexReasoningEffort}
          connection={connection}
          contextStatusStyle={contextStatusStyle}
          contextStatusTooltipId={contextStatusTooltipId}
          contextWindowStatus={contextWindowStatus}
          disabled={controlsDisabled}
          dropdownPlacement={dropdownPlacement}
          fileInputRef={fileInputRef}
          mentionApps={mentionApps}
          modelValue={modelValue}
          modelOptions={modelOptions}
          openPondCommandAccessMode={openPondCommandAccessMode}
          onCodexPermissionModeChange={onCodexPermissionModeChange}
          onCodexReasoningEffortChange={onCodexReasoningEffortChange}
          onOpenPondCommandAccessModeChange={onOpenPondCommandAccessModeChange}
          onModelChange={onModelChange}
          onOpenFilePicker={openFilePicker}
          onCreateAsAgent={selectCreateAsAgent}
          onPlanningAppSelect={selectPlanningAppFromAddMenu}
          onProviderChange={onProviderChange}
          onProviderSetupOpen={onProviderSetupOpen}
          onQueueDraft={queueCurrentSteerDraft}
          onStop={stopCurrentTurn}
          onToggleAddMenu={() => setAddMenuOpen((open) => !open)}
          onTranscript={insertDictationTranscript}
          provider={provider}
          providerSettings={providerSettings}
          providerOptions={providerOptions}
          queueDraftDisabled={queueDraftDisabled}
          queueDraftTooltip={queueDraftTooltip}
          running={running && !hasComposerInput}
          sendDisabled={sendDisabled}
          sendTooltip={sendTooltip}
          selectedMentionAppId={selectedMentionAppId}
          subagentDelegationDefaultMode={subagentDelegationDefaultMode}
          subagentDelegationMode={subagentDelegationMode}
          onSubagentDelegationModeChange={onSubagentDelegationModeChange}
          showToast={showToast}
          stopIcon={stopControlIcon}
          stopLabel={stopControlLabel}
          steering={steering}
        />
      </div>
      {showProjectFooter && (
        <div className="composer-footer">
          <ComposerProjectTargetControl
            busy={busy || projectTarget.busy}
            placement={dropdownPlacement}
            state={projectTarget}
            onChange={onProjectTargetChange}
          />
          {showWorkspaceFooterControls ? (
            <WorkspaceActionControl
              busy={busy}
              placement={dropdownPlacement}
              state={workspaceTarget}
              onChange={onWorkspaceTargetChange}
            />
          ) : null}
        </div>
      )}
    </form>
  );
}
