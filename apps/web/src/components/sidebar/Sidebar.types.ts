import type { Dispatch, DragEvent, PointerEvent, SetStateAction } from "react";
import type {
  AccountState,
  BootstrapPayload,
  CloudWorkItem,
  OpenPondApp,
  Session,
  TeamChatMember,
  TeamChatThread,
  WorkspaceState,
} from "@openpond/contracts";
import type { SidebarSectionMenuId } from "../../app/app-state";
import type {
  AppView,
  PinnedSidebarItem,
  SettingsSection,
  SidebarDragItem,
  SidebarProjectItem,
} from "../../lib/app-models";
import type { TerminalScopeSummary } from "../terminal/terminal-state";
import type { WorkspaceTargetValue } from "../../lib/workspace-location";
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import type { OpenPondOrganization } from "../../lib/organization-types";

export type SidebarProps = {
  view: AppView;
  selectedAppId: string | null;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  selectedCloudWorkItemId: string | null;
  selectedTeamThreadId: string | null;
  teamChatEnabled: boolean;
  teamChatOrganization: OpenPondOrganization | null;
  teamChatLoading?: boolean;
  currentUserId: string | null;
  teamMembers: TeamChatMember[];
  teamThreads: TeamChatThread[];
  account: AccountState | null;
  profile: BootstrapPayload["profile"] | null | undefined;
  pinnedCollapsed: boolean;
  projectsCollapsed: boolean;
  cloudProjectsCollapsed: boolean;
  chatsCollapsed: boolean;
  archivedChatsOpen: boolean;
  projectsExpanded: boolean;
  cloudProjectsExpanded: boolean;
  sectionMenuOpen: SidebarSectionMenuId | null;
  dragItem: SidebarDragItem | null;
  pinnedRows: PinnedSidebarItem[];
  pinnedSessions: Session[];
  projectRows?: SidebarProjectItem[];
  visibleProjectRows: SidebarProjectItem[];
  localProjectRows: SidebarProjectItem[];
  insightsSystemProjectHidden: boolean | null;
  cloudProjectRows: SidebarProjectItem[];
  workspaceStates: Record<string, WorkspaceState>;
  cloudWorkItemsByProjectId: Record<string, CloudWorkItem[]>;
  projectSessionRowsByProjectId: Record<string, Session[]>;
  childSessionRowsByParentId?: Record<string, Session[]>;
  sidebarProjectIdBySessionId: Record<string, string>;
  terminalSummaries: Record<string, TerminalScopeSummary>;
  runningSessionIds: ReadonlySet<string>;
  goalRuntimeBySessionId?: ReadonlyMap<string, GoalRuntimeStatus>;
  subagentRuntimeBySessionId?: ReadonlyMap<string, SubagentRuntimeStatus>;
  visibleChatRows: Session[];
  chatRows: Session[];
  expandedProjectIds: ReadonlySet<string>;
  currentVersion?: string | null;
  platform?: string | null;
  arch?: string | null;
  onSidebarResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<AppView>>;
  setSelectedAppId: Dispatch<SetStateAction<string | null>>;
  setSelectedProjectId: Dispatch<SetStateAction<string | null>>;
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setSectionMenuOpen: Dispatch<SetStateAction<SidebarSectionMenuId | null>>;
  setSettingsSection: Dispatch<SetStateAction<SettingsSection>>;
  onTogglePinnedCollapsed: () => void;
  onToggleProjectsCollapsed: () => void;
  onToggleCloudProjectsCollapsed: () => void;
  onToggleChatsCollapsed: () => void;
  setArchivedChatsOpen: Dispatch<SetStateAction<boolean>>;
  setProjectsExpanded: Dispatch<SetStateAction<boolean>>;
  setCloudProjectsExpanded: Dispatch<SetStateAction<boolean>>;
  setChatRowsVisibleCount: Dispatch<SetStateAction<number>>;
  beginNewChat: (app?: OpenPondApp | null) => void;
  dockSessionRight: (session: Session) => void;
  openCloudHome: () => void;
  createCloudEnvironment: () => void;
  selectCloudWorkItem: (workItem: CloudWorkItem) => void;
  selectTeamThread: (threadId: string) => void;
  openTeamDm: (userId: string) => void;
  addProjectFolder: () => void;
  startExistingProjectFromPath: () => void;
  startProjectFromScratch: () => void;
  startCloudProjectFromScratch: () => void;
  moveProjectToCloud: (item: SidebarProjectItem) => void;
  switchProjectWorkspaceTarget: (projectId: string, target: WorkspaceTargetValue) => void;
  removeProject: (item: SidebarProjectItem) => void;
  toggleInsightsSystemProjectVisibility: () => void;
  toggleProjectPinned: (item: SidebarProjectItem) => void;
  toggleSystemProjectVisibility: (item: SidebarProjectItem) => void;
  toggleSessionPinned: (session: Session) => void;
  archiveSession: (session: Session) => void;
  restoreSession: (session: Session) => void;
  renameSession: (session: Session, title: string) => void;
  addSessionToTraining: (session: Session) => void;
  expandProject: (projectId: string) => void;
  toggleProjectExpanded: (projectId: string) => void;
  startPinnedDrag: (event: DragEvent<HTMLDivElement>, item: SidebarDragItem) => void;
  clearSidebarDrag: () => void;
  previewPinnedDrop: (event: DragEvent<HTMLDivElement>, target: SidebarDragItem) => void;
  commitPinnedDrop: (event: DragEvent<HTMLDivElement>, target: SidebarDragItem) => void;
  commitPinnedPreviewDrop: () => void;
};
