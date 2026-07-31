import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  Approval,
  ChatAttachment,
  RuntimeEvent,
  Session,
} from "@openpond/contracts";

import { MessageRow } from "../apps/web/src/components/chat/Messages";
import { ApprovalRequestCard } from "../apps/web/src/components/chat/ApprovalRequestCard";
import { WorkspaceDiffTabs } from "../apps/web/src/components/workspace-diff/WorkspaceDiffPanelChrome";
import {
  promptForAppSlashCommand,
  sandboxIdFromWorkspaceName,
  shouldSubmitComposerSlashCommandToChat,
  shouldRunCreateImproveCommandLocally,
} from "../apps/web/src/components/app-shell/main-pane-helpers";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages";
import {
  composerActionCatalogLabel,
  composerActionCatalogMatches,
  composerActionSlashQuery,
} from "../apps/web/src/lib/composer-action-catalog";
import {
  composerSlashCommandsForProvider,
  composerSlashCommandMatches,
  parseComposerSlashCommandPrompt,
} from "../apps/web/src/lib/composer-slash-commands";
import { buildSubmitIssueSlashPrompt } from "../apps/web/src/lib/submit-issue-command";
import {
  buildOpenPondAppActionRunInput,
  buildOpenPondAgentRunInput,
  buildOpenPondProfileActionCatalog,
  buildOpenPondProfileActionCommand,
  buildOpenPondProfileActionRunInput,
  shouldRetainOpenPondProfileActionAfterSubmit,
} from "../apps/web/src/lib/openpond-action-run";
import { latestReadyLocalCreateImproveProfileRefreshKey } from "../apps/web/src/lib/create-pipeline-profile-refresh";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";
import type { SandboxActionCatalogEntry } from "../apps/web/src/lib/sandbox-types";

const timestamp = "2026-06-20T00:00:00.000Z";

