import type { Dispatch, SetStateAction } from "react";
import type {
  ChatProvider,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenPondCommandAccessMode,
} from "@openpond/contracts";
import {
  DEFAULT_CHAT_PROVIDER,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
  DEFAULT_OPENPOND_CHAT_MODEL,
} from "@openpond/contracts";
import type { CommitNextStep } from "../components/workspace/WorkspaceGitDialogs";
import { SIDEBAR_SECTION_LIMIT, type AppView, type SettingsSection } from "../lib/app-models";

export type AppToast = {
  id: number;
  message: string;
  tone: "success" | "error" | "info";
  actionLabel?: string;
  onAction?: () => void;
  persistent?: boolean;
};

export type ShowAppToast = (
  message: string,
  tone?: AppToast["tone"],
  options?: Pick<AppToast, "actionLabel" | "onAction" | "persistent">,
) => void;

export type SidebarSectionMenuId = "cloud" | "projects" | "projects-options" | "chats";

export type NewProjectMode = "local" | "cloud" | "existing-local";
export type RightPanelMode = "changes" | "browser" | "goal" | "chat";
export type RightChatPanel = {
  id: string;
  sessionId: string | null;
  prompt: string;
  provider: ChatProvider;
  model: string;
};

export type AppState = {
  query: string;
  searchOpen: boolean;
  archivedChatsOpen: boolean;
  sectionMenuOpen: SidebarSectionMenuId | null;
  projectsExpanded: boolean;
  cloudProjectsExpanded: boolean;
  chatRowsVisibleCount: number;
  sidebarOpen: boolean;
  view: AppView;
  selectedAppId: string | null;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  prompt: string;
  promptDrafts: Record<string, string>;
  draftProvider: ChatProvider;
  draftModel: string;
  codexPermissionMode: CodexPermissionMode;
  codexReasoningEffort: CodexReasoningEffort;
  openPondCommandAccessMode: OpenPondCommandAccessMode;
  busy: boolean;
  diffPanelOpen: boolean;
  diffPanelExpanded: boolean;
  rightPanelMode: RightPanelMode;
  rightChatPanels: RightChatPanel[];
  terminalOpen: boolean;
  syncingWorkspaceAppId: string | null;
  settingsSection: SettingsSection;
  newProjectDialogOpen: boolean;
  newProjectMode: NewProjectMode;
  newProjectName: string;
  newProjectPath: string;
  newProjectBusy: boolean;
  commitDialogOpen: boolean;
  commitMessage: string;
  commitIncludeUnstaged: boolean;
  commitNextStep: CommitNextStep;
  commitDraft: boolean;
  branchDialogOpen: boolean;
  branchDialogName: string;
  toast: AppToast | null;
  error: string | null;
};

export const initialAppState: AppState = {
  query: "",
  searchOpen: false,
  archivedChatsOpen: false,
  sectionMenuOpen: null,
  projectsExpanded: false,
  cloudProjectsExpanded: false,
  chatRowsVisibleCount: SIDEBAR_SECTION_LIMIT,
  sidebarOpen: true,
  view: "chat",
  selectedAppId: null,
  selectedProjectId: null,
  selectedSessionId: null,
  prompt: "",
  promptDrafts: {},
  draftProvider: DEFAULT_CHAT_PROVIDER,
  draftModel: DEFAULT_OPENPOND_CHAT_MODEL,
  codexPermissionMode: DEFAULT_CODEX_PERMISSION_MODE,
  codexReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
  openPondCommandAccessMode: DEFAULT_OPENPOND_COMMAND_ACCESS_MODE,
  busy: false,
  diffPanelOpen: false,
  diffPanelExpanded: false,
  rightPanelMode: "changes",
  rightChatPanels: [],
  terminalOpen: false,
  syncingWorkspaceAppId: null,
  settingsSection: "account",
  newProjectDialogOpen: false,
  newProjectMode: "local",
  newProjectName: "",
  newProjectPath: "",
  newProjectBusy: false,
  commitDialogOpen: false,
  commitMessage: "",
  commitIncludeUnstaged: true,
  commitNextStep: "commit",
  commitDraft: true,
  branchDialogOpen: false,
  branchDialogName: "",
  toast: null,
  error: null,
};

