import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  Approval,
  ChatAttachment,
  CreatePipelineSnapshot,
  OpenPondApp,
  RuntimeEvent,
  Session,
} from "@openpond/contracts";

import { MessageRow } from "../apps/web/src/components/chat/Messages";
import { ApprovalRequestCard } from "../apps/web/src/components/chat/ApprovalRequestCard";
import { ComposerCreatePipelineStrip } from "../apps/web/src/components/chat/ComposerCreatePipelineStrip";
import { GoalDetailsView } from "../apps/web/src/components/goal/GoalDetailsView";
import { WorkspaceDiffTabs } from "../apps/web/src/components/workspace-diff/WorkspaceDiffPanelChrome";
import {
  sandboxIdFromWorkspaceName,
  shouldSubmitComposerSlashCommandToChat,
  shouldRunCreatePipelineCommandLocally,
} from "../apps/web/src/components/app-shell/main-pane-helpers";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages";
import {
  composerActionCatalogMatches,
  composerActionSlashQuery,
} from "../apps/web/src/lib/composer-action-catalog";
import {
  composerSlashCommandMatches,
  parseComposerSlashCommandPrompt,
} from "../apps/web/src/lib/composer-slash-commands";
import { buildSubmitIssueSlashPrompt } from "../apps/web/src/lib/submit-issue-command";
import {
  approveCreatePipelineSnapshot,
  buildComposerCreatePipelineRequest,
  buildHostedCloudWorkCreatePipelineRequest,
  buildInitialCreatePipelineSnapshot,
  cancelCreatePipelineSnapshot,
  reviseCreatePipelineSnapshot,
} from "../apps/web/src/lib/create-pipeline-request";
import {
  buildOpenPondAppActionRunInput,
  buildOpenPondAgentRunInput,
  buildOpenPondProfileActionRunInput,
} from "../apps/web/src/lib/openpond-action-run";
import { latestReadyLocalCreatePipelineProfileRefreshKey } from "../apps/web/src/lib/create-pipeline-profile-refresh";
import {
  buildSidebarProjectPathIndex,
  isSidebarCloudWorkSession,
  sidebarProjectKeyForSession,
} from "../apps/web/src/lib/sidebar-session-projects";
import { projectSelectionKey } from "../apps/web/src/lib/app-models";
import type {
  SandboxActionCatalogEntry,
} from "../apps/web/src/lib/sandbox-types";
import type { CloudProject, LocalProject } from "@openpond/contracts";
import type { BootstrapPayload } from "@openpond/contracts";

const timestamp = "2026-06-20T00:00:00.000Z";

function action(
  input: Partial<SandboxActionCatalogEntry> & { id: string },
): SandboxActionCatalogEntry {
  return {
    id: input.id,
    name: input.name ?? input.id,
    label: input.label ?? null,
    description: input.description ?? null,
    visibility: input.visibility ?? "default",
    inputSchema: input.inputSchema ?? null,
    outputSchema: input.outputSchema ?? null,
    implementation: input.implementation ?? null,
    mcp: input.mcp ?? null,
    invokesModel: input.invokesModel,
  };
}

function session(input: Partial<Session> = {}): Session {
  return {
    id: "session_1",
    provider: "openpond",
    title: "Project chat",
    appId: null,
    appName: null,
    workspaceKind: "sandbox",
    workspaceId: "cloud_project_1",
    workspaceName: "Cloud Project",
    localProjectId: null,
    cloudProjectId: "cloud_project_1",
    cloudTeamId: "team_1",
    cwd: null,
    codexThreadId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "idle",
    pinned: false,
    archived: false,
    order: 0,
    ...input,
  };
}

function localProject(input: Partial<LocalProject> = {}): LocalProject {
  return {
    id: "local_project_1",
    name: "Local Project",
    path: "/workspace/local-project",
    workspacePath: "/workspace/local-project",
    repoPath: "/workspace/local-project",
    source: "git",
    sandboxTemplate: null,
    linkedOpenPondApp: null,
    linkedSandboxProject: null,
    preferredSandboxAgentId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...input,
  };
}

function cloudProject(input: Partial<CloudProject> = {}): CloudProject {
  return {
    id: "cloud_project_1",
    teamId: "team_1",
    name: "Cloud Project",
    slug: "cloud-project",
    sourceType: "github_repo",
    sourceLabel: "openpond/cloud-project",
    defaultBranch: "main",
    internalRepoPath: null,
    manifestPath: null,
    manifestHash: null,
    syncedAt: timestamp,
    agentSdk: null,
    organizationName: "OpenPond",
    organizationSlug: "openpond",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...input,
  };
}

function runtimeEvent(input: Omit<RuntimeEvent, "timestamp">): RuntimeEvent {
  return {
    timestamp,
    ...input,
  };
}