function action(
  input: Partial<SandboxActionCatalogEntry> & { id: string }
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

function runtimeEvent(input: Omit<RuntimeEvent, "timestamp">): RuntimeEvent {
  return {
    timestamp,
    ...input,
  };
}

describe("OpenPond App action channel", () => {
  test("labels a profile's default chat action with its configured agent name", () => {
    const [profileAction] = buildOpenPondProfileActionCatalog({
      agents: [
        {
          id: "release-reviewer",
          name: "Release Reviewer",
          path: "agents/release-reviewer",
          enabled: true,
        },
      ],
      actionCatalog: [
        {
          id: "chat",
          agentId: "release-reviewer",
          sourceActionId: "chat",
          label: "Chat",
          description: "Reviews releases before they ship.",
        },
      ],
    });

    expect(profileAction?.implementation).toMatchObject({
      type: "openpond-profile-action",
      actionId: "chat",
      agentName: "Release Reviewer",
    });
    expect(composerActionCatalogLabel(profileAction!)).toBe("Release Reviewer");
  });

  test("retains profile chat actions for conversational follow-ups only", () => {
    const chat = buildOpenPondProfileActionCommand({
      id: "account-health-agent.chat",
      sourceActionId: "chat",
      label: "Account Health Agent",
    });
    const summarize = buildOpenPondProfileActionCommand({
      id: "summarize-account",
      sourceActionId: "summarize-account",
      label: "Summarize Account",
    });

    expect(shouldRetainOpenPondProfileActionAfterSubmit(chat)).toBe(true);
    expect(shouldRetainOpenPondProfileActionAfterSubmit(summarize)).toBe(false);
    expect(shouldRetainOpenPondProfileActionAfterSubmit(null)).toBe(false);
  });

  test("discovers built-in app commands from composer slash input", () => {
    expect(
      composerSlashCommandMatches({ prompt: "/" }).map((item) => item.id)
    ).toEqual([
      "agent",
      "skill",
      "goal",
      "submit-issue",
      "train",
      "sync-cloud",
    ]);
    expect(
      composerSlashCommandMatches({ prompt: "/agent" }).map((item) => item.id)
    ).toEqual(["agent"]);
    expect(
      composerSlashCommandMatches({ prompt: "/create" }).map((item) => item.id)
    ).toEqual(["agent", "skill", "train"]);
    expect(
      parseComposerSlashCommandPrompt("/create summarize files")
    ).toBeNull();
    expect(
      composerSlashCommandMatches({ prompt: "/goal" }).map((item) => item.id)
    ).toEqual(["goal"]);
    expect(composerSlashCommandMatches({ prompt: "/goal-r" })).toEqual([]);
    expect(
      composerSlashCommandMatches({ prompt: "/list" }).map((item) => item.id)
    ).toEqual(["skill"]);
    expect(
      composerSlashCommandMatches({ prompt: "/skill help" }).map(
        (item) => item.id
      )
    ).toEqual(["skill"]);
    expect(
      composerSlashCommandMatches({ prompt: "/submit issue" }).map(
        (item) => item.id
      )
    ).toEqual(["submit-issue"]);
    expect(
      parseComposerSlashCommandPrompt("/agent create summarize files")
    ).toEqual({
      command: "agent",
      args: "create summarize files",
    });
    expect(
      parseComposerSlashCommandPrompt("/skill create release-notes")
    ).toEqual({
      command: "skill",
      args: "create release-notes",
    });
    expect(
      parseComposerSlashCommandPrompt("/goal-remote summarize files")
    ).toBeNull();
    expect(
      parseComposerSlashCommandPrompt("/goal-local summarize files")
    ).toBeNull();
    expect(
      composerSlashCommandsForProvider("openpond").map((item) => item.id)
    ).not.toContain("goal");
    expect(
      composerSlashCommandsForProvider("codex").map((item) => item.id)
    ).toContain("goal");
    expect(parseComposerSlashCommandPrompt("/sync-cloud")).toEqual({
      command: "sync-cloud",
      args: "",
    });
    expect(
      parseComposerSlashCommandPrompt("/submit-issue add a crash report")
    ).toEqual({
      command: "submit-issue",
      args: "add a crash report",
    });
    expect(
      parseComposerSlashCommandPrompt("/unknown summarize files")
    ).toBeNull();
  });

  test("routes goal slash commands through chat", () => {
    const goalCommand = parseComposerSlashCommandPrompt("/goal smoke goal");
    expect(goalCommand).not.toBeNull();

    expect(shouldSubmitComposerSlashCommandToChat(goalCommand!)).toBe(true);
    expect(promptForAppSlashCommand(goalCommand!)).toBe("/goal smoke goal");
  });

  test("builds GitHub-connected submit issue prompts for openpond", () => {
    const prompt = buildSubmitIssueSlashPrompt(
      "Add export progress to long-running workspace sync."
    );

    expect(prompt).toContain("@github");
    expect(prompt).toContain("openpond/openpond");
    expect(prompt).toContain("github.issue.create");
    expect(prompt).toContain(
      "Add export progress to long-running workspace sync."
    );
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
      })
    );

    expect(html).toContain("Right sidebar views");
    expect(html).toContain(">Goal</span>");
    expect(html).toContain(">Files</span>");
    expect(html).not.toContain(">Summary</span>");
    expect(html).not.toContain(">Changes</span>");
    expect(html.indexOf(">Goal</span>")).toBeLessThan(
      html.indexOf(">Files</span>")
    );
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
      })
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
    expect(html.indexOf(">Open file</span>")).toBeLessThan(
      html.indexOf(">Browser</span>")
    );
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
      })
    );

    expect(html).toContain("right-chat-tab");
    expect(html).toContain(">New chat</span>");
    expect(html).toContain('aria-label="Close New chat"');
    expect(html.indexOf(">Files</span>")).toBeLessThan(
      html.indexOf(">New chat</span>")
    );
    expect(html).not.toContain(">Review</span>");
  });

  test("keeps direct sandbox chats on the standard right sidebar with a summary tab", () => {
    expect(sandboxIdFromWorkspaceName("nas6d9khcmppt1sxvve1i7iu")).toBe(
      "nas6d9khcmppt1sxvve1i7iu"
    );
    expect(
      sandboxIdFromWorkspaceName("H-16 X metadata-only sandbox proof")
    ).toBeNull();

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
      })
    );

    expect(html).toContain(">Summary</span>");
    expect(html).toContain(">Files</span>");
    expect(html.indexOf(">Summary</span>")).toBeLessThan(
      html.indexOf(">Files</span>")
    );
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
        (item) => item.id
      )
    ).toEqual(["water.estimate"]);
    expect(
      composerActionCatalogMatches({ actions, prompt: "/workflow" }).map(
        (item) => item.id
      )
    ).toEqual(["build.report"]);
    expect(
      composerActionCatalogMatches({ actions, prompt: "/" }).map(
        (item) => item.id
      )
    ).toEqual(["chat", "water.estimate", "build.report"]);
  });

  test("detects ready local Agent Create/Improve runs for profile catalog refresh", () => {
    const ignoredBlocked = runtimeEvent({
      id: "event_blocked",
      sessionId: "session_1",
      turnId: "turn_1",
      name: "create_improve.updated",
      source: "server",
      status: "failed",
      data: {
        createImproveRun: createImproveRunFixture({
          id: "create_improve_blocked",
          state: "blocked",
        }),
      },
    });
    const ignoredHosted = runtimeEvent({
      id: "event_hosted",
      sessionId: "session_1",
      turnId: "turn_1",
      name: "create_improve.updated",
      source: "server",
      status: "completed",
      data: {
        createImproveRun: createImproveRunFixture({
          id: "create_improve_hosted",
          state: "ready_local",
          adapter: {
            kind: "hosted",
            sourceAuthority: "hosted_profile",
            teamId: "team_1",
            projectId: "project_1",
            activeProfile: "default",
            sourceRef: "main",
            baseSha: null,
            confirmationPolicy: "always_require_plan_approval",
          },
        }),
      },
    });
    const readyLocal = runtimeEvent({
      id: "event_ready",
      sessionId: "session_2",
      turnId: "turn_2",
      name: "create_improve.updated",
      source: "server",
      status: "completed",
      data: {
        createImproveRun: createImproveRunFixture({
          id: "create_improve_ready",
          state: "ready_local",
        }),
      },
    });

    expect(
      latestReadyLocalCreateImproveProfileRefreshKey([
        ignoredBlocked,
        ignoredHosted,
      ])
    ).toBeNull();
    expect(
      latestReadyLocalCreateImproveProfileRefreshKey([
        ignoredBlocked,
        readyLocal,
        ignoredHosted,
      ])
    ).toBe("session_2:turn_2:create_improve_ready");
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
      })
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
      })
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
      })
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
      })
    );
    expect(html).toContain("Run Water Estimate");
    expect(html).toContain("Estimated 42 fixture units.");
    expect(html).toContain("artifacts/trace.jsonl");
    expect(html).toContain("artifacts/eval.json");
    expect(html).toContain("Parse fixtures");
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
      })
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
      detail: JSON.stringify({
        patchPath: "/tmp/openpond-subagents/run/handoff.patch",
      }),
      status: "pending",
      createdAt: timestamp,
    };
    const html = renderToStaticMarkup(
      createElement(ApprovalRequestCard, {
        approval,
        onResolve: async () => undefined,
      })
    );
    expect(html).toContain("Subagent patch");
    expect(html).toContain("Apply coding subagent patch");
    expect(html).not.toContain(">Session</span>");
  });
});
