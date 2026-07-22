import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LocalProject, Session } from "@openpond/contracts";
import { useSidebarData } from "../apps/web/src/hooks/useSidebarData";
import { projectSelectionKey } from "../apps/web/src/lib/app-models";
import { buildRuntimeIndexes } from "../apps/web/src/lib/runtime-indexes";

const NOW = "2026-07-01T12:00:00.000Z";

describe("Insights sidebar visibility", () => {
  test("hides the Insights system project by default and surfaces it when the run session is selected", () => {
    const hiddenProject = localProject({
      id: "system_openpond_insights",
      name: "Insights",
      systemKind: "openpond.insights",
      hiddenFromDefaultSidebar: true,
    });
    const visibleProject = localProject({
      id: "local_visible",
      name: "Visible Project",
    });
    const hiddenSession = session({
      id: "insights_session",
      title: "Insights",
      localProjectId: hiddenProject.id,
      workspaceId: hiddenProject.id,
      systemKind: "openpond.insights",
      hiddenFromDefaultSidebar: true,
    });
    const visibleSession = session({
      id: "visible_session",
      title: "Visible",
      localProjectId: visibleProject.id,
      workspaceId: visibleProject.id,
    });

    expect(
      renderSidebarDataProbe({
        projects: [hiddenProject, visibleProject],
        sessions: [hiddenSession, visibleSession],
        selectedSessionId: visibleSession.id,
      }),
    ).toContain("projects=local_visible");
    expect(
      renderSidebarDataProbe({
        projects: [hiddenProject, visibleProject],
        sessions: [hiddenSession, visibleSession],
        selectedSessionId: visibleSession.id,
      }),
    ).not.toContain("system_openpond_insights");

    const selectedHidden = renderSidebarDataProbe({
      projects: [hiddenProject, visibleProject],
      sessions: [hiddenSession, visibleSession],
      selectedSessionId: hiddenSession.id,
    });
    expect(selectedHidden).toContain("projects=system_openpond_insights,local_visible");
    expect(selectedHidden).toContain("active=2");
    expect(selectedHidden).toContain("projectSessions=local:system_openpond_insights=insights_session");
  });

  test("shows the hidden Insights system conversation when the Insights project is visible", () => {
    const project = localProject({
      id: "system_openpond_insights",
      name: "Insights",
      systemKind: "openpond.insights",
      hiddenFromDefaultSidebar: true,
    });
    const insightsSession = session({
      id: "insights_session",
      title: "Insights",
      localProjectId: project.id,
      workspaceId: project.id,
      systemKind: "openpond.insights",
      hiddenFromDefaultSidebar: true,
    });

    const hidden = renderSidebarDataProbe({
      projects: [project],
      sessions: [insightsSession],
      selectedSessionId: "regular_session",
    });
    expect(hidden).not.toContain("system_openpond_insights");
    expect(hidden).not.toContain("insights_session");

    const visible = renderSidebarDataProbe({
      projects: [{ ...project, hiddenFromDefaultSidebar: false }],
      sessions: [insightsSession],
      selectedSessionId: "regular_session",
    });
    expect(visible).toContain("projects=system_openpond_insights");
    expect(visible).toContain("projectSessions=local:system_openpond_insights=insights_session");
  });

  test("keeps local terminal chats visible as chat rows or project children", () => {
    const project = localProject({
      id: "local_visible",
      name: "Visible Project",
      path: "/workspace/local-project",
      workspacePath: "/workspace/local-project",
      repoPath: "/workspace/local-project",
    });
    const plainTerminalChat = session({
      id: "terminal_plain",
      provider: "openai",
      title: "Terminal chat",
      workspaceKind: undefined,
      workspaceId: null,
      localProjectId: null,
      cwd: "/workspace/local-project",
    });
    const projectTerminalChat = session({
      id: "terminal_project",
      provider: "openai",
      title: "Visible Project terminal",
      workspaceKind: "local_project",
      workspaceId: project.id,
      workspaceName: project.name,
      localProjectId: project.id,
      cwd: "/workspace/local-project",
    });

    const rendered = renderSidebarDataProbe({
      projects: [project],
      sessions: [plainTerminalChat, projectTerminalChat],
      selectedSessionId: plainTerminalChat.id,
    });

    expect(rendered).toContain("active=2");
    expect(rendered).toContain(";chats=;");
    expect(rendered).toContain(";visibleChats=;");
    expect(rendered).toContain("projectSessions=local:local_visible=terminal_plain,terminal_project");
  });

  test("groups hidden subagent child conversations under their parent chat", () => {
    const parent = session({
      id: "parent_chat",
      title: "Parent chat",
    });
    const child = session({
      id: "child_research",
      title: "Research: inspect docs",
      hiddenFromDefaultSidebar: true,
      parentSessionId: parent.id,
      subagentRunId: "run_research",
      subagentRoleId: "research",
    });

    const rendered = renderSidebarDataProbe({
      projects: [],
      sessions: [parent, child],
      selectedSessionId: parent.id,
    });

    expect(rendered).toContain("active=1");
    expect(rendered).toContain("chats=parent_chat");
    expect(rendered).toContain("visibleChats=parent_chat");
    expect(rendered).toContain("childSessions=parent_chat=child_research");
    expect(rendered).not.toContain("chats=parent_chat,child_research");
  });

  test("moves saved chats out of Chats and project children", () => {
    const project = localProject({ id: "saved_project", name: "Saved Project" });
    const regular = session({ id: "regular_chat", title: "Regular", cwd: "/tmp/general" });
    const pinnedChat = session({ id: "pinned_chat", title: "Pinned", pinned: true });
    const savedChat = session({ id: "saved_chat", title: "Saved", savedForLater: true });
    const savedProjectChat = session({
      id: "saved_project_chat",
      title: "Saved project chat",
      localProjectId: project.id,
      workspaceId: project.id,
      savedForLater: true,
    });

    const rendered = renderSidebarDataProbe({
      projects: [project],
      sessions: [regular, pinnedChat, savedChat, savedProjectChat],
      selectedSessionId: regular.id,
    });

    expect(rendered).toContain("chats=regular_chat");
    expect(rendered).toContain("pinned=pinned_chat");
    expect(rendered).toContain("saved=saved_chat,saved_project_chat");
    expect(rendered).not.toContain("projectSessions=local:saved_project=saved_project_chat");
  });
});