describe("OpenPond App action channel", () => {
  test("discovers built-in app commands from composer slash input", () => {
    expect(composerSlashCommandMatches({ prompt: "/" }).map((item) => item.id)).toEqual([
      "create",
      "edit",
      "skill",
      "goal",
      "goal-remote",
      "goal-local",
      "train",
      "insights",
      "submit-issue",
      "sync-cloud",
    ]);
    expect(composerSlashCommandMatches({ prompt: "/create" }).map((item) => item.id)).toEqual(["create"]);
    expect(composerSlashCommandMatches({ prompt: "/goal" }).map((item) => item.id)).toEqual([
      "goal",
      "goal-remote",
      "goal-local",
    ]);
    expect(composerSlashCommandMatches({ prompt: "/goal-r" }).map((item) => item.id)).toEqual([
      "goal-remote",
    ]);
    expect(composerSlashCommandMatches({ prompt: "/list" }).map((item) => item.id)).toEqual(["skill"]);
    expect(composerSlashCommandMatches({ prompt: "/skill help" }).map((item) => item.id)).toEqual(["skill"]);
    expect(composerSlashCommandMatches({ prompt: "/submit issue" }).map((item) => item.id)).toEqual(["submit-issue"]);
    expect(parseComposerSlashCommandPrompt("/create summarize files")).toEqual({
      command: "create",
      args: "summarize files",
    });
    expect(parseComposerSlashCommandPrompt("/skill create release-notes")).toEqual({
      command: "skill",
      args: "create release-notes",
    });
    expect(parseComposerSlashCommandPrompt("/goal-remote summarize files")).toEqual({
      command: "goal-remote",
      args: "summarize files",
    });
    expect(parseComposerSlashCommandPrompt("/goal-local summarize files")).toEqual({
      command: "goal-local",
      args: "summarize files",
    });
    expect(parseComposerSlashCommandPrompt("/sync-cloud")).toEqual({
      command: "sync-cloud",
      args: "",
    });
    expect(parseComposerSlashCommandPrompt("/submit-issue add a crash report")).toEqual({
      command: "submit-issue",
      args: "add a crash report",
    });
    expect(parseComposerSlashCommandPrompt("/unknown summarize files")).toBeNull();
  });

  test("routes plain goal slash commands through chat unless remote is explicit", () => {
    const goalCommand = parseComposerSlashCommandPrompt("/goal smoke goal");
    const localGoalCommand = parseComposerSlashCommandPrompt("/goal-local smoke goal");
    const remoteGoalCommand = parseComposerSlashCommandPrompt("/goal-remote smoke goal");
    expect(goalCommand).not.toBeNull();
    expect(localGoalCommand).not.toBeNull();
    expect(remoteGoalCommand).not.toBeNull();

    expect(shouldSubmitComposerSlashCommandToChat(goalCommand!)).toBe(true);
    expect(shouldSubmitComposerSlashCommandToChat(localGoalCommand!)).toBe(true);
    expect(shouldSubmitComposerSlashCommandToChat(remoteGoalCommand!)).toBe(false);
  });

  test("builds GitHub-connected submit issue prompts for openpond", () => {
    const prompt = buildSubmitIssueSlashPrompt("Add export progress to long-running workspace sync.");

    expect(prompt).toContain("@github");
    expect(prompt).toContain("openpond/openpond");
    expect(prompt).toContain("github.issue.create");
    expect(prompt).toContain("Add export progress to long-running workspace sync.");
  });

  test("builds create pipeline envelopes from composer slash commands", () => {
    const parsed = parseComposerSlashCommandPrompt("/create summarize files");
    expect(parsed).not.toBeNull();
    const request = buildComposerCreatePipelineRequest({
      parsed: parsed!,
      prompt: "/create summarize files",
      payload: {
        account: {
          activeProfile: { handle: "sam" },
          label: "Sam",
        },
        preferences: { defaultTeamId: "team_1" },
        profile: {
          mode: "local",
          activeProfile: "default",
          repoPath: "/profiles/default-repo",
          sourcePath: "/profiles/default-repo/profiles/default",
          git: { head: "abc123" },
        },
      } as BootstrapPayload,
      session: session({ id: "session_create", cwd: "/workspace/app" }),
      messages: [
        {
          id: "message_1",
          role: "user",
          content: "We used the GitHub app to inspect release notes.",
          timestamp,
        },
        {
          id: "message_2",
          role: "assistant",
          content: "The useful repeatable workflow is to summarize merged PRs.",
          timestamp,
        },
        {
          id: "message_action_1",
          role: "activity_group",
          timestamp,
          actionRun: {
            actionName: "github.search_pull_requests",
            title: "Search merged pull requests",
            status: "completed",
            responseText: "Found 4 merged PRs.",
            runId: "run_1",
            projectId: "cloud_project_1",
            agentId: null,
            sandboxId: null,
            runtimeId: null,
            implementationType: "mcp",
            sourceRef: null,
            manifestHash: null,
            refs: [
              {
                id: "artifact_1",
                kind: "artifact",
                label: "PR list",
                target: "artifact://pr-list",
              },
              {
                id: "trace_1",
                kind: "trace",
                label: "Search trace",
                target: "trace://github/run_1",
              },
            ],
            childCalls: [],
          },
        },
      ],
      attachments: [
        {
          id: "attachment_1",
          name: "release-notes.txt",
          mediaType: "text/plain",
          sizeBytes: 64,
          kind: "text",
          text: "Release note draft",
        },
      ],
      apps: [
        {
          id: "github",
          name: "GitHub",
          description: null,
          iconUrl: null,
          connected: true,
          enabled: true,
          pinned: false,
          archived: false,
          sortOrder: null,
          tags: [],
          sandbox: null,
          source: "builtin",
        } as OpenPondApp,
      ],
    });
    expect(request?.command).toBe("/create");
    expect(request?.surface).toBe("context_backed_create");
    expect(request?.adapter.kind).toBe("local");
    expect(request?.adapter.sourceAuthority).toBe("local_profile");
    expect(request?.scope.conversationId).toBe("session_create");
    expect(request?.context.messageIds).toEqual(["message_1", "message_2"]);
    expect(request?.context.conversationExcerpts.map((excerpt) => excerpt.excerpt)).toEqual([
      "We used the GitHub app to inspect release notes.",
      "The useful repeatable workflow is to summarize merged PRs.",
    ]);
    expect(request?.context.attachments).toEqual([
      {
        id: "attachment_1",
        name: "release-notes.txt",
        mediaType: "text/plain",
        ref: "chat-attachment:attachment_1",
      },
    ]);
    expect(request?.context.apps).toEqual([
      {
        id: "github",
        name: "GitHub",
        connectionId: null,
        required: true,
      },
    ]);
    expect(request?.context.tools).toEqual([
      {
        name: "github.search_pull_requests",
        inputSummary: "Search merged pull requests",
        outputSummary: "Found 4 merged PRs.",
        artifactRefs: ["artifact://pr-list", "trace://github/run_1"],
        sideEffects: ["action completed"],
      },
    ]);
    const snapshot = buildInitialCreatePipelineSnapshot(request!);
    expect(snapshot.workflowCapture?.profileActions).toEqual(["github.search_pull_requests"]);
    expect(snapshot.workflowCapture?.externalProviders).toEqual(["GitHub", "github"]);
    expect(snapshot.workflowCapture?.sideEffects).toEqual(["action completed"]);
    expect(snapshot.workflowCapture?.files).toEqual([
      "release-notes.txt (chat-attachment:attachment_1)",
    ]);
    expect(snapshot.workflowCapture?.outputArtifacts).toEqual([
      "artifact://pr-list",
      "trace://github/run_1",
    ]);
    expect(snapshot.workflowCapture?.traceRefs).toEqual(["trace://github/run_1"]);
    expect(snapshot.plan?.requirements).toContainEqual(
      expect.objectContaining({
        kind: "target_project",
        name: "Cloud Project",
      }),
    );
    expect(snapshot.plan?.requirements).toContainEqual(
      expect.objectContaining({
        kind: "integration",
        name: "GitHub",
        status: "required",
        metadata: expect.objectContaining({ appId: "github" }),
      }),
    );
    expect(snapshot.plan?.requirements.some((requirement) => requirement.name === "github")).toBe(false);

    const parsedEdit = parseComposerSlashCommandPrompt("/edit tighten responses");
    expect(parsedEdit).not.toBeNull();
    expect(buildComposerCreatePipelineRequest({
      parsed: parsedEdit!,
      prompt: "/edit tighten responses",
      payload: {
        account: {
          activeProfile: { handle: "sam" },
          label: "Sam",
        },
        preferences: { defaultTeamId: "team_1" },
        profile: {
          mode: "local",
          activeProfile: "default",
          repoPath: "/profiles/default-repo",
          sourcePath: "/profiles/default-repo/profiles/default",
          git: { head: "abc123" },
        },
      } as BootstrapPayload,
      session: session({ appId: null, appName: null }),
    })).toBeNull();

    const editRequest = buildComposerCreatePipelineRequest({
      parsed: parsedEdit!,
      prompt: "/edit tighten responses",
      payload: {
        account: {
          activeProfile: { handle: "sam" },
          label: "Sam",
        },
        preferences: { defaultTeamId: "team_1" },
        profile: {
          mode: "local",
          activeProfile: "default",
          repoPath: "/profiles/default-repo",
          sourcePath: "/profiles/default-repo/profiles/default",
          git: { head: "abc123" },
        },
      } as BootstrapPayload,
      session: session({ appId: "agent_1", appName: "Agent One" }),
    });
    expect(editRequest?.operation).toBe("edit");
    expect(editRequest?.targetAgent.agentId).toBe("agent_1");
    expect(editRequest?.targetAgent.defaultActionKey).toBe("agent_1.chat");
  });

  test("does not synthesize support-specific create questions from the objective", () => {
    const parsed = parseComposerSlashCommandPrompt("/create Help me keep track of open customer support items.");
    expect(parsed).not.toBeNull();
    const request = buildComposerCreatePipelineRequest({
      parsed: parsed!,
      prompt: "/create Help me keep track of open customer support items.",
      payload: {
        account: {
          activeProfile: { handle: "sam" },
          label: "Sam",
        },
        preferences: { defaultTeamId: "team_1" },
        profile: {
          mode: "local",
          activeProfile: "default",
          repoPath: "/profiles/default-repo",
          sourcePath: "/profiles/default-repo/profiles/default",
          git: { head: "abc123" },
        },
      } as BootstrapPayload,
      session: session({ id: "session_support_create", cwd: null }),
      messages: [],
      attachments: [],
      apps: [],
    });
    expect(request).not.toBeNull();
    const snapshot = buildInitialCreatePipelineSnapshot(request!);

    expect(snapshot.state).toBe("awaiting_plan_approval");
    expect(snapshot.plan?.approvalId).toBeTruthy();
    expect(snapshot.approvalIds).toEqual([snapshot.plan?.approvalId]);
    expect(snapshot.questions).toEqual([]);

    const planHtml = renderToStaticMarkup(
      createElement(ComposerCreatePipelineStrip, {
        runtime: {
          turnId: "turn_1",
          request: request!,
          snapshot,
          onApprove: async () => undefined,
          onCancel: async () => undefined,
          onRevise: async () => undefined,
        },
      }),
    );
    expect(planHtml).toContain("Create plan");
    expect(planHtml).toContain("Chat only");
    expect(planHtml).toContain("Confirm plan");
    expect(planHtml).not.toContain("Details");
    expect(planHtml).toContain("agents/help-me-keep-track-of-open-customer-support-item");

    const ready = {
      ...snapshot,
      state: "ready_local" as const,
      sourceRefs: [
        "profiles/default/agents/help-me-keep-track-of-open-customer-support-item",
        "profiles/default/settings/profile.yaml",
      ],
      checkRefs: [
        "profiles/default/agents/help-me-keep-track-of-open-customer-support-item/.openpond/agent-inspect.json",
        "profiles/default/agents/help-me-keep-track-of-open-customer-support-item/.openpond/eval-results.json",
      ],
    };
    const readyHtml = renderToStaticMarkup(
      createElement(ComposerCreatePipelineStrip, {
        runtime: {
          turnId: "turn_1",
          request: request!,
          snapshot: ready,
        },
      }),
    );
    expect(readyHtml).toContain("Ready locally");
    expect(readyHtml).toContain("Chat only");
    expect(readyHtml).toContain("profiles/default/agents/help-me-keep-track-of-open-customer-support-item");
    expect(readyHtml).toContain("2 check refs");
    expect(readyHtml).toContain(".openpond/agent-inspect.json");
    expect(readyHtml).toContain(".openpond/eval-results.json");

    const detailsSnapshot: CreatePipelineSnapshot = {
      ...ready,
      plan: {
        ...ready.plan!,
        requirements: [
          {
            kind: "integration",
            name: "committed-support-fixtures",
            status: "declared",
            detail: "Use local committed fixtures for the desktop proof.",
            metadata: {},
          },
        ],
      },
    };
    const detailsHtml = renderToStaticMarkup(
      createElement(GoalDetailsView, {
        createRuntime: {
          turnId: "turn_1",
          request: request!,
          snapshot: detailsSnapshot,
        },
        goalRuntime: null,
      }),
    );
    expect(detailsHtml).toContain("Create Plan Details");
    expect(detailsHtml).toContain("Create State");
    expect(detailsHtml).toContain("Help me keep track of open customer support items.");
    expect(detailsHtml).toContain("Action Shape");
    expect(detailsHtml).toContain("Chat only");
    expect(detailsHtml).toContain("Setup Requirements");
    expect(detailsHtml).toContain("committed-support-fixtures");
    expect(detailsHtml).toContain("Source Plan");
    expect(detailsHtml).toContain("Checks");
    expect(detailsHtml).toContain("Run Refs");
    expect(detailsHtml).toContain("profiles/default/agents/help-me-keep-track-of-open-customer-support-item");
    expect(detailsHtml).toContain("Show structured payload");
  });

  test("renders Goal tracking inside the existing right sidebar before Files", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceDiffTabs, {
        addMenuOpen: false,
        expanded: false,
        filteredFiles: [],
        dirtyFilePaths: new Set<string>(),
        openFiles: [],
        goalDetailsAvailable: true,
        searchOpen: false,
        searchQuery: "",
        selectedPath: null,
        visibleTab: "goal",
        onCloseFileTab: () => undefined,
        onCloseSearch: () => undefined,
        onOpenFile: () => undefined,
        onOpenBrowser: () => undefined,
        onOpenSearch: () => undefined,
        onSearchQueryChange: () => undefined,
        onSelectFile: () => undefined,
        onSelectFiles: () => undefined,
        onSelectGoal: () => undefined,
        onToggleAddMenu: () => undefined,
        onToggleExpanded: () => undefined,
      }),
    );

    expect(html).toContain("Right sidebar views");
    expect(html).toContain(">Goal</span>");
    expect(html).toContain(">Files</span>");
    expect(html).not.toContain(">Summary</span>");
    expect(html).not.toContain(">Changes</span>");
    expect(html.indexOf(">Goal</span>")).toBeLessThan(html.indexOf(">Files</span>"));
  });

  test("renders New chat in the right sidebar add menu when side chats are available", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceDiffTabs, {
        addMenuOpen: true,
        expanded: false,
        filteredFiles: [],
        dirtyFilePaths: new Set<string>(),
        openFiles: [],
        goalDetailsAvailable: false,
        searchOpen: false,
        searchQuery: "",
        selectedPath: null,
        visibleTab: "files",
        onCloseFileTab: () => undefined,
        onCloseSearch: () => undefined,
        onOpenFile: () => undefined,
        onOpenBrowser: () => undefined,
        onOpenSearch: () => undefined,
        onOpenSideChat: () => undefined,
        onSearchQueryChange: () => undefined,
        onSelectFile: () => undefined,
        onSelectFiles: () => undefined,
        onSelectGoal: () => undefined,
        onToggleAddMenu: () => undefined,
        onToggleExpanded: () => undefined,
      }),
    );

    expect(html).toContain(">New task</span>");
    expect(html).toContain(">Files</span>");
    expect(html).toContain(">Open file</span>");
    expect(html).toContain(">Browser</span>");
    expect(html).not.toContain(">Changes</span>");
    expect(html).not.toContain(">Review</span>");
    const menuFilesIndex = html.lastIndexOf(">Files</span>");
    expect(html.indexOf(">New task</span>")).toBeLessThan(menuFilesIndex);
    expect(menuFilesIndex).toBeLessThan(html.indexOf(">Open file</span>"));
    expect(html.indexOf(">Open file</span>")).toBeLessThan(html.indexOf(">Browser</span>"));
  });

  test("renders open side-chat titles in the right sidebar tab row", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceDiffTabs, {
        addMenuOpen: false,
        expanded: false,
        filteredFiles: [],
        dirtyFilePaths: new Set<string>(),
        openFiles: [],
        goalDetailsAvailable: false,
        searchOpen: false,
        searchQuery: "",
        selectedPath: null,
        sideChatTabs: [{ id: "right-chat-1", title: "New chat" }],
        visibleTab: "files",
        onCloseFileTab: () => undefined,
        onCloseSearch: () => undefined,
        onCloseSideChat: () => undefined,
        onOpenFile: () => undefined,
        onOpenBrowser: () => undefined,
        onOpenSearch: () => undefined,
        onOpenSideChat: () => undefined,
        onSearchQueryChange: () => undefined,
        onSelectFile: () => undefined,
        onSelectFiles: () => undefined,
        onSelectGoal: () => undefined,
        onSelectSideChat: () => undefined,
        onToggleAddMenu: () => undefined,
        onToggleExpanded: () => undefined,
      }),
    );

    expect(html).toContain("right-chat-tab");
    expect(html).toContain(">New chat</span>");
    expect(html).toContain("aria-label=\"Close New chat\"");
    expect(html.indexOf(">Files</span>")).toBeLessThan(html.indexOf(">New chat</span>"));
    expect(html).not.toContain(">Review</span>");
  });

  test("keeps create pipeline commands local when a local profile is active", () => {
    const createCommand = parseComposerSlashCommandPrompt("/create smoke agent");
    const goalCommand = parseComposerSlashCommandPrompt("/goal-local smoke goal");
    expect(createCommand).not.toBeNull();
    expect(goalCommand).not.toBeNull();
    const localProfile = {
      mode: "local",
      activeProfile: "default",
      repoPath: "/profiles/default-repo",
      sourcePath: "/profiles/default-repo/profiles/default",
      git: { head: "abc123" },
    } as BootstrapPayload["profile"];

    expect(
      shouldRunCreatePipelineCommandLocally({
        command: createCommand!,
        profile: localProfile,
        activeWorkspaceKind: "local_project",
        view: "chat",
      }),
    ).toBe(true);
    expect(
      shouldRunCreatePipelineCommandLocally({
        command: createCommand!,
        profile: localProfile,
        activeWorkspaceKind: null,
        view: "chat",
      }),
    ).toBe(true);
    expect(
      shouldRunCreatePipelineCommandLocally({
        command: createCommand!,
        profile: localProfile,
        activeWorkspaceKind: "sandbox",
        view: "chat",
      }),
    ).toBe(false);
    expect(
      shouldRunCreatePipelineCommandLocally({
        command: createCommand!,
        profile: localProfile,
        activeWorkspaceKind: "local_project",
        view: "cloud",
      }),
    ).toBe(false);
    expect(
      shouldRunCreatePipelineCommandLocally({
        command: createCommand!,
        profile: {
          mode: "hosted",
          activeProfile: "default",
          hosted: { sourceRef: "main", sourceCommitSha: "hosted_sha" },
        } as BootstrapPayload["profile"],
        activeWorkspaceKind: "local_project",
        view: "chat",
      }),
    ).toBe(false);
    expect(
      shouldRunCreatePipelineCommandLocally({
        command: goalCommand!,
        profile: localProfile,
        activeWorkspaceKind: "local_project",
        view: "chat",
      }),
    ).toBe(false);
  });

  test("keeps direct sandbox chats on the standard right sidebar with a summary tab", () => {
    expect(sandboxIdFromWorkspaceName("nas6d9khcmppt1sxvve1i7iu")).toBe("nas6d9khcmppt1sxvve1i7iu");
    expect(sandboxIdFromWorkspaceName("H-16 X metadata-only sandbox proof")).toBeNull();

    const html = renderToStaticMarkup(
      createElement(WorkspaceDiffTabs, {
        addMenuOpen: false,
        expanded: false,
        filteredFiles: [],
        dirtyFilePaths: new Set<string>(),
        openFiles: [],
        goalDetailsAvailable: false,
        searchOpen: false,
        searchQuery: "",
        selectedPath: null,
        summaryAvailable: true,
        visibleTab: "summary",
        onCloseFileTab: () => undefined,
        onCloseSearch: () => undefined,
        onOpenFile: () => undefined,
        onOpenBrowser: () => undefined,
        onOpenSearch: () => undefined,
        onSearchQueryChange: () => undefined,
        onSelectFile: () => undefined,
        onSelectFiles: () => undefined,
        onSelectGoal: () => undefined,
        onSelectSummary: () => undefined,
        onToggleAddMenu: () => undefined,
        onToggleExpanded: () => undefined,
      }),
    );

    expect(html).toContain(">Summary</span>");
    expect(html).toContain(">Files</span>");
    expect(html.indexOf(">Summary</span>")).toBeLessThan(html.indexOf(">Files</span>"));
  });

  test("builds hosted create pipeline envelopes for Cloud work items", () => {
    const payload = {
      account: {
        activeProfile: { handle: "sam" },
        label: "Sam",
      },
      preferences: { defaultTeamId: "team_1" },
      profile: {
        mode: "local",
        activeProfile: "default",
        hosted: {
          sourceRef: "profile-main",
          sourceCommitSha: "profile_sha",
        },
      },
    } as BootstrapPayload;
    const request = buildHostedCloudWorkCreatePipelineRequest({
      command: "create",
      objective: "Create a hosted release notes agent",
      payload,
      project: cloudProject(),
      source: "cloud_work_home",
    });

    expect(request?.surface).toBe("hosted_create");
    expect(request?.adapter.kind).toBe("hosted");
    expect(request?.adapter.sourceAuthority).toBe("hosted_profile");
    expect(request?.adapter.sourceRef).toBe("profile-main");
    expect(request?.scope.targetProject?.name).toBe("Cloud Project");
    const snapshot = buildInitialCreatePipelineSnapshot(request!);
    expect(snapshot.state).toBe("awaiting_plan_approval");
    expect(snapshot.plan?.status).toBe("pending_approval");
    expect(snapshot.plan?.approvalId).toBeTruthy();
    expect(snapshot.approvalIds).toEqual([snapshot.plan?.approvalId]);
    expect(snapshot.plan?.sourcePlan.map((item) => item.path)).toContain(
      "agents/create-a-hosted-release-notes-agent",
    );
    expect(snapshot.workflowCapture?.targetRepoAssumptions).toEqual([
      "cloud project: openpond/cloud-project",
    ]);
    const approved = approveCreatePipelineSnapshot(snapshot);
    expect(approved.state).toBe("applying_source");
    expect(approved.plan?.status).toBe("approved");
    expect(reviseCreatePipelineSnapshot(approved, "Change after approval")).toEqual(approved);
    const revised = reviseCreatePipelineSnapshot(snapshot, "Prefer concise bullet summaries.");
    expect(revised.state).toBe("awaiting_plan_approval");
    expect(revised.plan?.status).toBe("pending_approval");
    expect(revised.plan?.id).not.toBe(snapshot.plan?.id);
    expect(revised.plan?.editedFromPlanId).toBe(snapshot.plan?.id);
    expect(revised.plan?.approvalId).toBe(snapshot.plan?.approvalId);
    expect(revised.approvalIds).toEqual(snapshot.approvalIds);
    expect(revised.plan?.summary).toContain("Prefer concise bullet summaries.");
    const cancelled = cancelCreatePipelineSnapshot(snapshot);
    expect(cancelled.state).toBe("blocked");
    expect(cancelled.plan?.status).toBe("cancelled");
    expect(cancelled.blockedReason).toContain("Cancelled");

    expect(buildHostedCloudWorkCreatePipelineRequest({
      command: "edit",
      objective: "Tighten hosted release notes",
      payload,
      project: cloudProject(),
      source: "cloud_work_home",
    })).toBeNull();

    const editRequest = buildHostedCloudWorkCreatePipelineRequest({
      command: "edit",
      objective: "Tighten hosted release notes",
      payload,
      project: cloudProject(),
      workItem: {
        id: "work_item_1",
        teamId: "team_1",
        projectId: "cloud_project_1",
        conversationId: "conversation_1",
        title: "Release notes agent",
        status: "needs_review",
        sourceRef: "profile-main",
        baseSha: "profile_sha",
        latestRuntimeId: null,
        latestSandboxId: null,
        latestTaskRunId: null,
        assignedAgentId: "agent_1",
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
        metadata: {},
      },
      source: "cloud_work_thread",
    });
    expect(editRequest?.surface).toBe("hosted_edit");
    expect(editRequest?.targetAgent.agentId).toBe("agent_1");
    expect(editRequest?.targetAgent.defaultActionKey).toBe("agent_1.chat");
  });

  test("discovers flat project actions from composer slash input", () => {
    const actions = [
      action({
        id: "chat",
        label: "Chat",
        implementation: { type: "chat" },
      }),
      action({
        id: "water.estimate",
        label: "Run Water Estimate",
        description: "Estimate drawing plan usage.",
        implementation: { type: "agent" },
      }),
      action({
        id: "build.report",
        label: "Build Report",
        implementation: { type: "workflow" },
      }),
    ];

    expect(composerActionSlashQuery("hello")).toBeNull();
    expect(composerActionSlashQuery("/ Water")).toBe("water");
    expect(
      composerActionCatalogMatches({ actions, prompt: "/estimate" }).map(
        (item) => item.id,
      ),
    ).toEqual(["water.estimate"]);
    expect(
      composerActionCatalogMatches({ actions, prompt: "/workflow" }).map(
        (item) => item.id,
      ),
    ).toEqual(["build.report"]);
    expect(
      composerActionCatalogMatches({ actions, prompt: "/" }).map((item) => item.id),
    ).toEqual(["chat", "water.estimate", "build.report"]);
  });

  test("detects ready local Create pipelines for profile catalog refresh", () => {
    const ignoredBlocked = runtimeEvent({
      id: "event_blocked",
      sessionId: "session_1",
      turnId: "turn_1",
      name: "create_pipeline.updated",
      source: "server",
      status: "failed",
      data: {
        createPipelineRequest: { adapter: { kind: "local" } },
        createPipeline: {
          id: "create_pipeline_blocked",
          state: "blocked",
        },
      },
    });
    const ignoredHosted = runtimeEvent({
      id: "event_hosted",
      sessionId: "session_1",
      turnId: "turn_1",
      name: "create_pipeline.updated",
      source: "server",
      status: "completed",
      data: {
        createPipelineRequest: { adapter: { kind: "hosted" } },
        createPipeline: {
          id: "create_pipeline_hosted",
          state: "ready_local",
        },
      },
    });
    const readyLocal = runtimeEvent({
      id: "event_ready",
      sessionId: "session_2",
      turnId: "turn_2",
      name: "create_pipeline.updated",
      source: "server",
      status: "completed",
      data: {
        createPipelineRequest: { adapter: { kind: "local" } },
        createPipeline: {
          id: "create_pipeline_ready",
          state: "ready_local",
        },
      },
    });

    expect(
      latestReadyLocalCreatePipelineProfileRefreshKey([ignoredBlocked, ignoredHosted]),
    ).toBeNull();
    expect(
      latestReadyLocalCreatePipelineProfileRefreshKey([
        ignoredBlocked,
        readyLocal,
        ignoredHosted,
      ]),
    ).toBe("session_2:turn_2:create_pipeline_ready");
  });

  test("builds direct action run payloads with selected slash metadata", () => {
    const attachment: ChatAttachment = {
      id: "attachment_1",
      name: "plan.pdf",
      mediaType: "application/pdf",
      sizeBytes: 42,
      kind: "file",
      contentsBase64: "cGxhbg==",
    };

    expect(
      buildOpenPondAppActionRunInput({
        action: action({
          id: "water.estimate",
          label: "Run Water Estimate",
          implementation: { type: "agent" },
        }),
        attachments: [attachment],
        prompt: "Estimate this plan",
        teamId: "team_1",
      }),
    ).toEqual({
      teamId: "team_1",
      triggerType: "manual",
      entrypoint: { scope: "action", name: "water.estimate" },
      input: {
        prompt: "Estimate this plan",
        message: "Estimate this plan",
        actionName: "water.estimate",
        source: "openpond_app",
        attachments: [attachment],
      },
      metadata: {
        source: "openpond_app",
        selectedActionId: "water.estimate",
        selectedActionLabel: "Run Water Estimate",
        selectedBy: "slash",
      },
    });
  });

  test("builds direct agent run payloads with the visible @agent prompt", () => {
    expect(
      buildOpenPondAgentRunInput({
        agent: {
          agentId: "sales-demo",
          agentName: "Sales Demo",
          teamId: "team_1",
          projectId: "project_1",
          projectName: "Revenue Workspace",
          selectedEntrypoint: { scope: "entire_manifest", name: null },
          workflowMode: "feature",
        },
        displayPrompt: "@sales-demo Summarize top salesmen",
        prompt: "Summarize top salesmen",
      }),
    ).toEqual({
      teamId: "team_1",
      triggerType: "manual",
      entrypoint: { scope: "entire_manifest", name: null },
      input: {
        prompt: "Summarize top salesmen",
        message: "Summarize top salesmen",
        source: "openpond_app",
      },
      metadata: {
        source: "openpond_app",
        selectedAgentId: "sales-demo",
        selectedAgentName: "Sales Demo",
        selectedActionId: "agent:sales-demo",
        selectedActionLabel: "Sales Demo",
        selectedBy: "mention",
        displayPrompt: "@sales-demo Summarize top salesmen",
      },
      workflowMode: "feature",
    });
  });

  test("keeps profile action input clean while carrying the visible mention prompt", () => {
    expect(
      buildOpenPondProfileActionRunInput({
        action: {
          actionId: "business-ops-router.chat",
          actionLabel: "Business Ops Router",
        },
        prompt: "Which support items need attention?",
        displayPrompt: "@business Which support items need attention?",
        sessionId: "session_1",
      }),
    ).toEqual({
      action: "business-ops-router.chat",
      input: {
        prompt: "Which support items need attention?",
        message: "Which support items need attention?",
        source: "openpond_app",
      },
      metadata: {
        source: "openpond_app",
        selectedActionId: "business-ops-router.chat",
        selectedActionLabel: "Business Ops Router",
        selectedBy: "mention",
        displayPrompt: "@business Which support items need attention?",
        sessionId: "session_1",
      },
    });
  });

  test("keeps Cloud work sessions out of project grouping without hiding standalone chats", () => {
    const projects = [localProject()];
    const localIds = new Set(projects.map((project) => project.id));
    const projectPathIndex = buildSidebarProjectPathIndex(projects);
    const cloudIds = new Set(["cloud_project_1"]);

    expect(isSidebarCloudWorkSession(session(), cloudIds)).toBe(true);
    expect(
      sidebarProjectKeyForSession(
        session(),
        localIds,
        projectPathIndex,
        cloudIds,
      ),
    ).toBeNull();
    expect(
      sidebarProjectKeyForSession(
        session({
          id: "standalone_chat",
          workspaceKind: "local",
          workspaceId: null,
          workspaceName: null,
          cloudProjectId: null,
          cloudTeamId: null,
          title: "Standalone chat",
        }),
        localIds,
        projectPathIndex,
        cloudIds,
      ),
    ).toBeNull();
    expect(
      sidebarProjectKeyForSession(
        session({
          id: "codex_local",
          provider: "codex",
          workspaceKind: undefined,
          workspaceId: null,
          workspaceName: null,
          cloudProjectId: null,
          cloudTeamId: null,
          cwd: "/workspace/local-project/src",
        }),
        localIds,
        projectPathIndex,
        cloudIds,
      ),
    ).toBe(projectSelectionKey("local", "local_project_1"));
  });

  test("projects and renders OpenPond action run cards in the message timeline", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        sessionId: "session_1",
        turnId: "turn_1",
        name: "turn.started",
        args: { prompt: "Estimate this plan" },
      }),
      runtimeEvent({
        id: "action_started",
        sessionId: "session_1",
        turnId: "turn_1",
        name: "workspace_action",
        source: "chat_action",
        action: "sandbox_run_action",
        status: "started",
        args: {
          actionName: "water.estimate",
          projectId: "cloud_project_1",
          agentId: "agent_1",
        },
      }),
      runtimeEvent({
        id: "action_done",
        sessionId: "session_1",
        turnId: "turn_1",
        name: "workspace_action_result",
        source: "chat_action",
        action: "sandbox_run_action",
        status: "completed",
        output: "Action water.estimate completed",
        data: {
          action: {
            name: "water.estimate",
            label: "Run Water Estimate",
            implementation: { type: "agent" },
            artifactRefs: ["artifacts/estimate.json"],
          },
          run: {
            id: "agent_run_1",
            projectId: "cloud_project_1",
            agentId: "agent_1",
            sandboxId: "sandbox_1",
            runtimeId: "runtime_1",
            status: "succeeded",
            metadata: {
              sourceSummary: {
                sourceRef: "refs/heads/main",
                manifestHash: "manifest_hash_1",
              },
            },
          },
          responseSummary: {
            status: "available",
            text: "Estimated 42 fixture units.",
            artifactRefs: ["artifacts/report.md"],
          },
          traceSummary: {
            artifactRefs: ["artifacts/trace.jsonl"],
          },
          evalSummary: {
            artifactRefs: ["artifacts/eval.json"],
          },
          childCalls: [
            {
              id: "child_1",
              label: "Parse fixtures",
              status: "completed",
              runId: "child_run_1",
            },
          ],
        },
      }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]?.actionRun).toMatchObject({
      actionName: "water.estimate",
      title: "Run Water Estimate",
      status: "completed",
      responseText: "Estimated 42 fixture units.",
      runId: "agent_run_1",
      sandboxId: "sandbox_1",
      runtimeId: "runtime_1",
      sourceRef: "refs/heads/main",
      manifestHash: "manifest_hash_1",
    });
    expect(messages[1]?.actionRun?.refs.map((ref) => ref.target)).toEqual([
      "artifacts/estimate.json",
      "artifacts/report.md",
      "artifacts/trace.jsonl",
      "artifacts/eval.json",
      "refs/heads/main",
    ]);
    expect(messages[1]?.actionRun?.childCalls).toEqual([
      {
        id: "child_1",
        label: "Parse fixtures",
        status: "completed",
        detail: "child_run_1",
      },
    ]);

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[1]!,
      }),
    );
    expect(html).toContain("Run Water Estimate");
    expect(html).toContain("Estimated 42 fixture units.");
    expect(html).toContain("artifacts/trace.jsonl");
    expect(html).toContain("artifacts/eval.json");
    expect(html).toContain("Parse fixtures");
  });

  test("renders create pipeline receipts in chat messages without duplicate approval controls", () => {
    const parsed = parseComposerSlashCommandPrompt("/create release notes agent");
    const request = buildComposerCreatePipelineRequest({
      parsed: parsed!,
      prompt: "/create release notes agent",
      payload: {
        account: {
          activeProfile: { handle: "sam" },
          label: "Sam",
        },
        preferences: { defaultTeamId: "team_1" },
        profile: {
          mode: "local",
          activeProfile: "default",
          repoPath: "/profiles/default-repo",
          sourcePath: "/profiles/default-repo/profiles/default",
          git: { head: "abc123" },
        },
      } as BootstrapPayload,
      session: session({ id: "session_create", cwd: "/workspace/app" }),
      messages: [
        {
          id: "message_1",
          role: "user",
          content: "Use GitHub merged pull requests as the workflow input.",
          timestamp,
        },
        {
          id: "message_action_1",
          role: "activity_group",
          timestamp,
          actionRun: {
            actionName: "github.search_pull_requests",
            title: "Search merged pull requests",
            status: "completed",
            responseText: "Found 4 merged PRs.",
            runId: "run_1",
            projectId: "cloud_project_1",
            agentId: null,
            sandboxId: null,
            runtimeId: null,
            implementationType: "mcp",
            sourceRef: null,
            manifestHash: null,
            refs: [
              {
                id: "artifact_1",
                kind: "artifact",
                label: "PR list",
                target: "artifact://pr-list",
              },
            ],
            childCalls: [],
          },
        },
      ],
      apps: [
        {
          id: "github",
          name: "GitHub",
          description: null,
          iconUrl: null,
          connected: true,
          enabled: true,
          pinned: false,
          archived: false,
          sortOrder: null,
          tags: [],
          sandbox: null,
          source: "builtin",
        } as OpenPondApp,
      ],
    });
    const requestWithActionShape = {
      ...request!,
      metadata: {
        ...request!.metadata,
        actionShape: {
          mode: "chat_and_direct_actions",
          label: "Chat plus direct action",
          detail: "Expose a default chat route and a repeatable direct action when the generated source has a tool-like run.",
          defaultActionKey: request!.targetAgent.defaultActionKey ?? "chat",
          directActionHint: "Create a direct action only for the repeatable tool-like behavior.",
          artifactPolicy: "Persist trace and run summary; declare output artifacts when the direct action produces files.",
        } as const,
      },
    };
    const snapshot = buildInitialCreatePipelineSnapshot(requestWithActionShape);
    expect(snapshot.plan?.approvalId).toBeTruthy();
    expect(snapshot.approvalIds).toEqual([snapshot.plan?.approvalId]);
    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: {
          id: "message_plan_1",
          role: "assistant",
          timestamp,
          turnId: "turn_1",
          createPipelineRequest: requestWithActionShape,
          createPipeline: snapshot,
        },
      }),
    );

    expect(html).toContain("Create status");
    expect(html).toContain("Create plan ready");
    expect(html).toContain("Create a source-backed profile agent");
    expect(html).toContain("Chat plus direct action");
    expect(html).toContain("agents/release-notes-agent");
    expect(html).toContain("4 checks");
    expect(html).not.toContain("Show progress");
    expect(html).not.toContain("Agent plan review");
    expect(html).not.toContain("Debug details");
    expect(html).not.toContain("Confirm plan");
    expect(html).not.toContain("Edit plan");
    expect(html).not.toContain("Cancel");
  });

  test("hides generic approval cards for create plan approvals", () => {
    const approval: Approval = {
      id: "approval-create-plan",
      sessionId: "session_1",
      turnId: "turn_1",
      providerRequestId: "approval-create-plan",
      kind: "create_plan",
      title: "Approve create plan",
      detail: "Plan details",
      status: "pending",
      createdAt: timestamp,
    };
    const html = renderToStaticMarkup(
      createElement(ApprovalRequestCard, {
        approval,
        onResolve: async () => undefined,
      }),
    );
    expect(html).toBe("");
  });

  test("renders subagent patch approvals without session approval", () => {
    const approval: Approval = {
      id: "approval-subagent-patch",
      sessionId: "session_1",
      turnId: "turn_1",
      providerRequestId: "run_1",
      kind: "subagent_patch_apply",
      title: "Apply coding subagent patch",
      detail: JSON.stringify({ patchPath: "/tmp/openpond-subagents/run/handoff.patch" }),
      status: "pending",
      createdAt: timestamp,
    };
    const html = renderToStaticMarkup(
      createElement(ApprovalRequestCard, {
        approval,
        onResolve: async () => undefined,
      }),
    );
    expect(html).toContain("Subagent patch");
    expect(html).toContain("Apply coding subagent patch");
    expect(html).not.toContain(">Session</span>");
  });
});
