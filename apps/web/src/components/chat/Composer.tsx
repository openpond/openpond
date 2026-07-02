import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  ChatAttachment,
  ChatProvider,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondApp,
  ProviderSettings,
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
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import type { WorkspaceLocation, WorkspaceTargetState } from "../../lib/workspace-location";
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
  composerActionCatalogLabel,
} from "../../lib/composer-action-catalog";
import {
  COMPOSER_SLASH_COMMANDS,
  type ComposerSlashCommand,
} from "../../lib/composer-slash-commands";
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
import { slashMenuAnchorStyle } from "./ComposerLayout";
import {
  ComposerInlineInput,
  type ComposerInlineInputHandle,
  type ComposerInlineToken,
} from "./ComposerInlineInput";
import { ComposerMentionMenu, type ComposerMentionMenuItem } from "./ComposerMentionMenu";
import { ComposerPrimaryControls } from "./ComposerPrimaryControls";
import { ComposerSlashMenu, type SlashMenuItem } from "./ComposerSlashMenu";
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

type ComposerProps = {
  mode: "dock" | "start";
  prompt: string;
  composeNotice?: ComposerNotice | null;
  mentionApps?: OpenPondApp[];
  selectedMentionAppId?: string | null;
  contextWindowStatus: ContextWindowStatus;
  goalRuntime?: GoalRuntimeStatus | null;
  createPipelineRuntime?: ComposerCreatePipelineRuntime | null;
  busy: boolean;
  running?: boolean;
  showProjectFooter?: boolean;
  connection: ClientConnection | null;
  providerSettings?: ProviderSettings | null;
  provider: ChatProvider;
  model: string;
  projectTarget: ComposerProjectTargetState;
  actionCatalog?: SandboxActionCatalogEntry[];
  workspaceTarget: WorkspaceTargetState;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  onProviderChange: (value: ChatProvider) => void;
  onProviderSetupOpen?: () => void;
  onProjectTargetChange: (value: string) => void;
  onWorkspaceTargetChange: (value: WorkspaceLocation) => void;
  onModelChange: (value: string) => void;
  onCodexPermissionModeChange: (value: CodexPermissionMode) => void;
  onCodexReasoningEffortChange: (value: CodexReasoningEffort) => void;
  onPromptChange: (value: string) => void;
  onMentionAppSelect?: (appId: string | null) => void;
  onOpenGoalDetails?: () => void;
  showToast: ShowAppToast;
  onSubmit: (
    attachments?: ChatAttachment[],
    action?: SandboxActionCatalogEntry | null,
    command?: ComposerSlashCommand | null,
    options?: ComposerSubmitOptions,
  ) => Promise<boolean>;
  onStop: () => Promise<boolean | void> | boolean | void;
};

