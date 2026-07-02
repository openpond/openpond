import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { createElement, type ComponentProps, type Dispatch, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  LocalProject,
  ProviderSettings,
  Session,
  WorkspaceDiffSummary,
} from "@openpond/contracts";
import { emptyOpenPondProfileState } from "@openpond/contracts";

import { Composer } from "../apps/web/src/components/chat/Composer";
import { MessageRow, ThinkingIndicator } from "../apps/web/src/components/chat/Messages";
import { CommandMenu } from "../apps/web/src/components/command/CommandMenu";
import { ProviderSettingsSection } from "../apps/web/src/components/settings/ProviderSettingsSection";
import { SidebarSectionList } from "../apps/web/src/components/sidebar/SidebarSectionList";
import type { SidebarProps } from "../apps/web/src/components/sidebar/Sidebar.types";
import { WorkspaceDiffPanel } from "../apps/web/src/components/workspace-diff/WorkspaceDiffPanel";
import { useSidebarData } from "../apps/web/src/hooks/useSidebarData";
import type { ChatMessage } from "../apps/web/src/lib/app-models";
import { SIDEBAR_SECTION_LIMIT, projectSelectionKey } from "../apps/web/src/lib/app-models";
import type { ContextWindowStatus } from "../apps/web/src/lib/context-window";
import { buildRuntimeIndexes } from "../apps/web/src/lib/runtime-indexes";
import type { WorkspaceTargetState } from "../apps/web/src/lib/workspace-location";

const NOW = "2026-07-01T12:00:00.000Z";
const noop = () => undefined;
const noopAsync = async () => undefined;
const noopDispatch = (() => undefined) as Dispatch<SetStateAction<never>>;

describe("renderer performance budgets", () => {
  test("keeps composer typing renders bounded", () => {
    const first = measureStaticRender(
      "composer typing baseline",
      createElement(Composer, composerProps("/cr")),
      200,
    );
    const typed = measureStaticRender(
      "composer typing updated prompt",
      createElement(Composer, composerProps("/goal-l")),
      200,
    );

    expect(first.html).toContain("Create agent or project");
    expect(typed.html).toContain("Run a local goal");
    expect(typed.bytes).toBeGreaterThan(2_000);
  });

  test("keeps long streaming transcript rows bounded", () => {
    const messages = Array.from({ length: 320 }, (_, index) => chatMessage(index));
    const result = measureStaticRender(
      "streaming transcript rows",
      createElement(
        "section",
        { className: "chat-thread" },
        messages.map((message, index) =>
          createElement(MessageRow, {
            key: message.id,
            message,
            showFooter: index === messages.length - 1,
          }),
        ),
        createElement(ThinkingIndicator),
      ),
      600,
    );

    expect(result.html).toContain("Support stream update 319");
    expect(result.bytes).toBeGreaterThan(40_000);
  });

  test("keeps a 200-file diff panel open render bounded", () => {
    const diff = workspaceDiffSummary(200);
    const result = measureStaticRender(
      "workspace diff panel 200 files",
      createElement(WorkspaceDiffPanel, {
        appId: "local_project_1",
        workspaceId: "local_project_1",
        workspaceKind: "local_project",
        connection: null,
        diff,
        editorPreferences: null,
        loading: false,
        workspaceName: "Local project",
        workspaceInitialized: true,
        workspaceError: null,
        expanded: false,
        onRefresh: noopAsync,
        onResizeStart: noop,
        onToggleExpanded: noop,
        onOpenBrowser: noop,
        onOpenBrowserUrl: noop,
      }),
      650,
    );

    expect(diff.files).toHaveLength(200);
    expect(result.html).toContain("src/module-0.ts");
  });

  test("keeps large settings and sidebar list renders bounded", () => {
    const settings = measureStaticRender(
      "provider settings with 400 cached models",
      createElement(ProviderSettingsSection, {
        account: null,
        codex: null,
        providers: providerSettings(400),
        providerBusy: null,
        validationMessage: null,
        deleteProviderCredential: noopAsync,
        loadProviderModels: noopAsync,
        refreshProviderModels: noopAsync,
        saveProviderConfig: noopAsync,
        saveProviderCredential: noopAsync,
        validateProvider: noopAsync,
      }),
      350,
    );
    const sidebar = measureStaticRender(
      "sidebar with large chat list",
      createElement(SidebarSectionList, sidebarProps(160)),
      500,
    );
    const expandedProjectSidebar = measureStaticRender(
      "sidebar with expanded project history",
      createElement(SidebarSectionList, sidebarPropsWithExpandedProject(240)),
      650,
    );

    expect(settings.html).toContain("400 models");
    expect(settings.html).not.toContain("Fixture Model 399</option>");
    expect(sidebar.html).toContain("Support thread 159");
    expect(sidebar.bytes).toBeGreaterThan(30_000);
    expect(expandedProjectSidebar.html).toContain("Project 47 thread 4");
    expect(expandedProjectSidebar.bytes).toBeGreaterThan(40_000);
  });

  test("keeps sidebar data grouping bounded for large local history", () => {
    const result = measureStaticRender(
      "sidebar data grouping 3000 sessions",
      createElement(SidebarDataProbe, { sessionCount: 3_000, projectCount: 12 }),
      450,
    );

    expect(result.html).toContain("projects=12");
    expect(result.html).toContain("children=3000");
  });

  test("keeps command palette opening bounded with large history", () => {
    const result = measureStaticRender(
      "command palette large history",
      createElement(CommandMenu, commandMenuProps(3_000, 300)),
      250,
    );

    expect(result.html).toContain("Support thread 9");
    expect(result.html).toContain("Local Project 7");
    expect(result.html).not.toContain("Support thread 2999");
  });
});

