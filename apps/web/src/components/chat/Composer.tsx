import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  CHAT_ATTACHMENT_LIMITS,
  type ChatAttachment,
  type OpenPondApp,
  type TeamChatMember,
} from "@openpond/contracts";
import {
  chatProviderLabel,
  modelOptionsForProvider,
  normalizeChatModel,
  providerOptionsFromSettings,
  type DropdownOption,
} from "../../lib/app-models";
import type { SandboxActionCatalogEntry } from "../../lib/sandbox-types";
import {
  activeMentionQuery,
  mentionTextForChatApp,
  normalizeMentionToken,
  promptContainsChatAppMention,
} from "../../lib/chat-app-mentions";
import {
  connectedAppMentionText,
  type ConnectedAppMentionOption,
} from "../../lib/connected-app-mentions";
import { composerActionCatalogLabel } from "../../lib/composer-action-catalog";
import { shouldRetainOpenPondProfileActionAfterSubmit } from "../../lib/openpond-action-run";
import {
  COMPOSER_SLASH_COMMANDS,
  composerSlashCommandsForExperience,
  parseComposerSlashCommandPrompt,
  type ComposerSlashCommand,
} from "../../lib/composer-slash-commands";
import {
  formatSubmitIssueFormInput,
  type SubmitIssueFormInput,
} from "../../lib/submit-issue-command";
import {
  activeProfileSkillInvocationContext,
  profileSkillInvocationMatchesForQuery,
  replaceActiveProfileSkillInvocation,
} from "../../lib/profile-skill-invocations";
import { insertVoiceTranscript } from "../../lib/voice-text";
import {
  ComposerPinnedWorkspaceContext,
  ComposerProjectTargetControl,
  ComposerProfileTargetControl,
  WorkspaceActionControl,
} from "./ComposerControls";
import { ComposerGoalStrip } from "./ComposerGoalStrip";
import {
  ComposerInlineInput,
  type ComposerInlineInputHandle,
  type ComposerInlineToken,
} from "./ComposerInlineInput";
import { composerPlaceholder, composerTaskDraftShortcut, saveComposerTaskDraft } from "./composer-task-draft";
import {
  ComposerCommandMenu,
  filterComposerCommandMenuSections,
  type ComposerCommandMenuItem,
  type ComposerCommandMenuSection,
} from "./ComposerCommandMenu";
import {
  ComposerMentionMenu,
  type ComposerMentionMenuItem,
} from "./ComposerMentionMenu";
import { ComposerPrimaryControls } from "./ComposerPrimaryControls";
import {
  ComposerSkillMenu,
  type ComposerSkillMenuItem,
} from "./ComposerSkillMenu";
import { ComposerSlashMenu, type SlashMenuItem } from "./ComposerSlashMenu";
import { SubmitIssueDialog } from "./SubmitIssueDialog";
import {
  ComposerAttachmentPreview,
  createComposerPastedTextFile,
  readComposerAttachmentPayload,
} from "./ComposerAttachments";
import { useComposerAttachments } from "./useComposerAttachments";
import {
  activeSlashCommandContext,
  completedTypedSlashCommand,
  hasComposerSubmittableInput,
  mentionMenuMatchesForQuery,
  selectedActionDisplayPrompt,
  slashActionMatchesForQuery,
  slashAppContextMatchesForQuery,
  slashCommandMatchesForQuery,
} from "./composer-input-helpers";
import type { ComposerProps } from "./composer-types";
import { DEVELOPMENT_ONLY_PROFILE_SKILLS } from "./composer-profile-skills";
import { useComposerMenuInteractions } from "./useComposerMenuInteractions";

export {
  hasComposerSubmittableInput,
  humanizeSelectedActionInput,
  promptWithSelectedInvocationText,
  selectedActionDisplayPrompt,
} from "./composer-input-helpers";

const ComposerCreateImproveStrip = lazy(() =>
  import("./ComposerCreateImproveStrip").then((module) => ({
    default: module.ComposerCreateImproveStrip,
  }))
);

export type {
  ComposerProjectTargetOption,
  ComposerProjectTargetOptionKind,
  ComposerProjectTargetState,
} from "./ComposerControls";
export type {
  ComposerNotice,
  ComposerProps,
  ComposerSubmitOptions,
} from "./composer-types";

const SUBMIT_ISSUE_COMMAND = COMPOSER_SLASH_COMMANDS.find(
  (command) => command.id === "submit-issue"
) as ComposerSlashCommand;

