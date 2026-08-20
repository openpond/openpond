import type { Dispatch, DragEvent, PointerEvent, SetStateAction } from "react";
import type {
  AccountState,
  BootstrapPayload,
  OpenPondApp,
  Session,
  SidebarFileBookmark,
  TeamChatMember,
  TeamChatThread,
  CommunityChannel,
  CommunitySummary,
  Experience,
  ProductArea,
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
import type { GoalRuntimeStatus } from "../../lib/goal-runtime";
import type { SubagentRuntimeStatus } from "../../lib/subagent-runtime";
import type { OpenPondOrganization } from "../../lib/organization-types";
import type { ClientConnection } from "../../api";

export type SidebarProps = {
  productArea: ProductArea;
  onProductAreaChange: (productArea: ProductArea) => void;
  experience: Experience;
  view: AppView;
  selectedAppId: string | null;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  selectedTeamThreadId: string | null;
  teamChatEnabled: boolean;
  teamChatOrganization: OpenPondOrganization | null;
  teamChatLoading?: boolean;
  currentUserId: string | null;
  teamMembers: TeamChatMember[];
  teamThreads: TeamChatThread[];
  communityItems: CommunitySummary[];
  communityChannels: CommunityChannel[];
  communityLoading: boolean;
  communityError: string | null;
  selectedCommunityId: string | null;
  selectedCommunityChannelId: string | null;
  account: AccountState | null;
  connection: ClientConnection | null;
  profile: BootstrapPayload["profile"] | null | undefined;
  pinnedCollapsed: boolean;
  cloudProjectsCollapsed: boolean;
  chatsCollapsed: boolean;
  savedForLaterCollapsed: boolean;
  archivedChatsOpen: boolean;
  cloudProjectsExpanded: boolean;
  sectionMenuOpen: SidebarSectionMenuId | null;
  dragItem: SidebarDragItem | null;
  taskDragSessionId: string | null;
  taskPreviewSessionIds: string[] | null;
  activeSessions: Session[];
  archivedSessions: Session[];
  pinnedRows: PinnedSidebarItem[];
  pinnedSessions: Session[];
  savedForLaterSessions: Session[];
  savedForLaterFiles: SidebarFileBookmark[];
  projectRows?: SidebarProjectItem[];
  localProjectRows: SidebarProjectItem[];
  cloudProjectRows: SidebarProjectItem[];
  projectSessionRowsByProjectId: Record<string, Session[]>;
  childSessionRowsByParentId?: Record<string, Session[]>;
  sidebarProjectIdBySessionId: Record<string, string>;
  terminalSummaries: Record<string, TerminalScopeSummary>;
  runningSessionIds: ReadonlySet<string>;
  goalRuntimeBySessionId?: ReadonlyMap<string, GoalRuntimeStatus>;
  subagentRuntimeBySessionId?: ReadonlyMap<string, SubagentRuntimeStatus>;
  visibleChatRows: Session[];
  chatRows: Session[];
  chatRowsVisibleCount: number;
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
  onToggleCloudProjectsCollapsed: () => void;
  onToggleChatsCollapsed: () => void;
  onToggleSavedForLaterCollapsed: () => void;
  setArchivedChatsOpen: Dispatch<SetStateAction<boolean>>;
  setCloudProjectsExpanded: Dispatch<SetStateAction<boolean>>;
  setChatRowsVisibleCount: Dispatch<SetStateAction<number>>;
  beginNewChat: (app?: OpenPondApp | null) => void;
  beginProjectChat: (projectId: string) => void;
  dockSessionRight: (session: Session) => void;
  selectTeamThread: (threadId: string) => void;
  openTeamDm: (userId: string) => void;
  discoverCommunities: () => void;
  selectCommunity: (communityId: string) => void;
  selectCommunityChannel: (channelId: string) => void;
  toggleSessionPinned: (session: Session) => void;
  toggleProjectPinned: (item: SidebarProjectItem) => void;
  toggleSessionSavedForLater: (session: Session) => void;
  openSidebarFile: (file: SidebarFileBookmark) => void;
  setSidebarFileStatus: (
    file: SidebarFileBookmark,
    status: "pinned" | "saved_for_later" | "none"
  ) => void;
  archiveSession: (session: Session) => void;
  restoreSession: (session: Session) => void;
  renameSession: (session: Session, title: string) => void;
  removeProject: (item: SidebarProjectItem) => void;
  expandProject: (projectId: string) => void;
  toggleProjectExpanded: (projectId: string) => void;
  startPinnedDrag: (
    event: DragEvent<HTMLDivElement>,
    item: SidebarDragItem
  ) => void;
  clearSidebarDrag: () => void;
  previewPinnedDrop: (
    event: DragEvent<HTMLDivElement>,
    target: SidebarDragItem
  ) => void;
  commitPinnedDrop: (
    event: DragEvent<HTMLDivElement>,
    target: SidebarDragItem
  ) => void;
  commitPinnedPreviewDrop: () => void;
  startTaskDrag: (
    event: DragEvent<HTMLDivElement>,
    input: {
      allSessionIds: string[];
      visibleSessionIds: string[];
      sessionId: string;
    }
  ) => void;
  clearTaskDrag: () => void;
  previewTaskDrop: (
    event: DragEvent<HTMLDivElement>,
    targetSessionId: string
  ) => void;
  commitTaskDrop: (
    event: DragEvent<HTMLDivElement>,
    targetSessionId: string
  ) => void;
  commitTaskPreviewDrop: () => void;
};
