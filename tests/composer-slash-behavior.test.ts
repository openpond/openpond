import { describe, expect, test } from "bun:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CloudProject, LocalProject, OpenPondApp } from "@openpond/contracts";

import { CloudWorkView } from "../apps/web/src/components/cloud/CloudWorkView";
import {
  Composer,
  promptWithSelectedInvocationText,
  type ComposerProjectTargetState,
} from "../apps/web/src/components/chat/Composer";
import { SubmitIssueDialog } from "../apps/web/src/components/chat/SubmitIssueDialog";
import { workspaceTargetOptionStatusText } from "../apps/web/src/components/chat/ComposerControls";
import { ComposerInvocationPill } from "../apps/web/src/components/chat/ComposerInvocationPill";
import { ComposerPrimaryControls } from "../apps/web/src/components/chat/ComposerPrimaryControls";
import type { ContextWindowStatus } from "../apps/web/src/lib/context-window";
import { buildOpenPondAgentSlashCommand } from "../apps/web/src/lib/openpond-action-run";
import { openPondActionProjectTarget } from "../apps/web/src/lib/openpond-action-project";
import type { SandboxAgent } from "../apps/web/src/lib/sandbox-types";
import type { WorkspaceTargetState } from "../apps/web/src/lib/workspace-location";

const noop = () => undefined;
const NOW = "2026-06-23T00:00:00.000Z";

const contextWindowStatus: ContextWindowStatus = {
  usedTokens: 0,
  maxTokens: null,
  percent: null,
  summary: "Not measured yet",
  tokensLabel: "Hosted context",
  detail: "Send a message to measure hosted context.",
  tooltip: "Context window: Send a message to measure hosted context.",
  tone: "unknown",
};

const projectTarget: ComposerProjectTargetState = {
  value: "local:project_1",
  label: "Local Project",
  detail: "/workspace/local-project",
  busy: false,
  options: [
    {
      value: "local:project_1",
      label: "Local Project",
      detail: "/workspace/local-project",
      kind: "local",
    },
    {
      value: "none",
      label: "Don't work in a project",
      detail: "General chat without project files",
      kind: "none",
    },
  ],
};

const workspaceTarget: WorkspaceTargetState = {
  value: "local",
  label: "Local checkout",
  detail: "main / synced",
  busy: false,
  action: {
    value: "cloud",
    label: "Cloud workspace",
    detail: "Use cloud workspace",
    disabled: false,
  },
  uploadAction: {
    value: "upload_cloud",
    label: "Upload/sync to cloud",
    detail: "Push local source to OpenPond Git.",
    stateNote: "nothing to upload",
    disabled: false,
  },
  options: [
    {
      value: "local",
      label: "Local checkout",
      detail: "Use files on this machine.",
      stateNote: "main / synced",
      disabled: false,
    },
    {
      value: "queue_cloud",
      label: "Queue cloud work item",
      detail: "Run the next task in a hosted sandbox.",
      stateNote: "will use main / setup ready",
      disabled: false,
    },
    {
      value: "cloud",
      label: "Cloud workspace",
      detail: "Chat inside the hosted sandbox.",
      stateNote: "main / setup ready",
      disabled: false,
    },
  ],
};

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