export function Composer({
  experience = "development",
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
  createImproveRuntime = null,
  busy,
  running = busy,
  submissionScopeKey = "default",
  showProjectFooter = true,
  autoFocus = false,
  focusRequestId = 0,
  attachmentRequest = null,
  connection,
  providerSettings = null,
  provider,
  model,
  projectTarget,
  profileTarget = null,
  actionCatalog = [],
  requestedAction = null,
  workspaceTarget,
  codexPermissionMode,
  codexReasoningEffort,
  openPondCommandAccessMode,
  onProviderChange,
  onProviderSetupOpen,
  onProjectTargetChange,
  onProfileTargetChange,
  onWorkspaceTargetChange,
  onModelChange,
  onCodexPermissionModeChange,
  onCodexReasoningEffortChange,
  onOpenPondCommandAccessModeChange,
  onPromptChange,
  onMentionAppSelect,
  onSaveTaskDraft,
  showToast,
  onSubmit,
  onStop,
  onPauseGoal,
}: ComposerProps) {
  const composerRef = useRef<HTMLFormElement | null>(null);
  const inputShellRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<ComposerInlineInputHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const addMenuPanelRef = useRef<HTMLDivElement | null>(null);
  const addMenuQueryStartRef = useRef(0);
  const initialRequestedAction =
    requestedAction &&
    actionCatalog.some((action) => action.id === requestedAction.actionId)
      ? requestedAction
      : null;
  const autoFocusAppliedRef = useRef(false);
  const focusRequestAppliedRef = useRef(0);
  const requestedActionAppliedRef = useRef(
    initialRequestedAction?.requestId ?? 0
  );
  const submittingScopeKeysRef = useRef<Set<string>>(new Set());
  const [cursorIndex, setCursorIndex] = useState(prompt.length);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [skillIndex, setSkillIndex] = useState(0);
  const [actionIndex, setActionIndex] = useState(0);
  const [addMenuIndex, setAddMenuIndex] = useState(0);
  const [addMenuQuery, setAddMenuQuery] = useState("");
  const [mentionMenuDismissedPrompt, setMentionMenuDismissedPrompt] = useState<
    string | null
  >(null);
  const [actionMenuDismissedPrompt, setActionMenuDismissedPrompt] = useState<
    string | null
  >(null);
  const [skillMenuDismissedPrompt, setSkillMenuDismissedPrompt] = useState<
    string | null
  >(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [savingTaskDraft, setSavingTaskDraft] = useState(false);
  const [selectedActionId, setSelectedActionId] = useState<string | null>(
    initialRequestedAction?.actionId ?? null
  );
  const [selectedCommandId, setSelectedCommandId] = useState<
    ComposerSlashCommand["id"] | null
  >(null);
  const [selectedInvocationPosition, setSelectedInvocationPosition] = useState<
    number | null
  >(null);
  const [selectedActionMentionText, setSelectedActionMentionText] = useState<
    string | null
  >(null);
  const [serializingAttachmentScopeKey, setSerializingAttachmentScopeKey] =
    useState<string | null>(null);
  const [goalDetailsOpen, setGoalDetailsOpen] = useState(false);
  const [submitIssueDialogOpen, setSubmitIssueDialogOpen] = useState(false);
  const [submitIssueInitialDescription, setSubmitIssueInitialDescription] =
    useState("");
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
  const attachmentRequestAppliedRef = useRef(0);
  useEffect(() => {
    if (
      !attachmentRequest ||
      attachmentRequestAppliedRef.current === attachmentRequest.id
    )
      return;
    attachmentRequestAppliedRef.current = attachmentRequest.id;
    addFiles([attachmentRequest.file]);
  }, [addFiles, attachmentRequest]);
  const handlePasteTextAsAttachment = useCallback(
    (text: string) => {
      const file = createComposerPastedTextFile(text, attachments);
      if (!file) return false;
      if (
        attachments.length >= CHAT_ATTACHMENT_LIMITS.maxAttachments ||
        file.size > CHAT_ATTACHMENT_LIMITS.maxAttachmentBytes
      ) {
        return false;
      }
      addFiles([file]);
      return true;
    },
    [addFiles, attachments],
  );
  const placeholder = composerPlaceholder({ experience, mode, surface });
  const repositoryWork = experience === "development"
    || (experience === "work" && projectTarget.value !== "none");
  const modelValue = normalizeChatModel(provider, model, providerSettings);
  // Composer controls sit against the lower edge of the input surface. Opening
  // upward keeps provider/model/permission menus inside the viewport instead
  // of letting them run below the window on the start experience.
  const dropdownPlacement = "top" as const;
  const addMenuId = useId();
  const contextStatusTooltipId = useId();
  const goalDetailsId = useId();
  const contextStatusStyle = {
    "--context-fill": `${Math.round(
      ((contextWindowStatus.percent ?? 0) / 100) * 360
    )}deg`,
    "--context-bar-fill": `${contextWindowStatus.percent ?? 0}%`,
  } as CSSProperties;
  const selectedAction = useMemo(
    () =>
      actionCatalog.find((action) => action.id === selectedActionId) ?? null,
    [actionCatalog, selectedActionId]
  );
  const availableSlashCommands = useMemo(() => {
    return composerSlashCommandsForExperience(provider, experience);
  }, [experience, provider]);
  const availableProfileSkills = useMemo(
    () =>
      repositoryWork
        ? profileSkills
        : profileSkills.filter(
            (skill) => !DEVELOPMENT_ONLY_PROFILE_SKILLS.has(skill.name)
          ),
    [experience, profileSkills]
  );
  const selectedCommand = useMemo(
    () =>
      availableSlashCommands.find(
        (command) => command.id === selectedCommandId
      ) ?? null,
    [availableSlashCommands, selectedCommandId]
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
    const position = Math.max(
      0,
      Math.min(selectedInvocationPosition ?? 0, prompt.length)
    );
    if (selectedCommand) {
      return {
        icon:
          selectedCommand.id === "agent"
            ? "plus"
            : selectedCommand.id === "skill"
            ? "skill"
            : "workflow",
        key: `command:${selectedCommand.id}`,
        label:
          selectedCommand.id === "agent" ? "Author Agent" : selectedCommand.id,
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
        icon:
          selectedAction.implementation?.type === "openpond-agent"
            ? "bot"
            : "workflow",
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
  }, [
    prompt.length,
    selectedAction,
    selectedCommand,
    selectedInvocationPosition,
  ]);
  const serializingAttachments =
    serializingAttachmentScopeKey === submissionScopeKey;
  const steering = running && hasComposerInput;
  const sendDisabled = serializingAttachments || !hasComposerInput;
  const sendTooltip = serializingAttachments
    ? "Preparing files"
    : steering
    ? "Steer"
    : "Send";
  const inputDisabled = serializingAttachments;
  const controlsDisabled = serializingAttachments;

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
    setSerializingAttachmentScopeKey((current) =>
      current === scopeKey ? null : current
    );
  }
  const providerOptions = useMemo(() => {
    const options = providerOptionsFromSettings(providerSettings, {
      enabledOnly: true,
    }).map((option) => ({ ...option, description: undefined }));
    const experienceOptions =
      repositoryWork
        ? options
        : options.filter((option) => option.value !== "codex");
    const scopedOptions =
      workspaceTarget.value === "cloud" && repositoryWork
        ? experienceOptions.filter((option) => option.value === "openpond")
        : experienceOptions;
    const withCurrent = scopedOptions.some(
      (option) => option.value === provider
    )
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
      label: "New Model/Provider",
      icon: "plus",
      separatorBefore: true,
    };
    return [...withCurrent, setupProviderOption];
  }, [provider, providerSettings, repositoryWork, workspaceTarget.value]);
  const modelOptions = useMemo(
    () => modelOptionsForProvider(provider, providerSettings),
    [provider, providerSettings]
  );
  const mentionContext = useMemo(
    () => activeMentionQuery(prompt, Math.min(cursorIndex, prompt.length)),
    [cursorIndex, prompt]
  );
  const activeMentionKey = mentionContext
    ? `${prompt}:${mentionContext.start}:${Math.min(
        cursorIndex,
        prompt.length
      )}`
    : null;
  const mentionMatches = useMemo<ComposerMentionMenuItem[]>(() => {
    if (!mentionContext) return [];
    return mentionMenuMatchesForQuery({
      actionCatalog,
      connectedAppMentions,
      mentionApps,
      profileSkills: availableProfileSkills,
      query: mentionContext.query,
      surface,
      teamMentionMembers,
    });
  }, [
    actionCatalog,
    connectedAppMentions,
    mentionApps,
    mentionContext,
    availableProfileSkills,
    surface,
    teamMentionMembers,
  ]);
  const addMenuMentionItems = useMemo<ComposerMentionMenuItem[]>(() => {
    return surface === "team"
      ? []
      : mentionMenuMatchesForQuery({
          actionCatalog,
          connectedAppMentions,
          mentionApps,
          profileSkills: availableProfileSkills,
          query: "",
          surface,
          teamMentionMembers,
        }).filter((item) => item.kind !== "skill");
  }, [
    actionCatalog,
    connectedAppMentions,
    mentionApps,
    availableProfileSkills,
    surface,
    teamMentionMembers,
  ]);
  const showMentionMenu = Boolean(
    !addMenuOpen &&
      !inputDisabled &&
      mentionContext &&
      activeMentionKey &&
      mentionMenuDismissedPrompt !== activeMentionKey &&
      mentionMatches.length > 0
  );
  const activeSkillContext = useMemo(
    () =>
      activeProfileSkillInvocationContext(
        prompt,
        Math.min(cursorIndex, prompt.length)
      ),
    [cursorIndex, prompt]
  );
  const activeSkillKey = activeSkillContext
    ? `${prompt}:${activeSkillContext.start}:${activeSkillContext.end}`
    : null;
  const skillMatches = useMemo<ComposerSkillMenuItem[]>(() => {
    return activeSkillContext
      ? profileSkillInvocationMatchesForQuery(
          availableProfileSkills,
          activeSkillContext.query
        )
      : [];
  }, [activeSkillContext, availableProfileSkills]);
  const showSkillMenu = Boolean(
    !addMenuOpen &&
      !inputDisabled &&
      activeSkillContext &&
      activeSkillKey &&
      skillMenuDismissedPrompt !== activeSkillKey
  );
  const activeSlashContext = useMemo(
    () =>
      activeSlashCommandContext(prompt, Math.min(cursorIndex, prompt.length)),
    [cursorIndex, prompt]
  );
  const activeSlashKey = activeSlashContext
    ? `${prompt}:${activeSlashContext.start}:${activeSlashContext.end}`
    : null;
  const actionMatches = useMemo(() => {
    return activeSlashContext
      ? slashActionMatchesForQuery(actionCatalog, activeSlashContext.query)
      : [];
  }, [actionCatalog, activeSlashContext]);
  const appContextMatches = useMemo(() => {
    return activeSlashContext && surface !== "team"
      ? slashAppContextMatchesForQuery(mentionApps, activeSlashContext.query)
      : [];
  }, [activeSlashContext, mentionApps, surface]);
  const commandMatches = useMemo(() => {
    return activeSlashContext && surface !== "team"
      ? slashCommandMatchesForQuery(
          activeSlashContext.query,
          availableSlashCommands
        )
      : [];
  }, [activeSlashContext, availableSlashCommands, surface]);
  const slashSkillMatches = useMemo(() => {
    return activeSlashContext && surface !== "team"
      ? profileSkillInvocationMatchesForQuery(
          availableProfileSkills,
          activeSlashContext.query
        )
      : [];
  }, [activeSlashContext, availableProfileSkills, surface]);
  const slashMatches = useMemo<SlashMenuItem[]>(
    () => [
      ...actionMatches.map((action) => ({ kind: "action" as const, action })),
      ...slashSkillMatches.map((skill) => ({ kind: "skill" as const, skill })),
      ...commandMatches.map((command) => ({
        kind: "command" as const,
        command,
      })),
      ...appContextMatches.map((app) => ({
        kind: "app-context" as const,
        app,
      })),
    ],
    [actionMatches, appContextMatches, commandMatches, slashSkillMatches]
  );
  const showActionMenu = Boolean(
    !addMenuOpen &&
      !inputDisabled &&
      activeSlashContext &&
      activeSlashKey &&
      actionMenuDismissedPrompt !== activeSlashKey
  );
  const addMenuOpenPondItems = useMemo<SlashMenuItem[]>(
    () =>
      availableSlashCommands.map((command) => ({
        kind: "command" as const,
        command,
      })),
    [availableSlashCommands]
  );
  const addMenuSlashItems = useMemo<SlashMenuItem[]>(
    () => [
      ...slashActionMatchesForQuery(actionCatalog, "").map((action) => ({
        kind: "action" as const,
        action,
      })),
      ...slashAppContextMatchesForQuery(mentionApps, "").map((app) => ({
        kind: "app-context" as const,
        app,
      })),
    ],
    [actionCatalog, mentionApps]
  );
  const addMenuSkillItems = useMemo<SlashMenuItem[]>(
    () =>
      profileSkillInvocationMatchesForQuery(availableProfileSkills, "").map(
        (skill) => ({
          kind: "skill" as const,
          skill,
        })
      ),
    [availableProfileSkills]
  );
  const addMenuSections = useMemo<ComposerCommandMenuSection[]>(() => {
    const sections: ComposerCommandMenuSection[] = [
      {
        id: "add",
        items:
          experience === "work"
            ? [{ kind: "files" }, { kind: "folder" }]
            : [{ kind: "files" }],
        label: "Add",
      },
    ];
    if (addMenuSlashItems.length > 0) {
      sections.push({
        id: "slash",
        items: addMenuSlashItems.map((item) => ({ kind: "slash", item })),
        label: "Agents and actions",
        queryScope: "slash",
      });
    }
    if (addMenuSkillItems.length > 0) {
      sections.push({
        id: "skills",
        items: addMenuSkillItems.map((item) => ({ kind: "slash", item })),
        label: "Skills",
        queryScopes: ["slash", "mentions"],
      });
    }
    sections.push({
      id: "openpond",
      items: addMenuOpenPondItems.map((item) => ({ kind: "slash", item })),
      label: "OpenPond",
      grid: true,
      queryScope: "slash",
    });
    sections.push({
      emptyLabel: "No mentions available",
      id: "mentions",
      items: addMenuMentionItems.map((item) => ({ kind: "mention", item })),
      label: "@",
    });
    return sections;
  }, [
    addMenuMentionItems,
    addMenuOpenPondItems,
    addMenuSkillItems,
    addMenuSlashItems,
    experience,
  ]);
  const filteredAddMenuSections = useMemo(
    () => filterComposerCommandMenuSections(addMenuSections, addMenuQuery),
    [addMenuQuery, addMenuSections]
  );
  const addMenuItems = useMemo(
    () => filteredAddMenuSections.flatMap((section) => section.items),
    [filteredAddMenuSections]
  );
  useEffect(() => {
    if (!addMenuOpen) return;
    setAddMenuIndex((current) => (current < addMenuItems.length ? current : 0));
  }, [addMenuItems.length, addMenuOpen]);

  const showGoalRuntime = Boolean(goalRuntime);
  const activeGoalRuntime = showGoalRuntime && goalRuntime?.tone === "active";
  const stopControlLabel = activeGoalRuntime ? "Pause goal" : "Stop response";
  const stopControlIcon = activeGoalRuntime ? "pause" : "stop";
  const showWorkspaceFooterControls = experience === "work" || projectTarget.value !== "none";

  useLayoutEffect(() => {
    inputRef.current?.resize();
  }, [
    attachments.length,
    attachmentError,
    createImproveRuntime,
    goalRuntime,
    prompt,
    selectedActionId,
    selectedCommandId,
    selectedInvocationPosition,
  ]);

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
    if (
      !focusRequestId ||
      focusRequestAppliedRef.current === focusRequestId ||
      inputDisabled
    )
      return;
    focusRequestAppliedRef.current = focusRequestId;
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(prompt.length);
    });
  }, [focusRequestId, inputDisabled, prompt.length]);

  useEffect(() => {
    if (!goalRuntime) setGoalDetailsOpen(false);
  }, [goalRuntime]);

  useEffect(() => {
    if (
      selectedActionId &&
      !actionCatalog.some((action) => action.id === selectedActionId)
    ) {
      setSelectedActionId(null);
      setSelectedInvocationPosition(null);
    }
  }, [actionCatalog, selectedActionId]);

  useEffect(() => {
    if (
      !requestedAction ||
      requestedAction.requestId <= requestedActionAppliedRef.current
    )
      return;
    const action = actionCatalog.find(
      (candidate) => candidate.id === requestedAction.actionId
    );
    if (!action) return;
    requestedActionAppliedRef.current = requestedAction.requestId;
    setSelectedActionId(action.id);
    setSelectedCommandId(null);
    setSelectedInvocationPosition(0);
    setSelectedActionMentionText(null);
    onPromptChange("");
    setCursorIndex(0);
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(0, { afterToken: true });
    });
  }, [actionCatalog, onPromptChange, requestedAction]);

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

  const { actionMenuStyle, addMenuStyle, mentionMenuStyle, skillMenuStyle } =
    useComposerMenuInteractions({
      activeMentionKey,
      activeSkillKey,
      activeSlashKey,
      addMenuIndex,
      addMenuItems,
      addMenuOpen,
      addMenuPanelRef,
      addMenuRef,
      attachmentCount: attachments.length,
      composerRef,
      createImproveActive: Boolean(createImproveRuntime),
      goalRuntimeActive: Boolean(goalRuntime),
      inputRef,
      inputShellRef,
      mentionQuery: mentionContext?.query,
      prompt,
      selectedActionId,
      selectAddMenuItem,
      setActionIndex,
      setActionMenuDismissedPrompt,
      setAddMenuIndex,
      setAddMenuOpen,
      setAddMenuQuery,
      setMentionMenuDismissedPrompt,
      setMentionIndex,
      setSkillIndex,
      setSkillMenuDismissedPrompt,
      skillMatchCount: skillMatches.length,
      skillQuery: activeSkillContext?.query,
      slashMatchCount: slashMatches.length,
      slashQuery: activeSlashContext?.query,
      showActionMenu,
      showMentionMenu,
      showSkillMenu,
    });
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

  async function stopCurrentTurn() {
    return await (activeGoalRuntime && onPauseGoal
      ? onPauseGoal()
      : onStop());
  }

  function insertPlanningAppMention(
    app: OpenPondApp,
    range?: { end: number; start: number }
  ) {
    const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
    const start = range
      ? Math.max(0, Math.min(range.start, prompt.length))
      : cursor;
    const end = range
      ? Math.max(start, Math.min(range.end, prompt.length))
      : start;
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
    return nextCursor;
  }

  function selectMentionApp(app: OpenPondApp) {
    if (!mentionContext) return;
    const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
    insertPlanningAppMention(app, { start: mentionContext.start, end: cursor });
  }

  function insertSelectedAction(
    action: SandboxActionCatalogEntry,
    range?: { end: number; start: number },
    selectedMentionText: string | null = null
  ) {
    const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
    const start = range
      ? Math.max(0, Math.min(range.start, prompt.length))
      : cursor;
    const end = range
      ? Math.max(start, Math.min(range.end, prompt.length))
      : start;
    const nextPrompt = `${prompt.slice(0, start)}${prompt.slice(end)}`;
    setSelectedActionId(action.id);
    setSelectedCommandId(null);
    setSelectedInvocationPosition(start);
    setSelectedActionMentionText(
      selectedMentionText?.startsWith("@") ? selectedMentionText : null
    );
    setActionMenuDismissedPrompt(null);
    onPromptChange(nextPrompt);
    setCursorIndex(start);
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(start, { afterToken: true });
    });
    return start;
  }

  function selectMentionAction(action: SandboxActionCatalogEntry) {
    if (!mentionContext) return;
    const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
    const start = Math.max(0, Math.min(mentionContext.start, prompt.length));
    const end = Math.max(start, Math.min(cursor, prompt.length));
    insertSelectedAction(
      action,
      { start, end },
      prompt.slice(start, end).trim()
    );
  }

  function insertConnectedAppMention(
    app: ConnectedAppMentionOption,
    range?: { end: number; start: number }
  ) {
    const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
    const start = range
      ? Math.max(0, Math.min(range.start, prompt.length))
      : cursor;
    const end = range
      ? Math.max(start, Math.min(range.end, prompt.length))
      : start;
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
    return nextCursor;
  }

  function selectConnectedAppMention(app: ConnectedAppMentionOption) {
    if (!mentionContext) return;
    const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
    insertConnectedAppMention(app, {
      start: mentionContext.start,
      end: cursor,
    });
  }

  function insertTeamMemberMention(
    member: TeamChatMember,
    range?: { end: number; start: number }
  ) {
    const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
    const start = range
      ? Math.max(0, Math.min(range.start, prompt.length))
      : cursor;
    const end = range
      ? Math.max(start, Math.min(range.end, prompt.length))
      : start;
    const token = member.handle || normalizeMentionToken(member.name);
    const before = prompt.slice(0, start);
    const after = prompt.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const inserted = `${prefix}@${token} ${suffix}`;
    const nextPrompt = `${before}${inserted}${after}`;
    const nextCursor = before.length + inserted.length;
    onPromptChange(nextPrompt);
    setCursorIndex(nextCursor);
    window.requestAnimationFrame(() =>
      inputRef.current?.focusAtPromptIndex(nextCursor)
    );
    return nextCursor;
  }

  function selectMentionItem(item: ComposerMentionMenuItem) {
    if (item.kind === "team-member") {
      if (!mentionContext) return;
      const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
      insertTeamMemberMention(item.member, {
        start: mentionContext.start,
        end: cursor,
      });
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
    if (item.kind === "skill") {
      if (!mentionContext) return;
      const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
      insertProfileSkill(item.skill, {
        start: mentionContext.start,
        end: cursor,
      });
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
    insertSelectedAction(action, activeSlashContext);
  }

  function insertSlashCommand(
    command: ComposerSlashCommand,
    range?: { end: number; start: number }
  ) {
    const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
    const start = range
      ? Math.max(0, Math.min(range.start, prompt.length))
      : cursor;
    const end = range
      ? Math.max(start, Math.min(range.end, prompt.length))
      : start;
    const nextPrompt = `${prompt.slice(0, start)}${prompt.slice(end)}`;
    setSelectedCommandId(command.id);
    setSelectedActionId(null);
    setSelectedInvocationPosition(start);
    setSelectedActionMentionText(null);
    setActionMenuDismissedPrompt(null);
    onPromptChange(nextPrompt);
    setCursorIndex(start);
    if (command.id === "submit-issue") {
      openSubmitIssueDialog(nextPrompt);
    }
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(start, { afterToken: true });
    });
    return start;
  }

  function selectSlashCommand(command: ComposerSlashCommand) {
    if (!activeSlashContext) return;
    insertSlashCommand(command, activeSlashContext);
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
    if (item.kind === "skill") {
      if (!activeSlashContext) return;
      insertProfileSkill(item.skill, activeSlashContext);
      return;
    }
    selectSlashAction(item.action);
  }

  function insertProfileSkill(
    item: ComposerSkillMenuItem,
    range: { end: number; start: number }
  ) {
    const replacement = replaceActiveProfileSkillInvocation(
      prompt,
      range,
      item
    );
    setSkillMenuDismissedPrompt(null);
    setMentionMenuDismissedPrompt(null);
    setActionMenuDismissedPrompt(null);
    onPromptChange(replacement.value);
    setCursorIndex(replacement.cursor);
    window.requestAnimationFrame(() => {
      inputRef.current?.focusAtPromptIndex(replacement.cursor);
    });
    return replacement.cursor;
  }

  function selectProfileSkill(item: ComposerSkillMenuItem) {
    if (!activeSkillContext) return;
    insertProfileSkill(item, activeSkillContext);
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function openFolderPicker() {
    folderInputRef.current?.click();
  }

  function resetAddMenuQuery(cursor: number) {
    addMenuQueryStartRef.current = cursor;
    setAddMenuQuery("");
    setAddMenuIndex(0);
  }

  function addMenuSelectionRange(): { end: number; start: number } {
    const cursor = Math.max(0, Math.min(cursorIndex, prompt.length));
    const queryStart = Math.max(
      0,
      Math.min(addMenuQueryStartRef.current, prompt.length)
    );
    return cursor >= queryStart
      ? { start: queryStart, end: cursor }
      : { start: cursor, end: cursor };
  }

  function selectAddMenuItem(item: ComposerCommandMenuItem) {
    const range = addMenuSelectionRange();
    setAddMenuOpen(false);
    setAddMenuQuery("");
    if (item.kind === "files" || item.kind === "folder") {
      if (range.start !== range.end) {
        const nextPrompt = `${prompt.slice(0, range.start)}${prompt.slice(
          range.end
        )}`;
        onPromptChange(nextPrompt);
        setCursorIndex(range.start);
      }
      resetAddMenuQuery(range.start);
      if (item.kind === "folder") openFolderPicker();
      else openFilePicker();
      return;
    }
    if (item.kind === "slash") {
      if (item.item.kind === "command") {
        resetAddMenuQuery(insertSlashCommand(item.item.command, range));
        return;
      }
      if (item.item.kind === "app-context") {
        resetAddMenuQuery(insertPlanningAppMention(item.item.app, range));
        return;
      }
      if (item.item.kind === "skill") {
        resetAddMenuQuery(insertProfileSkill(item.item.skill, range));
        return;
      }
      resetAddMenuQuery(insertSelectedAction(item.item.action, range));
      return;
    }
    if (item.item.kind === "team-member") {
      resetAddMenuQuery(insertTeamMemberMention(item.item.member, range));
      return;
    }
    if (item.item.kind === "app") {
      resetAddMenuQuery(insertPlanningAppMention(item.item.app, range));
      return;
    }
    if (item.item.kind === "connected-app") {
      resetAddMenuQuery(insertConnectedAppMention(item.item.app, range));
      return;
    }
    if (item.item.kind === "skill") {
      resetAddMenuQuery(insertProfileSkill(item.item.skill, range));
      return;
    }
    resetAddMenuQuery(insertSelectedAction(item.item.action, range));
  }

  async function submitComposer() {
    if (isSubmittingCurrentScope()) return;
    const parsedSubmitIssuePrompt =
      selectedAction || selectedCommand
        ? null
        : parseComposerSlashCommandPrompt(prompt);
    if (
      selectedCommand?.id === "submit-issue" ||
      parsedSubmitIssuePrompt?.command === "submit-issue"
    ) {
      openSubmitIssueDialog(
        parsedSubmitIssuePrompt?.command === "submit-issue"
          ? parsedSubmitIssuePrompt.args
          : prompt
      );
      return;
    }
    if (sendDisabled) return;
    const submissionScope = submissionScopeKey;
    if (!beginSubmissionForScope(submissionScope)) return;
    const steeringSubmission = running;
    setAddMenuOpen(false);
    setAttachmentError(null);
    try {
      if (running) {
        const stopped = await onStop();
        if (stopped === false) return;
      }
      const stagedAttachments = stageAttachmentsForSubmit();
      try {
        setSerializingAttachmentScopeKey(
          stagedAttachments.length > 0 ? submissionScope : null
        );
        let payloads: ChatAttachment[];
        try {
          payloads = await Promise.all(
            stagedAttachments.map(readComposerAttachmentPayload)
          );
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
          selectedDisplayPrompt || promptOverride || steeringSubmission
            ? {
                ...(selectedDisplayPrompt
                  ? { displayPrompt: selectedDisplayPrompt }
                  : {}),
                ...(promptOverride ? { promptOverride } : {}),
                ...(steeringSubmission
                  ? { turnMetadata: { interactionKind: "steer" } }
                  : {}),
              }
            : undefined
        );
        settleStagedAttachments(
          stagedAttachments,
          sent ? "dispose" : "restore"
        );
        if (
          sent &&
          !shouldRetainOpenPondProfileActionAfterSubmit(selectedAction)
        ) {
          clearSelectedInvocation();
        }
      } catch (submitError) {
        settleStagedAttachments(stagedAttachments, "restore");
        throw submitError;
      }
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      finishSubmissionForScope(submissionScope);
      clearSerializingAttachmentsForScope(submissionScope);
    }
  }

  async function submitIssueForm(
    input: SubmitIssueFormInput
  ): Promise<boolean> {
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
      setAttachmentError(
        error instanceof Error ? error.message : String(error)
      );
      return false;
    } finally {
      finishSubmissionForScope(submissionScope);
      setSubmitIssueSubmitting(false);
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
      className={`composer ${mode} ${
        createImproveRuntime ? "has-create-runtime" : ""
      } ${showGoalRuntime ? "has-goal-runtime" : ""} ${
        steering ? "is-steering" : ""
      } ${attachments.length > 0 ? "has-attachments" : ""} ${
        selectedAction || selectedCommand ? "has-selected-action" : ""
      } ${attachmentError ? "has-attachment-error" : ""} ${
        addMenuOpen ? "has-add-menu" : ""
      }`}
      onSubmit={(event) => {
        event.preventDefault();
        void submitComposer();
      }}
    >
      <input
        {...({ webkitdirectory: "" } as Record<string, string>)}
        ref={folderInputRef}
        className="composer-file-input"
        type="file"
        multiple
        tabIndex={-1}
        onChange={(event) => {
          addFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
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
      {showProjectFooter && (
        <div className="composer-footer">
          {showProjectFooter ? (
            <ComposerProjectTargetControl
              busy={busy || projectTarget.busy}
              placement={dropdownPlacement}
              state={projectTarget}
              onChange={onProjectTargetChange}
            />
          ) : null}
          {profileTarget && onProfileTargetChange ? (
            <ComposerProfileTargetControl
              busy={busy}
              placement={dropdownPlacement}
              state={profileTarget}
              onChange={onProfileTargetChange}
            />
          ) : null}
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
      {!showProjectFooter && experience === "work" && <ComposerPinnedWorkspaceContext project={projectTarget} workspace={workspaceTarget} />}
      {createImproveRuntime ? (
        <Suspense fallback={null}>
          <ComposerCreateImproveStrip runtime={createImproveRuntime} />
        </Suspense>
      ) : null}
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
      <div className="composer-input-shell" ref={inputShellRef}>
        {steering ? (
          <div className="composer-steer-context" aria-hidden="true">
            Steer active response
          </div>
        ) : null}
        {addMenuOpen && surface !== "team" && (
          <ComposerCommandMenu
            id={addMenuId}
            ariaLabel="Add to message"
            className="composer-add-command-menu"
            menuIndex={addMenuIndex}
            menuRef={addMenuPanelRef}
            sections={filteredAddMenuSections}
            style={addMenuStyle}
            variant="add"
            onSelect={selectAddMenuItem}
            onSelectIndex={setAddMenuIndex}
          />
        )}
        {attachments.length > 0 && (
          <div
            className="composer-attachments"
            aria-label="Selected attachments"
          >
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
            if (event.target === event.currentTarget)
              inputRef.current?.focusAtPromptIndex(cursorIndex);
          }}
        >
          <ComposerInlineInput
            ref={inputRef}
            connectedAppMentions={connectedAppMentions}
            disabled={inputDisabled}
            onCursorChange={setCursorIndex}
            onKeyDown={(event) => {
              if (
                addMenuOpen &&
                [
                  "ArrowDown",
                  "ArrowUp",
                  "Home",
                  "End",
                  "Enter",
                  "Escape",
                ].includes(event.key)
              ) {
                event.preventDefault();
                return;
              }
              if (showMentionMenu) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionIndex(
                    (current) => (current + 1) % mentionMatches.length
                  );
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionIndex(
                    (current) =>
                      (current - 1 + mentionMatches.length) %
                      mentionMatches.length
                  );
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  selectMentionItem(
                    mentionMatches[mentionIndex] ?? mentionMatches[0]!
                  );
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setMentionMenuDismissedPrompt(activeMentionKey);
                  return;
                }
              }
              if (showSkillMenu) {
                if (skillMatches.length > 0 && event.key === "ArrowDown") {
                  event.preventDefault();
                  setSkillIndex(
                    (current) => (current + 1) % skillMatches.length
                  );
                  return;
                }
                if (skillMatches.length > 0 && event.key === "ArrowUp") {
                  event.preventDefault();
                  setSkillIndex(
                    (current) =>
                      (current - 1 + skillMatches.length) % skillMatches.length
                  );
                  return;
                }
                if (
                  skillMatches.length > 0 &&
                  (event.key === "Enter" || event.key === "Tab")
                ) {
                  event.preventDefault();
                  selectProfileSkill(
                    skillMatches[skillIndex] ?? skillMatches[0]!
                  );
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
                  setActionIndex(
                    (current) => (current + 1) % slashMatches.length
                  );
                  return;
                }
                if (slashMatches.length > 0 && event.key === "ArrowUp") {
                  event.preventDefault();
                  setActionIndex(
                    (current) =>
                      (current - 1 + slashMatches.length) % slashMatches.length
                  );
                  return;
                }
                if (
                  slashMatches.length > 0 &&
                  (event.key === "Enter" || event.key === "Tab")
                ) {
                  event.preventDefault();
                  selectSlashMenuItem(
                    slashMatches[actionIndex] ?? slashMatches[0]!
                  );
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
              if (composerTaskDraftShortcut(event.key, event.shiftKey, experience, surface, Boolean(onSaveTaskDraft))) {
                event.preventDefault();
                saveComposerTaskDraft({
                  attachmentsCount: attachments.length,
                  hasSelectedInvocation: Boolean(selectedAction || selectedCommand),
                  onSave: onSaveTaskDraft!,
                  onSaved: clearSelectedInvocation,
                  prompt,
                  saving: savingTaskDraft,
                  setSaving: setSavingTaskDraft,
                  showInfo: (message) => showToast(message, "info"),
                });
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (hasComposerInput && !serializingAttachments)
                  void submitComposer();
              }
            }}
            onPasteFiles={addFiles}
            onPasteTextAsAttachment={handlePasteTextAsAttachment}
            onPromptChange={(nextValue, nextPromptCursor) => {
              if (addMenuOpen) {
                const queryStart = Math.max(
                  0,
                  Math.min(addMenuQueryStartRef.current, nextValue.length)
                );
                if (nextPromptCursor < queryStart) {
                  addMenuQueryStartRef.current = nextPromptCursor;
                  setAddMenuQuery("");
                } else {
                  setAddMenuQuery(
                    nextValue.slice(queryStart, nextPromptCursor)
                  );
                }
              }
              const completedCommand =
                surface === "team"
                  ? null
                  : completedTypedSlashCommand(
                      nextValue,
                      nextPromptCursor,
                      availableSlashCommands
                    );
              if (completedCommand) {
                const nextPrompt = `${nextValue.slice(
                  0,
                  completedCommand.start
                )}${nextValue.slice(completedCommand.end)}`;
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
                    inputRef.current?.focusAtPromptIndex(nextCursor, {
                      afterToken: true,
                    });
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
          addMenuId={addMenuId}
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
          modelValue={modelValue}
          modelOptions={modelOptions}
          openPondCommandAccessMode={openPondCommandAccessMode}
          showCommandAccess={repositoryWork}
          profileTarget={showProjectFooter ? null : profileTarget}
          onCodexPermissionModeChange={onCodexPermissionModeChange}
          onCodexReasoningEffortChange={onCodexReasoningEffortChange}
          onOpenPondCommandAccessModeChange={onOpenPondCommandAccessModeChange}
          onProfileTargetChange={onProfileTargetChange}
          onModelChange={onModelChange}
          onOpenFilePicker={openFilePicker}
          onProviderChange={onProviderChange}
          onProviderSetupOpen={onProviderSetupOpen}
          onStop={stopCurrentTurn}
          onToggleAddMenu={() => {
            const nextCursor = Math.max(
              0,
              Math.min(cursorIndex, prompt.length)
            );
            if (!addMenuOpen) {
              addMenuQueryStartRef.current = nextCursor;
              setAddMenuQuery("");
              setAddMenuIndex(0);
              setAddMenuOpen(true);
            }
            window.requestAnimationFrame(() => {
              inputRef.current?.focusAtPromptIndex(nextCursor);
            });
          }}
          onTranscript={insertDictationTranscript}
          provider={provider}
          providerSettings={providerSettings}
          providerOptions={providerOptions}
          running={running && !hasComposerInput}
          sendDisabled={sendDisabled}
          sendTooltip={sendTooltip}
          showToast={showToast}
          stopIcon={stopControlIcon}
          stopLabel={stopControlLabel}
          steering={steering}
        />
      </div>
    </form>
  );
}
