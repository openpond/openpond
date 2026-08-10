import { createElement, type Dispatch, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LocalProject, Session } from "@openpond/contracts";
import { describe, expect, test } from "vitest";

import { SidebarSectionList } from "../apps/web/src/components/sidebar/SidebarSectionList";
import type { SidebarProps } from "../apps/web/src/components/sidebar/Sidebar.types";
import type { SidebarProjectItem } from "../apps/web/src/lib/app-models";
import { tasksetNameFromId } from "../apps/web/src/lib/session-tasksets";
import {
  mergeSidebarTaskOrder,
  sidebarTaskEmptyLabel,
  sidebarTaskRows,
  sidebarTaskShortcutState,
} from "../apps/web/src/lib/sidebar-task-list";

const NOW = "2026-07-29T12:00:00.000Z";
const noop = () => undefined;
const noopDispatch = (() => undefined) as Dispatch<SetStateAction<never>>;

describe("sidebar task list controls", () => {
  test("uses one task section with status filters and independent sort modes", () => {
    const activeSession = session({
      id: "session_active",
      title: "Scoped implementation",
      pinned: true,
    });
    const regularSession = session({
      id: "session_regular",
      title: "Regular implementation",
      order: 1,
    });
    const markup = renderToStaticMarkup(
      createElement(
        SidebarSectionList,
        sidebarProps({
          activeSessions: [activeSession, regularSession],
          chatRows: [activeSession, regularSession],
          chatRowsVisibleCount: 5,
          sectionMenuOpen: "tasks-filter",
          visibleChatRows: [activeSession, regularSession],
        })
      )
    );

    expect(markup).toContain(">Tasks<");
    expect(markup).not.toContain(">In Progress<");
    expect(markup.match(/>Save for later</g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Filter tasks"');
    expect(markup).toContain('role="menuitemradio"');
    expect(markup).toContain(">Active<");
    expect(markup).toContain(">In progress<");
    expect(markup).toContain(">Pinned<");
    expect(markup).toContain(">Save for later<");
    expect(markup).toContain(">Done<");
    expect(markup).toContain(">All<");
    expect(markup).not.toContain("Show done");
    expect(markup).not.toContain("Show archived");
    expect(markup).toContain('aria-label="Mark done"');
    expect(markup).toMatch(/aria-label="Mark done"[\s\S]*?lucide-check/);
    expect(markup).toContain('aria-label="Show 0 saved for later tasks"');
    expect(markup).not.toContain(
      'data-tooltip="Show 0 saved for later tasks"'
    );
    expect(markup).toContain(">Later<");
    expect(markup).toContain('class="sidebar-task-count-badge"');
    expect(markup).toContain(
      "sidebar-section sidebar-task-section development"
    );
    expect(markup).toContain(
      "sidebar-session-group pinned-group-first pinned-group-last"
    );
    expect(markup.match(/draggable="true"/g)).toHaveLength(1);
    expect(markup).toContain(">Work<");
    expect(markup).not.toContain(">No project<");
    expect(markup).not.toContain('aria-label="New task"');
    expect(markup).not.toContain('aria-label="Collapse Tasks"');
    expect(markup).not.toContain('aria-label="Expand Tasks"');
    expect(markup).not.toContain('data-tooltip="Sort"');
  });

  test("shows 15 tasks initially before offering pagination", () => {
    const sessions = Array.from({ length: 20 }, (_, index) =>
      session({
        id: `session_${index}`,
        title: `Task ${index}`,
        order: index,
      })
    );
    const markup = renderToStaticMarkup(
      createElement(
        SidebarSectionList,
        sidebarProps({
          activeSessions: sessions,
          chatRows: sessions,
          chatRowsVisibleCount: 5,
          visibleChatRows: sessions.slice(0, 5),
        })
      )
    );

    expect(markup.match(/data-session-id=/g)).toHaveLength(15);
    expect(markup).toContain(">Show more<");
    expect(markup).not.toContain(">Show less<");
  });

  test("offers individual Tasksets in the filter menu and hides linked chats by default", () => {
    const regularSession = session({ id: "regular", title: "Normal task" });
    const firstAttempt = session({
      id: "attempt-one",
      title: "Benchmark · First case",
      metadata: { tasksetId: "taskset-one", tasksetName: "Support benchmark" },
    });
    const modelChat = session({
      id: "model-chat",
      title: "Try the trained model",
      metadata: {
        trainingTasksetId: "taskset-one",
        trainingTasksetName: "Support benchmark",
      },
    });
    const markup = renderToStaticMarkup(
      createElement(
        SidebarSectionList,
        sidebarProps({
          activeSessions: [regularSession, firstAttempt, modelChat],
          chatRows: [regularSession, firstAttempt, modelChat],
          sectionMenuOpen: "tasks-filter",
          visibleChatRows: [regularSession, firstAttempt, modelChat],
        }),
      ),
    );

    expect(markup).toContain(">Tasksets<");
    expect(markup).toContain('role="menuitem" aria-expanded="false"');
    expect(markup).not.toContain(">Support benchmark<");
    expect(markup).not.toContain('class="section-menu-option-count"');
    expect(markup).toContain(">Normal task<");
    expect(markup).not.toContain(">Benchmark · First case<");
    expect(markup).not.toContain(">Try the trained model<");
    expect(markup.match(/data-session-id=/g)).toHaveLength(1);
    expect(markup).not.toContain('data-tooltip="Filter:');
  });

  test("derives a readable legacy Taskset name when stored metadata lacks one", () => {
    expect(
      tasksetNameFromId("benchmark-harness-refiner-b227699dcd0c5007")
    ).toBe("Harness Refiner");
    expect(tasksetNameFromId("taskset_work_fixture_portability")).toBe(
      "Work Fixture Portability"
    );
  });

  test("renders project detail and updated date for development tasks without elapsed runtime", () => {
    const project = localProject();
    const projectItem: SidebarProjectItem = {
      id: `local:${project.id}`,
      kind: "local",
      project,
      pinned: true,
      order: 0,
    };
    const activeSession = session({
      id: "session_project",
      title: "Refine sidebar",
      localProjectId: project.id,
      workspaceId: project.id,
    });
    const developmentMarkup = renderToStaticMarkup(
      createElement(
        SidebarSectionList,
        sidebarProps({
          activeSessions: [activeSession],
          chatRows: [activeSession],
          chatRowsVisibleCount: 5,
          localProjectRows: [projectItem],
          projectRows: [projectItem],
          sidebarProjectIdBySessionId: {
            [activeSession.id]: projectItem.id,
          },
          visibleChatRows: [activeSession],
        })
      )
    );

    expect(developmentMarkup).toContain(">Refine sidebar<");
    expect(developmentMarkup).toContain(">Active workspace<");
    expect(developmentMarkup).not.toContain(">2h 7m<");
    expect(developmentMarkup).toContain(
      '<time class="sidebar-row-updated-at" dateTime="2026-07-29T12:00:00.000Z"'
    );
    expect(developmentMarkup).toContain(">Jul 29 ");
    expect(developmentMarkup).not.toContain(" · ");
    expect(developmentMarkup).not.toContain(">Projects<");

    const workMarkup = renderToStaticMarkup(
      createElement(
        SidebarSectionList,
        sidebarProps({
          experience: "work",
          activeSessions: [activeSession],
          chatRows: [activeSession],
          chatRowsVisibleCount: 5,
          localProjectRows: [projectItem],
          projectRows: [projectItem],
          sidebarProjectIdBySessionId: {
            [activeSession.id]: projectItem.id,
          },
          visibleChatRows: [activeSession],
        })
      )
    );

    expect(workMarkup).toContain(">Refine sidebar<");
    expect(workMarkup).toContain(">Active workspace<");
    expect(workMarkup).not.toContain(">2h 7m<");
    expect(workMarkup).toContain(">Jul 29 ");
  });
});

describe("sidebar task filters", () => {
  const active = session({
    id: "active",
    title: "Active",
    updatedAt: "2026-07-29T10:00:00.000Z",
  });
  const running = session({
    id: "running",
    title: "Running",
    order: 1,
    updatedAt: "2026-07-29T11:00:00.000Z",
  });
  const pinned = session({
    id: "pinned",
    title: "Pinned",
    order: 2,
    pinned: true,
    updatedAt: "2026-07-29T09:00:00.000Z",
  });
  const saved = session({
    id: "saved",
    title: "Saved",
    order: 3,
    pinned: true,
    savedForLater: true,
    updatedAt: "2026-07-29T12:00:00.000Z",
  });
  const done = session({
    id: "done",
    title: "Done",
    order: 4,
    archived: true,
    updatedAt: "2026-07-29T08:00:00.000Z",
  });
  const input = {
    activeSessions: [active, running, pinned, saved],
    doneSessions: [done],
    inProgressSessionIds: new Set([running.id]),
    sort: "recent" as const,
  };

  test("Active is the default working set and excludes saved and done tasks", () => {
    expect(
      sidebarTaskRows({ ...input, filter: "active" }).map((row) => row.id)
    ).toEqual(["pinned", "running", "active"]);
  });

  test("recent sort floats pins while status modes remain literal", () => {
    expect(
      sidebarTaskRows({ ...input, filter: "in_progress" }).map((row) => row.id)
    ).toEqual(["running"]);
    expect(
      sidebarTaskRows({ ...input, filter: "pinned" }).map((row) => row.id)
    ).toEqual(["pinned"]);
    expect(
      sidebarTaskRows({ ...input, filter: "saved_for_later" }).map(
        (row) => row.id
      )
    ).toEqual(["saved"]);
    expect(
      sidebarTaskRows({ ...input, filter: "done" }).map((row) => row.id)
    ).toEqual(["done"]);
    expect(
      sidebarTaskRows({ ...input, filter: "all" }).map((row) => row.id)
    ).toEqual(["pinned", "saved", "running", "active", "done"]);
    expect(sidebarTaskEmptyLabel("saved_for_later", "tasks")).toBe(
      "Nothing saved for later"
    );
  });

  test("recent mode preserves manual order inside the pinned block", () => {
    const firstPinned = session({
      id: "first-pinned",
      order: 8,
      pinned: true,
      updatedAt: "2026-07-20T12:00:00.000Z",
    });
    const secondPinned = session({
      id: "second-pinned",
      order: 9,
      pinned: true,
      updatedAt: "2026-07-29T12:00:00.000Z",
    });
    const newestRegular = session({
      id: "newest-regular",
      order: 0,
      updatedAt: "2026-07-30T12:00:00.000Z",
    });

    expect(
      sidebarTaskRows({
        activeSessions: [secondPinned, newestRegular, firstPinned],
        doneSessions: [],
        filter: "active",
        inProgressSessionIds: new Set(),
        sort: "recent",
      }).map((row) => row.id)
    ).toEqual(["first-pinned", "second-pinned", "newest-regular"]);
  });

  test("recent mode previews pinned drag order without changing regular recency", () => {
    const firstPinned = session({
      id: "first-pinned",
      order: 8,
      pinned: true,
      updatedAt: "2026-07-20T12:00:00.000Z",
    });
    const secondPinned = session({
      id: "second-pinned",
      order: 9,
      pinned: true,
      updatedAt: "2026-07-29T12:00:00.000Z",
    });
    const olderRegular = session({
      id: "older-regular",
      updatedAt: "2026-07-28T12:00:00.000Z",
    });
    const newerRegular = session({
      id: "newer-regular",
      updatedAt: "2026-07-30T12:00:00.000Z",
    });

    expect(
      sidebarTaskRows({
        activeSessions: [
          firstPinned,
          olderRegular,
          secondPinned,
          newerRegular,
        ],
        doneSessions: [],
        filter: "active",
        inProgressSessionIds: new Set(),
        previewSessionIds: [secondPinned.id, firstPinned.id],
        sort: "recent",
      }).map((row) => row.id)
    ).toEqual([
      "second-pinned",
      "first-pinned",
      "newer-regular",
      "older-regular",
    ]);
  });

  test("manual order follows persisted order independently of status", () => {
    expect(
      sidebarTaskRows({
        ...input,
        filter: "all",
        sort: "manual",
      }).map((row) => row.id)
    ).toEqual(["active", "running", "pinned", "saved", "done"]);
  });

  test("Taskset mode can narrow linked chats to one Taskset", () => {
    const first = session({
      id: "taskset-first",
      metadata: { tasksetId: "support", tasksetName: "Support" },
    });
    const second = session({
      id: "taskset-second",
      metadata: { tasksetId: "finance", tasksetName: "Finance" },
    });

    expect(
      sidebarTaskRows({
        activeSessions: [active, first, second],
        doneSessions: [],
        filter: "tasksets",
        inProgressSessionIds: new Set(),
        selectedTasksetId: "support",
        sort: "recent",
      }).map((row) => row.id),
    ).toEqual(["taskset-first"]);
  });

  test("reordering a filtered view preserves hidden task positions", () => {
    expect(
      mergeSidebarTaskOrder(
        ["active", "running", "pinned", "saved", "done"],
        ["running", "pinned"],
        ["pinned", "running"]
      )
    ).toEqual(["active", "pinned", "running", "saved", "done"]);
  });

  test("heading shortcut toggles between saved-for-later and active counts", () => {
    expect(
      sidebarTaskShortcutState({
        activeCount: 12,
        filter: "active",
        savedForLaterCount: 3,
      })
    ).toEqual({
      count: 3,
      label: "Later",
      targetFilter: "saved_for_later",
      targetLabel: "saved for later",
    });
    expect(
      sidebarTaskShortcutState({
        activeCount: 12,
        filter: "saved_for_later",
        savedForLaterCount: 3,
      })
    ).toEqual({
      count: 12,
      label: "In Progress",
      targetFilter: "active",
      targetLabel: "active",
    });
  });
});

function sidebarProps(overrides: Partial<SidebarProps> = {}): SidebarProps {
  return {
    productArea: "development",
    onProductAreaChange: noop,
    experience: "development",
    view: "chat",
    selectedAppId: null,
    selectedProjectId: null,
    selectedSessionId: null,
    selectedTeamThreadId: null,
    teamChatEnabled: false,
    teamChatOrganization: null,
    teamChatLoading: false,
    currentUserId: null,
    teamMembers: [],
    teamThreads: [],
    communityItems: [],
    communityChannels: [],
    communityLoading: false,
    communityError: null,
    selectedCommunityId: null,
    selectedCommunityChannelId: null,
    account: null,
    profile: null,
    pinnedCollapsed: false,
    cloudProjectsCollapsed: true,
    chatsCollapsed: false,
    savedForLaterCollapsed: true,
    archivedChatsOpen: false,
    cloudProjectsExpanded: false,
    sectionMenuOpen: null,
    dragItem: null,
    taskDragSessionId: null,
    taskPreviewSessionIds: null,
    activeSessions: [],
    archivedSessions: [],
    pinnedRows: [],
    pinnedSessions: [],
    savedForLaterSessions: [],
    savedForLaterFiles: [],
    projectRows: [],
    localProjectRows: [],
    cloudProjectRows: [],
    projectSessionRowsByProjectId: {},
    childSessionRowsByParentId: {},
    sidebarProjectIdBySessionId: {},
    terminalSummaries: {},
    runningSessionIds: new Set(),
    visibleChatRows: [],
    chatRows: [],
    chatRowsVisibleCount: 5,
    expandedProjectIds: new Set(),
    onSidebarResizeStart: noop,
    setSidebarOpen: noopDispatch,
    setView: noopDispatch,
    setSelectedAppId: noopDispatch,
    setSelectedProjectId: noopDispatch,
    setSelectedSessionId: noopDispatch,
    setSearchOpen: noopDispatch,
    setSectionMenuOpen: noopDispatch,
    setSettingsSection: noopDispatch,
    onTogglePinnedCollapsed: noop,
    onToggleCloudProjectsCollapsed: noop,
    onToggleChatsCollapsed: noop,
    onToggleSavedForLaterCollapsed: noop,
    setArchivedChatsOpen: noopDispatch,
    setCloudProjectsExpanded: noopDispatch,
    setChatRowsVisibleCount: noopDispatch,
    beginNewChat: noop,
    dockSessionRight: noop,
    selectTeamThread: noop,
    openTeamDm: noop,
    discoverCommunities: noop,
    selectCommunity: noop,
    selectCommunityChannel: noop,
    toggleSessionPinned: noop,
    toggleSessionSavedForLater: noop,
    openSidebarFile: noop,
    setSidebarFileStatus: noop,
    archiveSession: noop,
    restoreSession: noop,
    renameSession: noop,
    expandProject: noop,
    toggleProjectExpanded: noop,
    startPinnedDrag: noop,
    clearSidebarDrag: noop,
    previewPinnedDrop: noop,
    commitPinnedDrop: noop,
    commitPinnedPreviewDrop: noop,
    startTaskDrag: noop,
    clearTaskDrag: noop,
    previewTaskDrop: noop,
    commitTaskDrop: noop,
    commitTaskPreviewDrop: noop,
    ...overrides,
  } as SidebarProps;
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session",
    experience: "development",
    provider: "openpond",
    modelRef: null,
    title: "Sidebar session",
    appId: null,
    appName: null,
    workspaceKind: null,
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: null,
    codexThreadId: null,
    createdAt: NOW,
    updatedAt: NOW,
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...overrides,
  };
}

function localProject(): LocalProject {
  return {
    id: "project_in_progress",
    name: "Active workspace",
    path: "/workspace/active",
    workspacePath: "/workspace/active",
    repoPath: "/workspace/active",
    source: "git",
    sandboxTemplate: null,
    linkedOpenPondApp: null,
    linkedSandboxProject: null,
    preferredSandboxAgentId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