type FieldAction = {
  [Key in keyof AppState]: {
    type: "field";
    key: Key;
    value: SetStateAction<AppState[Key]>;
  };
}[keyof AppState];

export type AppAction =
  | FieldAction
  | { type: "patch"; patch: Partial<AppState> }
  | { type: "selectApp"; appId: string | null }
  | { type: "selectProject"; projectId: string | null }
  | { type: "selectSession"; sessionId: string | null; appId?: string | null; projectId?: string | null }
  | { type: "beginNewChat"; appId: string | null }
  | { type: "openCommitDialog"; nextStep: CommitNextStep }
  | { type: "openBranchDialog"; branchName: string }
  | { type: "showToast"; toast: AppToast }
  | { type: "clearToast"; toastId: number };

type PromptSelectionState = Pick<AppState, "selectedAppId" | "selectedProjectId" | "selectedSessionId">;

function promptDraftKey(selection: PromptSelectionState): string {
  if (selection.selectedSessionId) return `session:${selection.selectedSessionId}`;
  if (selection.selectedProjectId) return `project:${selection.selectedProjectId}`;
  if (selection.selectedAppId) return `app:${selection.selectedAppId}`;
  return "new-chat";
}

function setPromptDraft(
  drafts: Record<string, string>,
  key: string,
  prompt: string,
): Record<string, string> {
  if (!prompt) {
    if (!(key in drafts)) return drafts;
    const { [key]: _removed, ...rest } = drafts;
    return rest;
  }
  return drafts[key] === prompt ? drafts : { ...drafts, [key]: prompt };
}

function saveCurrentPromptDraft(state: AppState): Record<string, string> {
  return setPromptDraft(state.promptDrafts, promptDraftKey(state), state.prompt);
}

function selectPromptDraft(
  state: AppState,
  patch: Partial<AppState>,
  options: { clearSelectedDraft?: boolean } = {},
): AppState {
  const selected = { ...state, ...patch };
  const selectedKey = promptDraftKey(selected);
  const savedDrafts = saveCurrentPromptDraft(state);
  const promptDrafts = options.clearSelectedDraft
    ? setPromptDraft(savedDrafts, selectedKey, "")
    : savedDrafts;
  return {
    ...state,
    ...patch,
    promptDrafts,
    prompt: options.clearSelectedDraft ? "" : (promptDrafts[selectedKey] ?? ""),
  };
}

function isPromptSelectionKey(key: keyof AppState): key is "selectedAppId" | "selectedProjectId" | "selectedSessionId" {
  return key === "selectedAppId" || key === "selectedProjectId" || key === "selectedSessionId";
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "field":
      {
        const current = state[action.key] as never;
        const nextValue =
          typeof action.value === "function"
            ? (action.value as (current: never) => unknown)(current)
            : action.value;
        if (Object.is(current, nextValue)) return state;
        if (action.key === "prompt") {
          const prompt = String(nextValue);
          return {
            ...state,
            prompt,
            promptDrafts: setPromptDraft(state.promptDrafts, promptDraftKey(state), prompt),
          };
        }
        if (isPromptSelectionKey(action.key)) {
          return selectPromptDraft(state, { [action.key]: nextValue } as Partial<AppState>);
        }
        return {
          ...state,
          [action.key]: nextValue,
        };
      }
    case "patch":
      return { ...state, ...action.patch };
    case "selectApp":
      return selectPromptDraft(state, {
        selectedAppId: action.appId,
        selectedProjectId: null,
        selectedSessionId: null,
        view: "chat",
      });
    case "selectProject":
      return selectPromptDraft(state, {
        selectedAppId: null,
        selectedProjectId: action.projectId,
        selectedSessionId: null,
        view: "chat",
      });
    case "selectSession":
      {
        const projectId = action.projectId ?? null;
        return selectPromptDraft(state, {
          selectedSessionId: action.sessionId,
          selectedAppId: projectId ? null : (action.appId ?? null),
          selectedProjectId: projectId,
          view: "chat",
        });
      }
    case "beginNewChat":
      return selectPromptDraft(state, {
        selectedSessionId: null,
        selectedAppId: action.appId,
        selectedProjectId: null,
        error: null,
        view: "chat",
      }, { clearSelectedDraft: true });
    case "openCommitDialog":
      return {
        ...state,
        commitMessage: "",
        commitIncludeUnstaged: true,
        commitNextStep: action.nextStep,
        commitDraft: true,
        commitDialogOpen: true,
        error: null,
        view: "chat",
      };
    case "openBranchDialog":
      return {
        ...state,
        branchDialogName: action.branchName,
        branchDialogOpen: true,
        error: null,
        view: "chat",
      };
    case "showToast":
      return { ...state, toast: action.toast };
    case "clearToast":
      return state.toast?.id === action.toastId ? { ...state, toast: null } : state;
    default:
      return state;
  }
}