function measureStaticRender(label: string, element: React.ReactElement, maxDurationMs: number) {
  const startedAt = performance.now();
  const html = renderToStaticMarkup(element);
  const durationMs = performance.now() - startedAt;
  const bytes = Buffer.byteLength(html);
  console.info(`[renderer-perf] ${label}: ${durationMs.toFixed(2)}ms, ${bytes} bytes`);
  expect(durationMs).toBeLessThan(maxDurationMs);
  expect(bytes).toBeGreaterThan(100);
  return { bytes, durationMs, html };
}

function composerProps(prompt: string): React.ComponentProps<typeof Composer> {
  return {
    mode: "dock",
    prompt,
    mentionApps: [],
    selectedMentionAppId: null,
    contextWindowStatus: contextWindowStatus(),
    goalRuntime: null,
    createPipelineRuntime: null,
    busy: false,
    running: false,
    showProjectFooter: true,
    connection: null,
    providerSettings: null,
    provider: "openpond",
    model: "openpond-chat",
    projectTarget: {
      value: "none",
      label: "No project",
      detail: "General chat",
      options: [{ value: "none", label: "No project", detail: "General chat", kind: "none" }],
      busy: false,
    },
    actionCatalog: [],
    workspaceTarget: workspaceTargetState(),
    codexPermissionMode: "default",
    codexReasoningEffort: "medium",
    onProviderChange: noop,
    onProjectTargetChange: noop,
    onWorkspaceTargetChange: noop,
    onModelChange: noop,
    onCodexPermissionModeChange: noop,
    onCodexReasoningEffortChange: noop,
    onPromptChange: noop,
    onMentionAppSelect: noop,
    showToast: noop,
    onSubmit: async () => true,
    onStop: noopAsync,
  };
}

function contextWindowStatus(): ContextWindowStatus {
  return {
    usedTokens: 2400,
    maxTokens: 128000,
    percent: 2,
    summary: "2% full",
    tokensLabel: "2.4k / 128k tokens used",
    detail: null,
    tooltip: "Context window: 2% full.",
    tone: "low",
  };
}

function workspaceTargetState(): WorkspaceTargetState {
  return {
    value: "local",
    label: "Local",
    detail: "Use local workspace",
    options: [
      { value: "local", label: "Local", detail: "Use local workspace", disabled: false },
      { value: "cloud", label: "Cloud", detail: "Use cloud workspace", disabled: false },
    ],
    action: { value: "cloud", label: "Move to Cloud", detail: "Create a cloud workspace", disabled: false },
    busy: false,
  };
}

function chatMessage(index: number): ChatMessage {
  const role = index % 2 === 0 ? "user" : "assistant";
  return {
    id: `message-${index}`,
    role,
    content:
      role === "user"
        ? `Customer asks for support update ${index}.`
        : `Support stream update ${index}: blocked owner is assigned and next action is recorded.`,
    timestamp: NOW,
    turnId: `turn-${Math.floor(index / 2)}`,
  };
}

