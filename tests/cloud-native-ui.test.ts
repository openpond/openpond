import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, type Dispatch, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  CloudProject,
  CloudWorkItem,
  CloudWorkItemDetail,
  CreatePipelineRequest,
  LocalProject,
  Session,
} from "@openpond/contracts";
import { emptyOpenPondProfileState } from "@openpond/contracts";

import { CloudWorkView } from "../apps/web/src/components/cloud/CloudWorkView";
import { CloudSetupDialog } from "../apps/web/src/components/workspace/CloudSetupDialog";
import { useSidebarData, visibleSidebarProjectRows } from "../apps/web/src/hooks/useSidebarData";
import { buildInitialCreatePipelineSnapshot } from "../apps/web/src/lib/create-pipeline-request";
import { buildRuntimeIndexes } from "../apps/web/src/lib/runtime-indexes";
import {
  nextSidebarChatVisibleCount,
  previousSidebarChatVisibleCount,
  SidebarSectionList,
  sidebarProjectClickAction,
} from "../apps/web/src/components/sidebar/SidebarSectionList";
import type { SidebarProps } from "../apps/web/src/components/sidebar/Sidebar.types";
import {
  SIDEBAR_SECTION_LIMIT,
  projectSelectionKey,
  type AppView,
  type SidebarProjectItem,
} from "../apps/web/src/lib/app-models";

const NOW = "2026-06-17T00:00:00.000Z";

const noop = () => undefined;
const noopDispatch = (() => undefined) as Dispatch<SetStateAction<never>>;