type FieldSetter<Key extends keyof AppState> = Dispatch<SetStateAction<AppState[Key]>>;

function fieldSetter<Key extends keyof AppState>(dispatch: Dispatch<AppAction>, key: Key): FieldSetter<Key> {
  return (value) => dispatch({ type: "field", key, value } as AppAction);
}

export function createAppSetters(dispatch: Dispatch<AppAction>) {
  return {
    setQuery: fieldSetter(dispatch, "query"),
    setSearchOpen: fieldSetter(dispatch, "searchOpen"),
    setArchivedChatsOpen: fieldSetter(dispatch, "archivedChatsOpen"),
    setSectionMenuOpen: fieldSetter(dispatch, "sectionMenuOpen"),
    setProjectsExpanded: fieldSetter(dispatch, "projectsExpanded"),
    setCloudProjectsExpanded: fieldSetter(dispatch, "cloudProjectsExpanded"),
    setChatRowsVisibleCount: fieldSetter(dispatch, "chatRowsVisibleCount"),
    setSidebarOpen: fieldSetter(dispatch, "sidebarOpen"),
    setView: fieldSetter(dispatch, "view"),
    setSelectedAppId: fieldSetter(dispatch, "selectedAppId"),
    setSelectedProjectId: fieldSetter(dispatch, "selectedProjectId"),
    setSelectedSessionId: fieldSetter(dispatch, "selectedSessionId"),
    setPrompt: fieldSetter(dispatch, "prompt"),
    setDraftProvider: fieldSetter(dispatch, "draftProvider"),
    setDraftModel: fieldSetter(dispatch, "draftModel"),
    setCodexPermissionMode: fieldSetter(dispatch, "codexPermissionMode"),
    setCodexReasoningEffort: fieldSetter(dispatch, "codexReasoningEffort"),
    setOpenPondCommandAccessMode: fieldSetter(dispatch, "openPondCommandAccessMode"),
    setBusy: fieldSetter(dispatch, "busy"),
    setDiffPanelOpen: fieldSetter(dispatch, "diffPanelOpen"),
    setDiffPanelExpanded: fieldSetter(dispatch, "diffPanelExpanded"),
    setRightPanelMode: fieldSetter(dispatch, "rightPanelMode"),
    setRightChatPanels: fieldSetter(dispatch, "rightChatPanels"),
    setTerminalOpen: fieldSetter(dispatch, "terminalOpen"),
    setSyncingWorkspaceAppId: fieldSetter(dispatch, "syncingWorkspaceAppId"),
    setSettingsSection: fieldSetter(dispatch, "settingsSection"),
    setNewProjectDialogOpen: fieldSetter(dispatch, "newProjectDialogOpen"),
    setNewProjectMode: fieldSetter(dispatch, "newProjectMode"),
    setNewProjectName: fieldSetter(dispatch, "newProjectName"),
    setNewProjectPath: fieldSetter(dispatch, "newProjectPath"),
    setNewProjectBusy: fieldSetter(dispatch, "newProjectBusy"),
    setCommitDialogOpen: fieldSetter(dispatch, "commitDialogOpen"),
    setCommitMessage: fieldSetter(dispatch, "commitMessage"),
    setCommitIncludeUnstaged: fieldSetter(dispatch, "commitIncludeUnstaged"),
    setCommitNextStep: fieldSetter(dispatch, "commitNextStep"),
    setCommitDraft: fieldSetter(dispatch, "commitDraft"),
    setBranchDialogOpen: fieldSetter(dispatch, "branchDialogOpen"),
    setBranchDialogName: fieldSetter(dispatch, "branchDialogName"),
    setToast: fieldSetter(dispatch, "toast"),
    setError: fieldSetter(dispatch, "error"),
  };
}