function sandboxAgent(overrides: Partial<SandboxAgent> = {}): SandboxAgent {
  return {
    id: "agent_1",
    teamId: "team_1",
    createdByUserId: "user_1",
    name: "Review Bot",
    slug: "review-bot",
    description: "Reviews project changes.",
    status: "active",
    projectId: "cloud_project_1",
    workflowIntent: "code_change",
    selectedEntrypoint: {
      scope: "entire_manifest",
      name: null,
    },
    triggerType: "manual",
    endpointPolicy: {},
    backgroundTaskPolicy: {},
    defaultWorkflowMode: "feature",
    defaultBranch: "main",
    sourceRefOverride: null,
    defaultPromotionPolicy: "manual",
    defaultResourcePolicy: {},
    defaultLifecyclePolicy: {},
    defaultCheckpointPolicy: {},
    requiredIntegrationRefs: [],
    requiredEnvironmentVariableRefs: [],
    schedulePolicy: {},
    externalId: null,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function planningApp(overrides: Partial<OpenPondApp> = {}): OpenPondApp {
  return {
    id: "app_alpha",
    name: "Alpha Bot",
    description: "Summarizes release activity.",
    gitOwner: "openpond",
    gitRepo: "alpha-bot",
    gitHost: "github.com",
    sandbox: true,
    ...overrides,
  };
}

describe("composer slash behavior", () => {
  test("reconstructs selected mention text for the submitted display prompt", () => {
    expect(promptWithSelectedInvocationText("Which support items need attention?", "@business", 0)).toBe(
      "@business Which support items need attention?",
    );
    expect(promptWithSelectedInvocationText("Please check  today", "@business", 13)).toBe(
      "Please check @business today",
    );
  });

  test("renders selected commands as removable invocation pills without the slash", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerInvocationPill, {
        icon: createElement("span", { className: "test-command-icon", "aria-hidden": true }),
        label: "create",
        onRemove: noop,
      }),
    );

    expect(markup).toContain('class="composer-invocation-pill"');
    expect(markup).toContain('contentEditable="false"');
    expect(markup).toContain('data-inline-token="true"');
    expect(markup).toContain('class="composer-invocation-remove"');
    expect(markup).toContain("composer-invocation-clear");
    expect(markup).toContain(">create<");
    expect(markup).not.toContain("/create");
  });

  test("regular chat composer exposes a dedicated create button beside add context", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "start",
        prompt: "",
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus,
        goalRuntime: null,
        busy: false,
        running: false,
        connection: null,
        provider: "openpond",
        model: "openpond-chat",
        projectTarget,
        actionCatalog: [],
        workspaceTarget,
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
        onStop: noop,
      }),
    );

    expect(markup).toContain('aria-label="Add photos and files"');
    expect(markup).toContain('class="composer-create-control"');
    expect(markup).toContain('aria-label="Make Agent"');
    expect(markup).toMatch(
      /class="composer-create-control" aria-label="Make Agent"[^>]*><span>Make Agent<\/span><\/button>/,
    );
  });

  test("plus menu lists connected apps as planning context", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPrimaryControls, {
        addFiles: noop,
        addMenuOpen: true,
        addMenuRef: createRef<HTMLDivElement>(),
        busy: false,
        codexPermissionMode: "default",
        codexReasoningEffort: "medium",
        connection: null,
        contextStatusStyle: {
          "--context-fill": "0deg",
          "--context-bar-fill": "0%",
        },
        contextStatusTooltipId: "context-tooltip",
        contextWindowStatus,
        disabled: false,
        dropdownPlacement: "bottom",
        fileInputRef: createRef<HTMLInputElement>(),
        mentionApps: [planningApp()],
        modelValue: "openpond-chat",
        onCodexPermissionModeChange: noop,
        onCodexReasoningEffortChange: noop,
        onModelChange: noop,
        onCreateAsAgent: noop,
        onOpenFilePicker: noop,
        onPlanningAppSelect: noop,
        onProviderChange: noop,
        onQueueDraft: noop,
        onStop: noop,
        onToggleAddMenu: noop,
        onTranscript: noop,
        provider: "openpond",
        providerOptions: [{ value: "openpond", label: "OpenPond" }],
        queueDraftDisabled: true,
        queueDraftTooltip: "Queue steer draft",
        running: false,
        sendDisabled: false,
        sendTooltip: "Send",
        selectedMentionAppId: "app_alpha",
        showToast: noop,
        steering: false,
      }),
    );

    expect(markup).toContain('role="menu"');
    expect(markup).toContain("Create as agent");
    expect(markup).toContain('data-app-context-id="app_alpha"');
    expect(markup).toContain("Alpha Bot");
    expect(markup).toContain("Selected planning context");
  });

  test("regular chat composer renders contextual notices", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "start",
        prompt: "",
        composeNotice: {
          tone: "warning",
          message: "Provider setup is required before this action can run.",
        },
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus,
        goalRuntime: null,
        busy: false,
        running: false,
        connection: null,
        provider: "openpond",
        model: "openpond-chat",
        projectTarget,
        actionCatalog: [],
        workspaceTarget,
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
        onStop: noop,
      }),
    );

    expect(markup).toContain('class="composer-notice warning"');
    expect(markup).toContain("Provider setup is required before this action can run.");
  });

  test("resolves slash action target from a local project linked to Cloud", () => {
    expect(
      openPondActionProjectTarget({
        selectedCloudProject: null,
        selectedProject: localProject({
          linkedSandboxProject: {
            teamId: "team_1",
            projectId: "cloud_project_1",
            projectSlug: "cloud-repo",
            projectName: "Cloud Repo",
            sourceRepoUrl: null,
            defaultBranch: "main",
            manifestPath: null,
            manifestHash: null,
            syncedAt: NOW,
            linkedAt: NOW,
          },
        }),
      }),
    ).toEqual({
      id: "cloud_project_1",
      teamId: "team_1",
      name: "Cloud Repo",
      selectionKey: "cloud:cloud_project_1",
      localProjectId: "local_project_1",
    });
  });

  test("regular chat composer shows connected apps as slash planning context", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "start",
        prompt: "/alpha",
        mentionApps: [planningApp()],
        selectedMentionAppId: null,
        contextWindowStatus,
        goalRuntime: null,
        busy: false,
        running: false,
        connection: null,
        provider: "openpond",
        model: "openpond-chat",
        projectTarget,
        actionCatalog: [],
        workspaceTarget,
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
        onStop: noop,
      }),
    );

    expect(markup).toContain('data-app-context-id="app_alpha"');
    expect(markup).toContain("Alpha Bot");
    expect(markup).toContain("Planning context");
    expect(markup).not.toContain('data-inline-token="true"');
  });

  test("regular chat composer shows project action suggestions for slash input", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "start",
        prompt: "/estimate",
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus,
        goalRuntime: null,
        busy: false,
        running: false,
        connection: null,
        provider: "openpond",
        model: "openpond-chat",
        projectTarget,
        actionCatalog: [
          {
            id: "water.estimate",
            label: "Run Water Estimate",
            description: "Estimate water usage for the current project.",
            implementation: { type: "workflow" },
          },
        ],
        workspaceTarget,
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
        onStop: noop,
      }),
    );

    expect(markup).toContain('aria-label="OpenPond agents and actions"');
    expect(markup).toContain('aria-label="Working in"');
    expect(markup).toContain('aria-label="Upload/sync to cloud"');
    expect(markup).toContain("workspace-upload-trigger upload_cloud");
    expect(markup).toContain("Local checkout");
    expect(markup).not.toContain("Working in: Local checkout");
    expect(markup).not.toContain("<span>Move to Cloud</span>");
    expect(markup).not.toContain('data-tooltip="Provider"');
    expect(markup).toContain("Run Water Estimate");
    expect(markup).toContain("Estimate water usage for the current project.");
  });

  test("working target disabled options expose the concrete reason as row status text", () => {
    expect(
      workspaceTargetOptionStatusText({
        stateNote: "upload required",
        disabled: true,
        disabledReason: "Upload/sync this Project to Cloud before queueing work.",
      }),
    ).toBe("Upload/sync this Project to Cloud before queueing work.");

    expect(
      workspaceTargetOptionStatusText({
        stateNote: "main / synced",
        disabled: false,
      }),
    ).toBe("main / synced");
  });

  test("working target trigger remains inspectable while workspace state refreshes", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "start",
        prompt: "",
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus,
        goalRuntime: null,
        agents: [],
        projectAgents: [],
        projectTarget,
        workspaceTarget: { ...workspaceTarget, busy: true },
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
        onStop: noop,
      }),
    );

    expect(markup).toContain('aria-label="Working in"');
    expect(markup).toContain('aria-label="Upload/sync to cloud"');
    expect(markup).toContain("Local checkout");
    expect(markup).not.toContain("Working in: Local checkout");
    expect(markup).not.toMatch(/class="workspace-action-trigger[^"]*"[^>]* disabled=""/);
  });

  test("composer footer prompts for a project before showing workspace actions", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "start",
        prompt: "",
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus,
        goalRuntime: null,
        agents: [],
        projectAgents: [],
        projectTarget: {
          value: "none",
          label: "No project",
          detail: "General chat",
          busy: false,
          options: [
            {
              value: "none",
              label: "Don't work in a project",
              detail: "General chat without project files",
              kind: "none",
            },
          ],
        },
        workspaceTarget,
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
        onStop: noop,
      }),
    );

    expect(markup).toContain("Select Project");
    expect(markup).not.toContain('aria-label="Working in"');
    expect(markup).not.toContain('aria-label="Upload/sync to cloud"');
    expect(markup).not.toContain("workspace-upload-trigger");
  });

  test("working target trigger renders the hybrid target", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "start",
        prompt: "",
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus,
        goalRuntime: null,
        agents: [],
        projectAgents: [],
        projectTarget,
        workspaceTarget: {
          ...workspaceTarget,
          value: "hybrid",
          label: "Hybrid",
          detail: "main / setup ready",
        },
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
        onStop: noop,
      }),
    );

    expect(markup).toContain("Hybrid");
    expect(markup).not.toContain("Working in: Hybrid");
    expect(markup).toContain("workspace-action-trigger hybrid");
    expect(markup).toContain("workspace-target-hybrid-icon");
  });

  test("regular chat composer shows agents in the slash menu without selected project actions", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "start",
        prompt: "/review",
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus,
        goalRuntime: null,
        busy: false,
        running: false,
        connection: null,
        provider: "openpond",
        model: "openpond-chat",
        projectTarget,
        actionCatalog: [buildOpenPondAgentSlashCommand(sandboxAgent(), "Cloud Repo")],
        workspaceTarget,
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
        onStop: noop,
      }),
    );

    expect(markup).toContain('aria-label="OpenPond agents and actions"');
    expect(markup).toContain("Review Bot");
    expect(markup).toContain("Reviews project changes.");
  });

  test("regular chat composer shows generated profile chat actions by metadata agent name in the slash menu", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "start",
        prompt: "/weekly",
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus,
        goalRuntime: null,
        busy: false,
        running: false,
        connection: null,
        provider: "openpond",
        model: "openpond-chat",
        projectTarget,
        actionCatalog: [
          {
            id: "help-me-write-the-weekly-ops-note.chat",
            label: "Chat",
            description: "Drafts concise weekly operations notes from committed local fixtures.",
            implementation: {
              type: "openpond-profile-action",
              actionId: "help-me-write-the-weekly-ops-note.chat",
              agentName: "Weekly Ops Notes",
            },
          },
        ],
        workspaceTarget,
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
        onStop: noop,
      }),
    );

    expect(markup).toContain('aria-label="OpenPond agents and actions"');
    expect(markup).toContain("Weekly Ops Notes");
    expect(markup).not.toContain("Help Me Write The Weekly Ops Note");
    expect(markup).not.toContain("<strong>Chat</strong>");
  });

  test("regular chat composer shows generated profile actions as mention targets", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "start",
        prompt: "@help-me",
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus,
        goalRuntime: null,
        busy: false,
        running: false,
        connection: null,
        provider: "openpond",
        model: "openpond-chat",
        projectTarget,
        actionCatalog: [
          {
            id: "help-me-write-the-weekly-ops-note.chat",
            label: "Chat",
            description: "Drafts concise weekly operations notes from committed local fixtures.",
            implementation: {
              type: "openpond-profile-action",
              actionId: "help-me-write-the-weekly-ops-note.chat",
              agentName: "Weekly Ops Notes",
            },
          },
        ],
        workspaceTarget,
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
        onStop: noop,
      }),
    );

    expect(markup).toContain('aria-label="OpenPond mentions"');
    expect(markup).toContain("composer-project-menu composer-slash-menu composer-mention-menu");
    expect(markup).toContain("composer-project-option selected");
    expect(markup).toContain("Weekly Ops Notes");
    expect(markup).not.toContain("Help Me Write The Weekly Ops Note");
    expect(markup).toContain("Drafts concise weekly operations notes from committed local fixtures.");
    expect(markup).not.toContain("<strong>Chat</strong>");
    expect(markup).not.toContain("Alpha Bot");
  });

  test("active chat composer hides the project footer", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "dock",
        prompt: "",
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus,
        goalRuntime: null,
        busy: false,
        running: false,
        showProjectFooter: false,
        connection: null,
        provider: "openpond",
        model: "openpond-chat",
        projectTarget,
        actionCatalog: [],
        workspaceTarget,
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
        onStop: noop,
      }),
    );

    expect(markup).not.toContain("composer-footer");
    expect(markup).toContain('class="composer-textarea-frame"');
    expect(markup).not.toContain('aria-label="Working in"');
    expect(markup).toContain('aria-label="Add photos and files"');
  });

  test("regular chat composer shows built-in commands before agents or actions load", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "start",
        prompt: "/",
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus,
        goalRuntime: null,
        busy: false,
        running: false,
        connection: null,
        provider: "openpond",
        model: "openpond-chat",
        projectTarget,
        actionCatalog: [],
        workspaceTarget,
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
        onStop: noop,
      }),
    );

    expect(markup).toContain('aria-label="OpenPond agents and actions"');
    expect(markup).toContain("/create Create agent or project");
    expect(markup).toContain("Start a guided creation flow in OpenPond Cloud.");
    expect(markup).toContain("/edit Edit selected agent");
    expect(markup).toContain("/skill Manage skills");
    expect(markup).toContain("create, edit, list, help");
    expect(markup).not.toContain("Subcommands:");
    expect(markup).toContain("/goal Run a goal");
    expect(markup).toContain("/goal-remote Run a cloud goal");
    expect(markup).toContain("/goal-local Run a local goal");
    expect(markup).toContain("/submit-issue Submit issue");
    expect(markup).toContain("File a GitHub issue in openpond/openpond through the connected GitHub app.");
    expect(markup).toContain("/sync-cloud Upload/sync to Cloud");
    expect(markup).not.toContain("No agents or project actions available");
  });

  test("renders the submit issue command as a structured issue form", () => {
    const markup = renderToStaticMarkup(
      createElement(SubmitIssueDialog, {
        busy: false,
        initialDescription: "Crash when syncing",
        open: true,
        onClose: noop,
        onSubmit: async () => true,
      }),
    );

    expect(markup).toContain('aria-label="Submit GitHub issue"');
    expect(markup).toContain("openpond/openpond");
    expect(markup).toContain("Short issue title");
    expect(markup).toContain("Crash when syncing");
    expect(markup).toContain("Submit issue");
  });

  test("regular chat composer shows slash commands after existing text", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, {
        mode: "start",
        prompt: "hello /create",
        mentionApps: [],
        selectedMentionAppId: null,
        contextWindowStatus,
        goalRuntime: null,
        busy: false,
        running: false,
        connection: null,
        provider: "openpond",
        model: "openpond-chat",
        projectTarget,
        actionCatalog: [],
        workspaceTarget,
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
        onStop: noop,
      }),
    );

    expect(markup).toContain('aria-label="OpenPond agents and actions"');
    expect(markup).toContain("/create Create agent or project");
  });

  test("Cloud composer remains plain task input without slash action menu", () => {
    const markup = renderToStaticMarkup(
      createElement(CloudWorkView, {
        projects: [cloudProject()],
        workItems: [],
        selectedWorkItem: null,
        detail: null,
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

    expect(markup).toContain("What should we change next?");
    expect(markup).toContain('aria-label="Cloud Project"');
    expect(markup).toContain("Describe a task");
    expect(markup).not.toContain('aria-label="OpenPond agents and actions"');
    expect(markup).not.toContain("composer-mention-menu action-menu");
  });
});