function cloudProject(overrides: Partial<CloudProject> = {}): CloudProject {
  return {
    id: "cloud_project_1",
    teamId: "team_1",
    name: "Cloud Repo",
    slug: "cloud-repo",
    sourceType: "github_repo",
    sourceLabel: "openpond/cloud-repo",
    defaultBranch: "main",
    internalRepoPath: null,
    manifestPath: null,
    manifestHash: null,
    syncedAt: NOW,
    organizationName: "OpenPond",
    organizationSlug: "openpond",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function localProject(overrides: Partial<LocalProject> = {}): LocalProject {
  return {
    id: "local_project_1",
    name: "Local Repo",
    path: "/workspace/local-repo",
    workspacePath: "/workspace/local-repo",
    repoPath: "/workspace/local-repo",
    source: "git",
    sandboxTemplate: null,
    linkedOpenPondApp: null,
    linkedSandboxProject: null,
    preferredSandboxAgentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function chatSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openpond",
    title: "Feature chat",
    appId: null,
    appName: null,
    workspaceKind: "local",
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/workspace/local-repo",
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

function cloudWorkItem(overrides: Partial<CloudWorkItem> = {}): CloudWorkItem {
  return {
    id: "work_item_1",
    teamId: "team_1",
    projectId: "cloud_project_1",
    conversationId: "conversation_1",
    title: "Implement Cloud follow-up",
    status: "running",
    sourceRef: "main",
    baseSha: null,
    latestRuntimeId: "runtime_1",
    latestSandboxId: "sandbox_1",
    latestTaskRunId: "task_run_1",
    assignedAgentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    metadata: {},
    ...overrides,
  };
}

function cloudWorkItemDetail(workItem: CloudWorkItem): CloudWorkItemDetail {
  return {
    workItem,
    messages: [
      {
        id: "message_user_1",
        workItemId: workItem.id,
        teamId: workItem.teamId,
        projectId: workItem.projectId,
        conversationId: workItem.conversationId ?? undefined,
        role: "user",
        body: "Polish the Cloud UI",
        createdByUserId: "user_1",
        createdAt: NOW,
        metadata: {},
      },
      {
        id: "message_assistant_1",
        workItemId: workItem.id,
        teamId: workItem.teamId,
        projectId: workItem.projectId,
        conversationId: workItem.conversationId ?? undefined,
        role: "assistant",
        body: "Updated the thread styling.",
        createdByUserId: null,
        createdAt: NOW,
        metadata: {},
      },
    ],
    activity: [
      {
        id: "activity_1",
        workItemId: workItem.id,
        teamId: workItem.teamId,
        projectId: workItem.projectId,
        kind: "task_progress",
        summary: "Task is running.",
        createdAt: NOW,
        metadata: {},
      },
    ],
    runtimeSessions: [],
  };
}

function hostedCreatePipelineRequest(overrides: Partial<CreatePipelineRequest> = {}): CreatePipelineRequest {
  return {
    schemaVersion: "openpond.createPipeline.request.v1",
    id: "create_request_cloud",
    operation: "create",
    surface: "hosted_create",
    command: "/create",
    objective: "Create a hosted release notes agent",
    adapter: {
      kind: "hosted",
      sourceAuthority: "hosted_profile",
      teamId: "team_1",
      projectId: "cloud_project_1",
      activeProfile: "default",
      sourceRef: "main",
      baseSha: "abc123",
      workItemId: null,
      confirmationPolicy: "always_require_plan_approval",
    },
    actor: { id: "sam", kind: "user", label: "Sam" },
    scope: {
      conversationId: "conversation_1",
      workItemId: null,
      projectId: "cloud_project_1",
      targetProject: {
        id: "cloud_project_1",
        name: "Cloud Repo",
        workspacePath: null,
        sourceRef: "main",
        baseSha: null,
      },
    },
    context: {
      messageIds: [],
      conversationExcerpts: [],
      attachments: [],
      apps: [],
      tools: [],
      targetRepoAssumptions: ["cloud project: openpond/cloud-repo"],
    },
    targetAgent: {
      agentId: null,
      displayName: null,
      defaultActionKey: "chat",
    },
    metadata: { source: "cloud_work_home" },
    createdAt: NOW,
    ...overrides,
  };
}

function sidebarProps(overrides: Partial<SidebarProps> = {}): SidebarProps {
  const project = localProject();
  const cloud = cloudProject();
  const workItem = cloudWorkItem({ projectId: cloud.id });
  const localProjectRows = localProjectSidebarRows([project]);
  const cloudProjectRows = cloudProjectSidebarRows([cloud]);
  const chat = chatSession();
  const setView = ((_value: SetStateAction<AppView>) => undefined) as Dispatch<SetStateAction<AppView>>;
  const cloudProjectKey = projectSelectionKey("cloud", cloud.id);

  return {
    view: "cloud",
    selectedAppId: null,
    selectedProjectId: cloudProjectKey,
    selectedSessionId: null,
    selectedCloudWorkItemId: workItem.id,
    account: null,
    profile: emptyOpenPondProfileState(),
    pinnedCollapsed: false,
    projectsCollapsed: false,
    cloudProjectsCollapsed: false,
    chatsCollapsed: false,
    archivedChatsOpen: false,
    projectsExpanded: false,
    cloudProjectsExpanded: false,
    sectionMenuOpen: null,
    dragItem: null,
    pinnedRows: [],
    pinnedSessions: [],
    visibleProjectRows: [...localProjectRows, ...cloudProjectRows],
    localProjectRows,
    insightsSystemProjectHidden: true,
    cloudProjectRows,
    workspaceStates: {},
    cloudWorkItemsByProjectId: {
      [cloudProjectKey]: [workItem],
    },
    projectSessionRowsByProjectId: {},
    sidebarProjectIdBySessionId: {},
    runningSessionIds: new Set(),
    visibleChatRows: [chat],
    chatRows: [chat],
    expandedProjectIds: new Set([cloudProjectKey]),
    onSidebarResizeStart: noop,
    setSidebarOpen: noopDispatch,
    setView,
    setSelectedAppId: noopDispatch,
    setSelectedProjectId: noopDispatch,
    setSelectedSessionId: noopDispatch,
    setSearchOpen: noopDispatch,
    setSectionMenuOpen: noopDispatch,
    setSettingsSection: noopDispatch,
    onTogglePinnedCollapsed: noop,
    onToggleProjectsCollapsed: noop,
    onToggleCloudProjectsCollapsed: noop,
    onToggleChatsCollapsed: noop,
    setArchivedChatsOpen: noopDispatch,
    setProjectsExpanded: noopDispatch,
    setCloudProjectsExpanded: noopDispatch,
    setChatRowsVisibleCount: noopDispatch,
    beginNewChat: noop,
    dockSessionRight: noop,
    openCloudHome: noop,
    createCloudEnvironment: noop,
    selectCloudWorkItem: noop,
    addProjectFolder: noop,
    startExistingProjectFromPath: noop,
    startProjectFromScratch: noop,
    startCloudProjectFromScratch: noop,
    moveProjectToCloud: noop,
    switchProjectWorkspaceTarget: noop,
    removeProject: noop,
    toggleInsightsSystemProjectVisibility: noop,
    toggleProjectPinned: noop,
    toggleSessionPinned: noop,
    archiveSession: noop,
    restoreSession: noop,
    expandProject: noop,
    toggleProjectExpanded: noop,
    startPinnedDrag: noop,
    clearSidebarDrag: noop,
    previewPinnedDrop: noop,
    commitPinnedDrop: noop,
    commitPinnedPreviewDrop: noop,
    ...overrides,
  };
}

function localProjectSidebarRows(projects: LocalProject[]): SidebarProjectItem[] {
  return projects.map((project, index) => ({
    kind: "local" as const,
    id: projectSelectionKey("local", project.id),
    pinned: false,
    order: index,
    project,
  }));
}

function cloudProjectSidebarRows(projects: CloudProject[]): SidebarProjectItem[] {
  return projects.map((project, index) => ({
    kind: "cloud" as const,
    id: projectSelectionKey("cloud", project.id),
    pinned: false,
    order: index,
    project,
  }));
}

describe("Cloud native UI", () => {
  test("renders linked local and Cloud projects as one project row with hosted work", () => {
    const cloud = cloudProject({ name: "Shared Repo" });
    const local = localProject({
      name: "Shared Repo",
      linkedSandboxProject: {
        teamId: cloud.teamId,
        projectId: cloud.id,
        projectSlug: cloud.slug,
        projectName: cloud.name,
        sourceRepoUrl: null,
        defaultBranch: cloud.defaultBranch,
        manifestPath: null,
        manifestHash: null,
        syncedAt: NOW,
        linkedAt: NOW,
      },
    });
    const workItem = cloudWorkItem({ projectId: cloud.id, title: "Hosted follow-up" });
    const localProjectKey = projectSelectionKey("local", local.id);

    function LinkedProjectSidebarProbe() {
      const data = useSidebarData({
        localProjects: [local],
        cloudProjects: [cloud],
        cloudWorkItems: [workItem],
        sessions: [],
        runtimeIndexes: buildRuntimeIndexes([], []),
        appPreferences: {},
        selectedSessionId: null,
        selectedProjectId: localProjectKey,
        archivedChatsOpen: false,
        projectsExpanded: true,
        chatRowsVisibleCount: SIDEBAR_SECTION_LIMIT,
      });

      return createElement(SidebarSectionList, sidebarProps({
        selectedProjectId: localProjectKey,
        selectedCloudWorkItemId: null,
        sectionMenuOpen: null,
        visibleProjectRows: data.visibleProjectRows,
        localProjectRows: data.localProjectRows,
        cloudProjectRows: data.cloudProjectRows,
        cloudWorkItemsByProjectId: data.cloudWorkItemsByProjectId,
        projectSessionRowsByProjectId: data.projectSessionRowsByProjectId,
        sidebarProjectIdBySessionId: data.sidebarProjectIdBySessionId,
        chatRows: [],
        visibleChatRows: [],
        expandedProjectIds: new Set([localProjectKey]),
      }));
    }

    const markup = renderToStaticMarkup(createElement(LinkedProjectSidebarProbe));

    expect(markup.match(/row-label">Shared Repo/g)?.length).toBe(1);
    expect(markup).not.toContain("Local + Cloud");
    expect(markup).toContain('aria-label="Shared Repo status"');
    expect(markup).not.toContain("Local Status");
    expect(markup).not.toContain("Cloud Status");
    expect(markup).not.toContain("Local Repo");
    expect(markup).not.toContain("Cloud Repo");
    expect(markup).toContain('data-workspace-target="local"');
    expect(markup).toContain('data-workspace-target="cloud"');
    expect(markup).toContain("main / available");
    expect(markup).toContain("main / 1 running");
    expect(markup).not.toContain("/workspace/local-repo");
    expect(markup).toContain("project-kind-icon local linked-cloud");
    expect(markup).toContain("project-kind-icon-cloud-badge");
    expect(markup).toContain("Hosted follow-up");
    expect(markup).not.toContain(">Cloud Projects<");
  });

  test("keeps the selected project visible without expanding all project rows", () => {
    const rows = localProjectSidebarRows(
      Array.from({ length: SIDEBAR_SECTION_LIMIT + 3 }, (_, index) =>
        localProject({
          id: `local_project_${index}`,
          name: `Project ${index}`,
        }),
      ),
    );
    const selectedProjectId = rows[SIDEBAR_SECTION_LIMIT + 2]!.id;
    const visibleRows = visibleSidebarProjectRows(rows, false, selectedProjectId);

    expect(visibleRows).toHaveLength(SIDEBAR_SECTION_LIMIT);
    expect(visibleRows.map((row) => row.id)).toContain(selectedProjectId);
    expect(visibleRows.map((row) => row.id)).not.toContain(rows[SIDEBAR_SECTION_LIMIT - 1]!.id);
  });

  test("keeps project location popovers tied to hover or keyboard-visible focus", () => {
    const css = readFileSync(
      new URL("../apps/web/src/styles/sidebar/sidebar.css", import.meta.url),
      "utf8",
    );

    expect(css).toContain(".sidebar-project-row:focus-visible + .sidebar-project-locations-popover");
    expect(css).not.toContain(".sidebar-project-row-shell:focus-within .sidebar-project-locations-popover");
  });

  test("renders local and Cloud projects in one Projects section with grouped work items", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarSectionList, sidebarProps({ sectionMenuOpen: "projects" })),
    );
    const projectsIndex = markup.indexOf(">Projects<");
    const chatsIndex = markup.indexOf(">Chats<");

    expect(projectsIndex).toBeGreaterThan(-1);
    expect(chatsIndex).toBeGreaterThan(-1);
    expect(chatsIndex).toBeGreaterThan(projectsIndex);
    const projectsSection = markup.slice(projectsIndex, chatsIndex);
    expect(markup).not.toContain(">Cloud Projects<");
    expect(markup).toContain("New Cloud task");
    expect(markup).toContain("New Cloud Project");
    expect(markup).toContain("Use existing folder path");
    expect(markup).toContain("Create environment");
    expect(projectsSection).toContain('row-label">Local Repo</span><span class="sidebar-project-caret"');
    expect(projectsSection).toContain('row-label">Cloud Repo</span><span class="sidebar-project-caret"');
    expect(projectsSection).not.toContain('row-label-detail">Local</span>');
    expect(projectsSection).not.toContain('row-label-detail">Cloud / main</span>');
    expect(projectsSection).toContain('aria-label="Local Repo status"');
    expect(projectsSection).toContain('aria-label="Cloud Repo status"');
    expect(projectsSection).not.toContain("Local Status");
    expect(projectsSection).not.toContain("Cloud Status");
    expect(projectsSection).toContain("local / available");
    expect(projectsSection).toContain("not in cloud");
    expect(projectsSection).toContain("main / 1 running");
    expect(projectsSection).toContain('data-workspace-target="local"');
    expect(projectsSection).toContain('data-workspace-target="cloud"');
    expect(projectsSection).toContain('data-workspace-target="upload_cloud"');
    expect(projectsSection).not.toContain("GitHub Source");
    expect(projectsSection).not.toContain("Cloud Source");
    expect(projectsSection).not.toContain("/workspace/local-repo");
    expect(projectsSection).toContain('class="sidebar-project-caret"');
    expect(projectsSection).toContain("lucide-chevron-down");
    expect(projectsSection.indexOf('aria-label="More project actions"')).toBeGreaterThan(
      projectsSection.indexOf('aria-label="Pin project"'),
    );
    expect(projectsSection.indexOf('data-tooltip="New chat"')).toBeGreaterThan(
      projectsSection.indexOf('aria-label="More project actions"'),
    );
    expect(markup).toContain("Implement Cloud follow-up");
    expect(markup).not.toContain("Open project chat");
    expect(markup).toContain('data-tooltip="New chat"');
    expect(markup).toContain('aria-label="More project actions"');
    expect(markup).not.toContain('data-tooltip="Move to Cloud"');
    expect(markup).not.toContain("lucide-cloud-upload");
    expect(markup).toContain('data-tooltip="Open in right panel"');
    expect(markup).toContain("actions-3");
    expect(markup).not.toContain("All tasks");
    expect(markup).not.toContain("Start from GitHub repo");
    expect(markup).not.toContain("Start from template");
    expect(markup).not.toContain("Upload/link local project");
  });

  test("renders Local Projects options menu with Insights folder toggle", () => {
    const hiddenMarkup = renderToStaticMarkup(
      createElement(
        SidebarSectionList,
        sidebarProps({ sectionMenuOpen: "projects-options", insightsSystemProjectHidden: true }),
      ),
    );
    const visibleMarkup = renderToStaticMarkup(
      createElement(
        SidebarSectionList,
        sidebarProps({ sectionMenuOpen: "projects-options", insightsSystemProjectHidden: false }),
      ),
    );

    expect(hiddenMarkup).toContain('aria-label="Projects options"');
    expect(hiddenMarkup).toContain("Show Insights folder");
    expect(visibleMarkup).toContain("Hide Insights folder");
  });

  test("paginates top-level chats ten at a time", () => {
    const chatRows = Array.from({ length: 24 }, (_, index) =>
      chatSession({ id: `session_${index}`, title: `Feature chat ${index}` }),
    );
    const pagedMarkup = renderToStaticMarkup(
      createElement(
        SidebarSectionList,
        sidebarProps({
          chatRows,
          visibleChatRows: chatRows.slice(0, SIDEBAR_SECTION_LIMIT + 10),
        }),
      ),
    );
    const fullyVisibleMarkup = renderToStaticMarkup(
      createElement(
        SidebarSectionList,
        sidebarProps({
          chatRows,
          visibleChatRows: chatRows,
        }),
      ),
    );

    expect(pagedMarkup).toContain("Show more");
    expect(pagedMarkup).toContain("Show less");
    expect(pagedMarkup).toContain("Showing 15 of 24 chats");
    expect(fullyVisibleMarkup).not.toContain("Show more");
    expect(fullyVisibleMarkup).toContain("Show less");
    expect(fullyVisibleMarkup).toContain("Showing 24 of 24 chats");
  });

  test("paginates chats inside individual projects", () => {
    const localProjectRows = localProjectSidebarRows([localProject()]);
    const projectId = localProjectRows[0]!.id;
    const projectSessions = Array.from({ length: 24 }, (_, index) =>
      chatSession({ id: `project_session_${index}`, title: `Project chat ${index}` }),
    );
    const markup = renderToStaticMarkup(
      createElement(
        SidebarSectionList,
        sidebarProps({
          selectedProjectId: projectId,
          localProjectRows,
          visibleProjectRows: localProjectRows,
          cloudProjectRows: [],
          cloudWorkItemsByProjectId: {},
          expandedProjectIds: new Set([projectId]),
          projectSessionRowsByProjectId: {
            [projectId]: projectSessions,
          },
        }),
      ),
    );

    expect(markup).toContain("Project chat 4");
    expect(markup).not.toContain("Project chat 5");
    expect(markup).toContain("Show more");
    expect(markup).not.toContain("Show less");
    expect(markup).toContain("Showing 5 of 24 project chats");
  });

  test("advances the visible chat count by one page without overshooting", () => {
    expect(nextSidebarChatVisibleCount(SIDEBAR_SECTION_LIMIT, 24)).toBe(15);
    expect(nextSidebarChatVisibleCount(15, 24)).toBe(24);
    expect(nextSidebarChatVisibleCount(0, 24)).toBe(15);
  });

  test("reduces the visible chat count by one page level", () => {
    expect(previousSidebarChatVisibleCount(24, 24)).toBe(15);
    expect(previousSidebarChatVisibleCount(15, 24)).toBe(SIDEBAR_SECTION_LIMIT);
    expect(previousSidebarChatVisibleCount(35, 35)).toBe(25);
    expect(previousSidebarChatVisibleCount(40, 24)).toBe(15);
  });

  test("marks agent SDK projects with composite sidebar icons", () => {
    const agentSdk = {
      detected: true,
      packageName: "openpond-agent-sdk",
      rootPath: null,
      manifestPath: "package.json",
      version: "^1.0.0",
      dependencyType: "dependencies" as const,
    };
    const localProjectRows = localProjectSidebarRows([
      localProject({ agentSdk }),
    ]);
    const cloudProjectRows = cloudProjectSidebarRows([
      cloudProject({ agentSdk }),
    ]);
    const markup = renderToStaticMarkup(
      createElement(SidebarSectionList, sidebarProps({
        selectedProjectId: null,
        selectedCloudWorkItemId: null,
        localProjectRows,
        visibleProjectRows: [...localProjectRows, ...cloudProjectRows],
        cloudProjectRows,
        cloudWorkItemsByProjectId: {},
        expandedProjectIds: new Set([localProjectRows[0]!.id]),
      })),
    );

    expect(markup.match(/project-kind-icon-agent/g)?.length).toBe(2);
    expect(markup).toContain("lucide-folder-open");
    expect(markup).toContain("lucide-cloud");
  });

  test("selects sidebar projects only from a draft chat", () => {
    expect(sidebarProjectClickAction({ view: "chat", selectedSessionId: null })).toBe("select_draft_project");
    expect(sidebarProjectClickAction({ view: "chat", selectedSessionId: "session_1" })).toBe("toggle_project");
    expect(sidebarProjectClickAction({ view: "apps", selectedSessionId: null })).toBe("toggle_project");
  });

  test("keeps Cloud project actions in the Projects add menu", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarSectionList, sidebarProps({ sectionMenuOpen: "projects" })),
    );
    const projectsIndex = markup.indexOf(">Projects<");
    const chatsIndex = markup.indexOf(">Chats<");
    const projectsSection = markup.slice(projectsIndex, chatsIndex);

    expect(projectsIndex).toBeGreaterThan(-1);
    expect(projectsSection).toContain("New Cloud Project");
    expect(projectsSection).toContain("New Cloud task");
    expect(projectsSection).toContain("Create environment");
    expect(markup).not.toContain(">Cloud Projects<");
  });

  test("paginates the unified Projects section", () => {
    const localProjects = Array.from({ length: 6 }, (_, index) =>
      localProject({
        id: `local_project_${index + 1}`,
        name: `Local Repo ${index + 1}`,
      }),
    );
    const cloudProjects = Array.from({ length: 6 }, (_, index) =>
      cloudProject({
        id: `cloud_project_${index + 1}`,
        name: `Cloud Repo ${index + 1}`,
      }),
    );
    const localProjectRows = localProjectSidebarRows(localProjects);
    const cloudProjectRows = cloudProjectSidebarRows(cloudProjects);
    const projectRows = [...localProjectRows, ...cloudProjectRows].sort((left, right) => {
      if (left.order !== right.order) return left.order - right.order;
      return left.project.name.localeCompare(right.project.name);
    });

    const collapsedMarkup = renderToStaticMarkup(
      createElement(SidebarSectionList, sidebarProps({
        selectedProjectId: null,
        selectedCloudWorkItemId: null,
        localProjectRows,
        visibleProjectRows: projectRows.slice(0, 5),
        cloudProjectRows,
        cloudWorkItemsByProjectId: {},
        expandedProjectIds: new Set(),
      })),
    );
    expect(collapsedMarkup).toContain("Cloud Repo 3");
    expect(collapsedMarkup).not.toContain("Local Repo 4");
    expect(collapsedMarkup).not.toContain("Cloud Repo 4");
    expect(collapsedMarkup).not.toContain("Local Repo 6");
    expect(collapsedMarkup).not.toContain("Cloud Repo 6");
    expect(collapsedMarkup.match(/Show more/g)?.length).toBe(1);

    const expandedMarkup = renderToStaticMarkup(
      createElement(SidebarSectionList, sidebarProps({
        selectedProjectId: null,
        selectedCloudWorkItemId: null,
        projectsExpanded: true,
        localProjectRows,
        visibleProjectRows: projectRows,
        cloudProjectRows,
        cloudWorkItemsByProjectId: {},
        expandedProjectIds: new Set(),
      })),
    );
    expect(expandedMarkup).toContain("Local Repo 6");
    expect(expandedMarkup).toContain("Cloud Repo 6");
  });

  test("reveals Cloud work items only when the stable cloud project key is expanded", () => {
    const cloud = cloudProject();
    const workItem = cloudWorkItem({ projectId: cloud.id });
    const cloudProjectRows = cloudProjectSidebarRows([cloud]);
    const cloudProjectKey = projectSelectionKey("cloud", cloud.id);
    const cloudWorkItemsByProjectId = { [cloudProjectKey]: [workItem] };

    const rawIdMarkup = renderToStaticMarkup(
      createElement(SidebarSectionList, sidebarProps({
        selectedProjectId: cloudProjectKey,
        selectedCloudWorkItemId: workItem.id,
        cloudProjectRows,
        cloudWorkItemsByProjectId,
        expandedProjectIds: new Set([cloud.id]),
      })),
    );
    expect(rawIdMarkup).toContain("Cloud Repo");
    expect(rawIdMarkup).not.toContain("Implement Cloud follow-up");

    const stableKeyMarkup = renderToStaticMarkup(
      createElement(SidebarSectionList, sidebarProps({
        selectedProjectId: cloudProjectKey,
        selectedCloudWorkItemId: workItem.id,
        cloudProjectRows,
        cloudWorkItemsByProjectId,
        expandedProjectIds: new Set([cloudProjectKey]),
      })),
    );
    expect(stableKeyMarkup).toContain("Cloud Repo");
    expect(stableKeyMarkup).toContain("Implement Cloud follow-up");
    expect(stableKeyMarkup).toContain("running / main / sandbox ready / task running");
  });

  test("renders Cloud thread with native chat classes and no web-only header actions", () => {
    const workItem = cloudWorkItem();
    const markup = renderToStaticMarkup(
      createElement(CloudWorkView, {
        projects: [cloudProject()],
        workItems: [workItem],
        selectedWorkItem: workItem,
        detail: cloudWorkItemDetail(workItem),
        loading: false,
        actionBusy: false,
        connection: null,
        error: null,
        model: "openpond-chat",
        showToast: noop,
        onBack: noop,
        onModelChange: noop,
        onSetupCloudProject: noop,
        onCreateWork: async () => undefined,
        onSelectWorkItem: noop,
        onSendMessage: async () => undefined,
        onHandleBackground: async () => undefined,
        onCancelCreatePlan: async () => undefined,
        onCancelTask: async () => undefined,
        onShowFiles: noop,
      }),
    );

    expect(markup).toContain('class="cloud-work-view thread"');
    expect(markup).toContain('class="cloud-thread-body"');
    expect(markup).toContain('class="cloud-thread-timeline"');
    expect(markup).toContain('class="cloud-thread-inline-nav"');
    expect(markup).toContain('class="cloud-message user"');
    expect(markup).toContain('class="cloud-message assistant"');
    expect(markup).toContain("Running in Cloud");
    expect(markup).toContain("The local checkout is unchanged while the sandbox works.");
    expect(markup).toContain("1 log");
    expect(markup).toContain("task run");
    expect(markup).toContain("local unchanged");
    expect(markup).toContain('class="cloud-thread-composer"');
    expect(markup).toContain(">Files<");
    expect(markup).toContain("Stop task");
    expect(markup).not.toContain("cloud-thread-topbar");
    expect(markup).not.toContain("Loading task thread");
    expect(markup).not.toContain(">Archive<");
    expect(markup).not.toContain(">Share<");
    expect(markup).not.toContain("Open in cloud");
  });

  test("renders explicit local apply state for reviewed Cloud patches", () => {
    const workItem = cloudWorkItem({ status: "needs_review" });
    const enabledMarkup = renderToStaticMarkup(
      createElement(CloudWorkView, {
        projects: [cloudProject()],
        workItems: [workItem],
        selectedWorkItem: workItem,
        detail: cloudWorkItemDetail(workItem),
        loading: false,
        actionBusy: false,
        connection: null,
        error: null,
        model: "openpond-chat",
        showToast: noop,
        onBack: noop,
        onModelChange: noop,
        onSetupCloudProject: noop,
        onCreateWork: async () => undefined,
        onSelectWorkItem: noop,
        onSendMessage: async () => undefined,
        onHandleBackground: async () => undefined,
        onCancelCreatePlan: async () => undefined,
        onCancelTask: async () => undefined,
        localProjectName: "Local Repo",
        onApplyLocalPatch: async () => undefined,
        onShowFiles: noop,
      }),
    );
    const disabledMarkup = renderToStaticMarkup(
      createElement(CloudWorkView, {
        projects: [cloudProject()],
        workItems: [workItem],
        selectedWorkItem: workItem,
        detail: cloudWorkItemDetail(workItem),
        loading: false,
        actionBusy: false,
        connection: null,
        error: null,
        model: "openpond-chat",
        showToast: noop,
        onBack: noop,
        onModelChange: noop,
        onSetupCloudProject: noop,
        onCreateWork: async () => undefined,
        onSelectWorkItem: noop,
        onSendMessage: async () => undefined,
        onHandleBackground: async () => undefined,
        onCancelCreatePlan: async () => undefined,
        onCancelTask: async () => undefined,
        onShowFiles: noop,
      }),
    );

    expect(enabledMarkup).toContain("Cloud patch ready");
    expect(enabledMarkup).toContain("Apply locally");
    expect(enabledMarkup).toContain("Apply to Local Repo");
    expect(enabledMarkup).toContain(">Files<");
    expect(disabledMarkup).toContain("No local checkout");
    expect(disabledMarkup).toContain("disabled");
  });

  test("renders hosted create pipeline plan review in Cloud thread", () => {
    const createPipelineRequest = hostedCreatePipelineRequest({
      metadata: {
        source: "cloud_work_home",
        actionShape: {
          mode: "chat_and_direct_actions",
          label: "Chat plus direct action",
          detail: "Expose a default chat route and a repeatable direct action when the generated source has a tool-like run.",
          defaultActionKey: "chat",
          directActionHint: "Create a direct action only for the repeatable tool-like behavior.",
          artifactPolicy: "Persist trace and run summary; declare output artifacts when the direct action produces files.",
        },
      },
      context: {
        messageIds: ["message_1"],
        conversationExcerpts: [],
        attachments: [
          {
            id: "attachment_1",
            name: "release-notes.txt",
            mediaType: "text/plain",
            ref: "chat-attachment:attachment_1",
          },
        ],
        apps: [
          {
            id: "github",
            name: "GitHub",
            connectionId: null,
            required: true,
          },
        ],
        tools: [
          {
            name: "github.search_pull_requests",
            inputSummary: "Search merged pull requests",
            outputSummary: "Found 4 merged PRs.",
            artifactRefs: ["artifact://pr-list"],
            sideEffects: ["action completed"],
          },
        ],
        targetRepoAssumptions: ["cloud project: openpond/cloud-repo"],
      },
    });
    const createPipeline = buildInitialCreatePipelineSnapshot(createPipelineRequest);
    expect(createPipeline.plan?.approvalId).toBeTruthy();
    expect(createPipeline.approvalIds).toEqual([createPipeline.plan?.approvalId]);
    const workItem = cloudWorkItem({
      status: "backlog",
      title: createPipelineRequest.objective,
      createPipelineRequest,
      createPipeline,
    });
    const baseDetail = cloudWorkItemDetail(workItem);
    const detail = {
      ...baseDetail,
      messages: [
        {
          id: "message_create_pipeline_link",
          workItemId: workItem.id,
          teamId: workItem.teamId,
          projectId: workItem.projectId,
          conversationId: workItem.conversationId ?? undefined,
          role: "system" as const,
          body: "Create pipeline metadata linked to this work item.",
          createdByUserId: null,
          createdAt: NOW,
          metadata: {
            source: "openpond_app_cloud_create_pipeline_link",
            hidden: true,
          },
        },
        ...baseDetail.messages,
      ],
      createPipelineRequest,
      createPipeline,
    };
    const markup = renderToStaticMarkup(
      createElement(CloudWorkView, {
        projects: [cloudProject()],
        workItems: [workItem],
        selectedWorkItem: workItem,
        detail,
        loading: false,
        actionBusy: false,
        connection: null,
        error: null,
        model: "openpond-chat",
        showToast: noop,
        onBack: noop,
        onModelChange: noop,
        onSetupCloudProject: noop,
        onCreateWork: async () => undefined,
        onSelectWorkItem: noop,
        onSendMessage: async () => undefined,
        onHandleBackground: async () => undefined,
        onCancelCreatePlan: async () => undefined,
        onCancelTask: async () => undefined,
        onShowFiles: noop,
      }),
    );

    expect(markup).toContain("Agent plan review");
    expect(markup).toContain("Create a hosted release notes agent");
    expect(markup).toContain("Hosted profile");
    expect(markup).toContain("Action shape");
    expect(markup).toContain("Chat plus direct action");
    expect(markup).toContain("agents/create-a-hosted-release-notes-agent");
    expect(markup).not.toContain("agent/agent.ts");
    expect(markup).toContain("release-notes.txt");
    expect(markup).toContain("GitHub");
    expect(markup).toContain("github.search_pull_requests");
    expect(markup).toContain("Requirements");
    expect(markup).toContain("Workflow evidence");
    expect(markup).toContain("Side effects");
    expect(markup).toContain("action completed");
    expect(markup).toContain("artifact://pr-list");
    expect(markup).toContain("Confirm plan");
    expect(markup).toContain("Edit plan");
    expect(markup).toContain("Cancel");
    expect(markup).not.toContain("Create pipeline metadata linked to this work item.");
  });

  test("silently hydrates Cloud thread details without loading copy", () => {
    const workItem = cloudWorkItem({ title: "Hydrate without flashing" });
    const markup = renderToStaticMarkup(
      createElement(CloudWorkView, {
        projects: [cloudProject()],
        workItems: [workItem],
        selectedWorkItem: workItem,
        detail: null,
        loading: true,
        actionBusy: false,
        connection: null,
        error: null,
        model: "openpond-chat",
        showToast: noop,
        onBack: noop,
        onModelChange: noop,
        onSetupCloudProject: noop,
        onCreateWork: async () => undefined,
        onSelectWorkItem: noop,
        onSendMessage: async () => undefined,
        onHandleBackground: async () => undefined,
        onCancelCreatePlan: async () => undefined,
        onCancelTask: async () => undefined,
        onShowFiles: noop,
      }),
    );

    expect(markup).toContain("Hydrate without flashing");
    expect(markup).not.toContain("Loading task thread");
  });

  test("keeps Cloud thread spacing and composer styles aligned with native chat", () => {
    const css = readFileSync(
      new URL("../apps/web/src/styles/cloud/cloud-work.css", import.meta.url),
      "utf8",
    );

    expect(css).toContain("grid-template-rows: minmax(0, 1fr) auto;");
    expect(css).toContain("padding: 22px max(48px, calc((100% - 960px) / 2)) 132px;");
    expect(css).toContain("max-width: 960px;");
    expect(css).toContain("max-width: min(620px, 72%);");
    expect(css).toContain("width: min(736px, calc(100% - 80px));");
    expect(css).toContain("background: #2b2b2b;");
    expect(css).not.toContain(".cloud-thread-topbar");
    expect(css).toContain(".cloud-message.assistant");
  });

  test("renders local-to-cloud upload preview before source upload", () => {
    const markup = renderToStaticMarkup(
      createElement(CloudSetupDialog, {
        state: {
          status: "confirm",
          localProjectId: "local_project_1",
          cloudProjectId: "cloud_project_1",
          teamId: "team_1",
          projectName: "Invoice Workspace",
          projectKind: "local",
          projectUrl: null,
          setupUrl: null,
          branch: "main",
          preview: {
            rootPath: "/workspace/invoice",
            branch: "main",
            headCommit: "abc1234567890abcdef",
            targetProjectId: "cloud_project_1",
            targetProjectName: "Invoice Workspace",
            fileCount: 2,
            byteCount: 2849,
            skippedCount: 1,
            initializedEmptyProject: false,
          },
          previewLoading: false,
          previewError: null,
          upload: null,
          error: null,
        },
        onClose: noop,
        onStart: noop,
      }),
    );

    expect(markup).toContain("Will upload 2 files");
    expect(markup).toContain("3 KB");
    expect(markup).toContain("1 skipped");
    expect(markup).toContain("local abc1234");
    expect(markup).toContain("cloud_project_1");
    expect(markup).toContain("main");
  });
});