function renderSidebarDataProbe(input: {
  projects: LocalProject[];
  sessions: Session[];
  selectedSessionId: string;
}): string {
  return renderToStaticMarkup(createElement(SidebarDataProbe, input));
}

function SidebarDataProbe({
  projects,
  sessions,
  selectedSessionId,
}: {
  projects: LocalProject[];
  sessions: Session[];
  selectedSessionId: string;
}) {
  const data = useSidebarData({
    localProjects: projects,
    cloudProjects: [],
    cloudWorkItems: [],
    sessions,
    runtimeIndexes: buildRuntimeIndexes([], []),
    appPreferences: {},
    selectedSessionId,
    selectedProjectId: null,
    archivedChatsOpen: false,
    projectsExpanded: true,
    chatRowsVisibleCount: 10,
  });
  return createElement(
    "span",
    null,
    [
      `projects=${data.localProjectRows.map((row) => row.project.id).join(",")}`,
      `active=${data.activeSessions.length}`,
      `chats=${data.chatRows.map((row) => row.id).join(",")}`,
      `visibleChats=${data.visibleChatRows.map((row) => row.id).join(",")}`,
      `pinned=${data.pinnedSessions.map((row) => row.id).join(",")}`,
      `saved=${data.savedForLaterSessions.map((row) => row.id).join(",")}`,
      `projectSessions=${Object.entries(data.projectSessionRowsByProjectId)
        .map(([projectId, rows]) => `${projectId}=${rows.map((row) => row.id).join(",")}`)
        .join("|")}`,
      `childSessions=${Object.entries(data.childSessionRowsByParentId)
        .map(([parentId, rows]) => `${parentId}=${rows.map((row) => row.id).join(",")}`)
        .join("|")}`,
      `selectedProject=${projectSelectionKey("local", selectedSessionId)}`,
    ].join(";"),
  );
}

function localProject(overrides: Partial<LocalProject>): LocalProject {
  return {
    id: "local_project",
    name: "Local Project",
    path: "/workspace/local-project",
    workspacePath: "/workspace/local-project",
    repoPath: "/workspace/local-project",
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

function session(overrides: Partial<Session>): Session {
  return {
    id: "session",
    provider: "openpond",
    title: "Thread",
    appId: null,
    appName: null,
    workspaceKind: "local_project",
    workspaceId: null,
    workspaceName: null,
    localProjectId: null,
    cloudProjectId: null,
    cloudTeamId: null,
    cwd: "/workspace/local-project",
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