export type ComposerSubmitOptions = {
  displayPrompt?: string;
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
  return COMPOSER_SLASH_COMMANDS
    .filter((command) => {
      if (!query) return true;
      return [
        command.id,
        command.command,
        command.label,
        command.description,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .slice(0, 8);
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

export function Composer({
  mode,
  prompt,
  composeNotice = null,
  mentionApps = [],
  selectedMentionAppId = null,
  contextWindowStatus,
  goalRuntime = null,
  createPipelineRuntime = null,
  busy,
  running = busy,
  showProjectFooter = true,
  connection,
  providerSettings = null,
  provider,
  model,
  projectTarget,
  actionCatalog = [],
  workspaceTarget,
  codexPermissionMode,
  codexReasoningEffort,
  onProviderChange,
  onProviderSetupOpen,
  onProjectTargetChange,
  onWorkspaceTargetChange,
  onModelChange,
  onCodexPermissionModeChange,
  onCodexReasoningEffortChange,
  onPromptChange,
  onMentionAppSelect,
  onOpenGoalDetails,
  showToast,
  onSubmit,
  onStop,
}: ComposerProps) {
  const composerRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<ComposerInlineInputHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const submittingRef = useRef(false);
  const [cursorIndex, setCursorIndex] = useState(prompt.length);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [actionIndex, setActionIndex] = useState(0);
  const [actionMenuDismissedPrompt, setActionMenuDismissedPrompt] = useState<string | null>(null);
  const [mentionMenuStyle, setMentionMenuStyle] = useState<CSSProperties>({});
  const [actionMenuStyle, setActionMenuStyle] = useState<CSSProperties>({});
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [selectedCommandId, setSelectedCommandId] = useState<ComposerSlashCommand["id"] | null>(null);
  const [selectedInvocationPosition, setSelectedInvocationPosition] = useState<number | null>(null);
  const [selectedActionMentionText, setSelectedActionMentionText] = useState<string | null>(null);
  const [serializingAttachments, setSerializingAttachments] = useState(false);
  const [goalDetailsOpen, setGoalDetailsOpen] = useState(false);
  const {
    attachmentError,
    attachments,
    addFiles,
    removeAttachment,
    settleStagedAttachments,
    setAttachmentError,
    stageAttachmentsForSubmit,
  } = useComposerAttachments();
  const placeholder = mode === "start" ? "Ask Openpond Anything" : "Ask for follow-up changes";
  const modelValue = normalizeChatModel(provider, model, providerSettings);
  const dropdownPlacement = mode === "dock" ? "top" : "bottom";
  const contextStatusTooltipId = useId();
  const goalDetailsId = useId();
  const contextStatusStyle = {
    "--context-fill": `${Math.round(((contextWindowStatus.percent ?? 0) / 100) * 360)}deg`,
    "--context-bar-fill": `${contextWindowStatus.percent ?? 0}%`,
  } as CSSProperties;
  const hasComposerInput = Boolean(prompt.trim() || attachments.length > 0);
  const selectedAction = useMemo(
    () => actionCatalog.find((action) => action.id === selectedActionId) ?? null,
    [actionCatalog, selectedActionId],
  );
  const selectedCommand = useMemo(
    () => COMPOSER_SLASH_COMMANDS.find((command) => command.id === selectedCommandId) ?? null,
    [selectedCommandId],
  );
  const selectedInvocationToken = useMemo<ComposerInlineToken | null>(() => {
    const position = Math.max(0, Math.min(selectedInvocationPosition ?? 0, prompt.length));
    if (selectedCommand) {
      return {
        icon: selectedCommand.id === "create" ? "plus" : "workflow",
        key: `command:${selectedCommand.id}`,
        label: selectedCommand.id,
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
  const sendDisabled = serializingAttachments || !hasComposerInput;
  const sendTooltip = serializingAttachments ? "Preparing files" : running ? "Interrupt and send" : "Send";
  const inputDisabled = serializingAttachments;
  const controlsDisabled = busy || serializingAttachments;
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
    return [...appMatches, ...actionMatches].slice(0, 8);
  }, [actionCatalog, mentionApps, mentionContext]);
  const showMentionMenu = Boolean(!inputDisabled && mentionContext && mentionMatches.length > 0);
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
    return activeSlashContext ? slashAppContextMatchesForQuery(mentionApps, activeSlashContext.query) : [];
  }, [activeSlashContext, mentionApps]);
  const commandMatches = useMemo(() => {
    return activeSlashContext ? slashCommandMatchesForQuery(activeSlashContext.query) : [];
  }, [activeSlashContext]);
  const slashMatches = useMemo<SlashMenuItem[]>(
    () => [
      ...commandMatches.map((command) => ({ kind: "command" as const, command })),
      ...appContextMatches.map((app) => ({ kind: "app-context" as const, app })),
      ...actionMatches.map((action) => ({ kind: "action" as const, action })),
    ].slice(0, 8),
    [actionMatches, appContextMatches, commandMatches],
  );
  const showActionMenu = Boolean(
    !inputDisabled &&
    activeSlashContext &&
    activeSlashKey &&
    actionMenuDismissedPrompt !== activeSlashKey,
  );

  const showGoalRuntime = Boolean(goalRuntime && !createPipelineRuntime);

  useLayoutEffect(() => {
    inputRef.current?.resize();
  }, [attachments.length, attachmentError, createPipelineRuntime, goalRuntime, prompt, selectedActionId, selectedCommandId, selectedInvocationPosition]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionContext?.query]);

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

  function selectMentionItem(item: ComposerMentionMenuItem) {
    if (item.kind === "app") {
      selectMentionApp(item.app);
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

  async function submitComposer() {
    if (submittingRef.current || sendDisabled) return;
    submittingRef.current = true;
    setAddMenuOpen(false);
    setAttachmentError(null);
    setSerializingAttachments(true);
    try {
      if (running) {
        const stopped = await onStop();
        if (stopped === false) return;
      }
      const stagedAttachments = stageAttachmentsForSubmit();
      try {
        const payloads = await Promise.all(stagedAttachments.map(readComposerAttachmentPayload));
        const displayPrompt =
          selectedAction && selectedActionMentionText
            ? promptWithSelectedInvocationText(prompt, selectedActionMentionText, selectedInvocationPosition)
            : null;
        const sent = await onSubmit(
          payloads,
          selectedAction,
          selectedCommand,
          displayPrompt ? { displayPrompt } : undefined,
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
      submittingRef.current = false;
      setSerializingAttachments(false);
    }
  }

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
      className={`composer ${mode} ${createPipelineRuntime ? "has-create-runtime" : ""} ${showGoalRuntime ? "has-goal-runtime" : ""} ${attachments.length > 0 ? "has-attachments" : ""} ${selectedAction || selectedCommand ? "has-selected-action" : ""} ${attachmentError ? "has-attachment-error" : ""}`}
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
      {createPipelineRuntime && (
        <ComposerCreatePipelineStrip runtime={createPipelineRuntime} />
      )}
      {showGoalRuntime && goalRuntime && (
        <ComposerGoalStrip
          detailsOpen={goalDetailsOpen}
          goalRuntime={goalRuntime}
          objectiveId={goalDetailsId}
          onOpenDetails={onOpenGoalDetails}
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
              const completedCommand = completedTypedSlashCommand(nextValue, nextPromptCursor);
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
          onCodexPermissionModeChange={onCodexPermissionModeChange}
          onCodexReasoningEffortChange={onCodexReasoningEffortChange}
          onModelChange={onModelChange}
          onOpenFilePicker={openFilePicker}
          onCreateAsAgent={selectCreateAsAgent}
          onPlanningAppSelect={selectPlanningAppFromAddMenu}
          onProviderChange={onProviderChange}
          onProviderSetupOpen={onProviderSetupOpen}
          onStop={onStop}
          onToggleAddMenu={() => setAddMenuOpen((open) => !open)}
          onTranscript={insertDictationTranscript}
          provider={provider}
          providerOptions={providerOptions}
          running={running && !hasComposerInput}
          sendDisabled={sendDisabled}
          sendTooltip={sendTooltip}
          selectedMentionAppId={selectedMentionAppId}
          showToast={showToast}
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
          <WorkspaceActionControl
            busy={busy || workspaceTarget.busy}
            state={workspaceTarget}
            onChange={onWorkspaceTargetChange}
          />
        </div>
      )}
    </form>
  );
}