function workspaceDiffSummary(fileCount: number): WorkspaceDiffSummary {
  const files = Array.from({ length: fileCount }, (_, index) => ({
    path: `src/module-${index}.ts`,
    status: index % 5 === 0 ? "added" : "modified",
    additions: 4,
    deletions: 1,
    patch: [
      `diff --git a/src/module-${index}.ts b/src/module-${index}.ts`,
      `--- a/src/module-${index}.ts`,
      `+++ b/src/module-${index}.ts`,
      "@@ -1,2 +1,5 @@",
      `-export const value = ${index};`,
      `+export const value = ${index + 1};`,
      "+export const status = 'ready';",
    ].join("\n"),
    content: `export const value = ${index + 1};\nexport const status = 'ready';\n`,
  }));
  return {
    appId: "local_project_1",
    repoPath: "/workspace/local-project",
    initialized: true,
    dirty: true,
    filesChanged: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    repoFiles: files.map((file) => file.path),
    files,
    error: null,
    updatedAt: NOW,
  };
}

function providerSettings(modelCount: number): ProviderSettings {
  const models = Array.from({ length: modelCount }, (_, index) => ({
    id: `fixture-model-${index}`,
    providerId: "openai",
    displayName: `Fixture Model ${index}`,
    contextWindow: 128000,
    outputLimit: 8192,
    lifecycleStatus: "active",
    source: "provider",
    capabilities: {
      chatCompletions: true,
      streaming: true,
      toolCalling: index % 2 === 0,
      reasoning: index % 3 === 0,
      vision: false,
      structuredOutput: true,
    },
  }));
  return {
    version: 1,
    providers: {
      openpond: { enabled: true, baseUrl: null, defaultModel: "openpond-chat", modelOverrides: [], updatedAt: NOW },
      openai: { enabled: true, baseUrl: "https://api.openai.com/v1", defaultModel: "fixture-model-399", modelOverrides: [], updatedAt: NOW },
    },
    statuses: {
      openpond: providerStatus("openpond", "OpenPond Chat", true, ["openpond-chat"]),
      openai: providerStatus("openai", "OpenAI", true, models.map((model) => model.id)),
    },
    modelCaches: {
      openai: {
        providerId: "openai",
        models,
        fetchedAt: NOW,
        lastError: null,
        source: "provider",
      },
    },
    updatedAt: NOW,
  } as ProviderSettings;
}

function providerStatus(id: string, displayName: string, available: boolean, modelIds: string[]) {
  return {
    id,
    displayName,
    lifecycleStatus: "active",
    credentialModes: ["local_secret"],
    routing: { hostedOpChat: id === "openpond", localRuntime: true, localByok: id !== "openpond", hostedByok: false },
    capabilities: {
      chatCompletions: true,
      streaming: true,
      modelDiscovery: id === "openpond" ? "hosted" : "provider",
      toolCalling: true,
      reasoning: true,
      imageInput: false,
      structuredOutput: true,
    },
    credential: {
      connected: available,
      source: id === "openpond" ? "hosted" : "local_secret",
      redacted: available ? "sk-..." : null,
      lastValidatedAt: NOW,
      lastError: null,
    },
    enabled: true,
    available,
    defaultModel: modelIds[0] ?? null,
    modelIds,
    lastError: null,
  };
}

function sidebarProps(chatCount: number): SidebarProps {
  const visibleChatRows = Array.from({ length: chatCount }, (_, index) =>
    session({
      id: `session-${index}`,
      title: `Support thread ${index}`,
      order: index,
      updatedAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
    }),
  );
  const localProjectRows = Array.from({ length: 40 }, (_, index) => {
    const project = localProject(index);
    return {
      id: projectSelectionKey("local", project.id),
      kind: "local" as const,
      project,
      pinned: false,
      order: index,
    };
  });
  return {
    view: "chat",
    selectedAppId: null,
    selectedProjectId: null,
    selectedSessionId: "session-0",
    selectedCloudWorkItemId: null,
    account: null,
    profile: emptyOpenPondProfileState(),
    pinnedCollapsed: false,
    projectsCollapsed: false,
    cloudProjectsCollapsed: false,
    chatsCollapsed: false,
    archivedChatsOpen: false,
    projectsExpanded: true,
    cloudProjectsExpanded: true,
    sectionMenuOpen: null,
    dragItem: null,
    pinnedRows: [],
    pinnedSessions: [],
    visibleLocalProjectRows: localProjectRows,
    localProjectRows,
    insightsSystemProjectHidden: true,
    cloudProjectRows: [],
    cloudWorkItemsByProjectId: {},
    projectSessionRowsByProjectId: {},
    sidebarProjectIdBySessionId: {},
    runningSessionIds: new Set(["session-3"]),
    visibleChatRows,
    chatRows: visibleChatRows,
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
    startProjectFromScratch: noop,
    startCloudProjectFromScratch: noop,
    moveProjectToCloud: noop,
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
  };
}

function sidebarPropsWithExpandedProject(projectChildRowCount: number): SidebarProps {
  const props = sidebarProps(24);
  const projectCount = Math.ceil(projectChildRowCount / SIDEBAR_SECTION_LIMIT);
  const projectRows = Array.from({ length: projectCount }, (_, index) => {
    const project = localProject(index);
    return {
      id: projectSelectionKey("local", project.id),
      kind: "local" as const,
      project,
      pinned: false,
      order: index,
    };
  });
  const projectSessionRowsByProjectId: Record<string, Session[]> = {};
  const expandedProjectIds = new Set<string>();
  for (const item of projectRows) {
    expandedProjectIds.add(item.id);
    projectSessionRowsByProjectId[item.id] = Array.from({ length: SIDEBAR_SECTION_LIMIT }, (_, index) =>
      session({
        id: `${item.id}-session-${index}`,
        title: `Project ${item.order} thread ${index}`,
        order: index,
        localProjectId: item.project.id,
        workspaceId: item.project.id,
        cwd: item.project.path,
        updatedAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
      }),
    );
  }

  return {
    ...props,
    selectedProjectId: projectRows[0]?.id ?? null,
    visibleLocalProjectRows: projectRows,
    localProjectRows: projectRows,
    projectSessionRowsByProjectId,
    expandedProjectIds,
  };
}

function commandMenuProps(
  sessionCount: number,
  projectCount: number,
): ComponentProps<typeof CommandMenu> {
  return {
    open: true,
    query: "",
    projects: Array.from({ length: projectCount }, (_, index) => {
      const project = localProject(index);
      return {
        id: projectSelectionKey("local", project.id),
        kind: "local" as const,
        project,
        pinned: false,
        order: index,
      };
    }),
    sessions: Array.from({ length: sessionCount }, (_, index) =>
      session({
        id: `command-session-${index}`,
        title: `Support thread ${index}`,
        order: index,
        updatedAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
      }),
    ),
    onQueryChange: noop,
    onClose: noop,
    onNewChat: noop,
    onOpenProject: noop,
    onOpenSession: noop,
  };
}

function SidebarDataProbe({ sessionCount, projectCount }: { sessionCount: number; projectCount: number }) {
  const localProjects = Array.from({ length: projectCount }, (_, index) => localProject(index));
  const sessions = Array.from({ length: sessionCount }, (_, index) => {
    const project = localProjects[index % localProjects.length]!;
    return session({
      id: `grouped-session-${index}`,
      title: `Grouped thread ${index}`,
      localProjectId: project.id,
      workspaceId: project.id,
      cwd: `${project.path}/packages/${index}`,
      order: index,
      updatedAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
    });
  });
  const data = useSidebarData({
    localProjects,
    cloudProjects: [],
    cloudWorkItems: [],
    sessions,
    runtimeIndexes: buildRuntimeIndexes([], []),
    appPreferences: {},
    selectedSessionId: "grouped-session-0",
    archivedChatsOpen: false,
    projectsExpanded: true,
    chatRowsVisibleCount: sessionCount,
  });
  const projectChildCount = Object.values(data.projectSessionRowsByProjectId).reduce(
    (total, rows) => total + rows.length,
    0,
  );
  return createElement(
    "span",
    null,
    `sidebar-data-probe projects=${data.localProjectRows.length};children=${projectChildCount};chats=${data.chatRows.length};grouping=bounded;active=${data.activeSessions.length};visible=${data.visibleLocalProjectRows.length};selected=grouped-session-0`,
  );
}

function localProject(index: number): LocalProject {
  return {
    id: `local-project-${index}`,
    name: `Local Project ${index}`,
    path: `/workspace/local-project-${index}`,
    workspacePath: `/workspace/local-project-${index}`,
    repoPath: `/workspace/local-project-${index}`,
    source: "git",
    sandboxTemplate: null,
    linkedOpenPondApp: null,
    linkedSandboxProject: null,
    preferredSandboxAgentId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function session(overrides: Partial<Session>): Session {
  return {
    id: "session",
    provider: "openpond",
    title: "Support thread",
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
