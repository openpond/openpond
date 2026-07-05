import { describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "@openpond/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageRow } from "../apps/web/src/components/chat/Messages";
import { activityGroupSummary, buildChatMessages } from "../apps/web/src/lib/chat-messages";
import { connectedAppProviderActivityRows } from "../apps/web/src/lib/connected-app-provider-activity";

function runtimeEvent(input: Omit<RuntimeEvent, "timestamp">): RuntimeEvent {
  return {
    timestamp: "2026-05-16T00:00:00.000Z",
    ...input,
  };
}

function commandStarted(id: string, turnId: string, command: string): RuntimeEvent {
  return runtimeEvent({
    id,
    name: "tool.started",
    turnId,
    action: "exec_command",
    status: "started",
    data: {
      callId: id,
      command,
    },
  });
}

describe("chat message projection", () => {
  test("renders assistant reasoning as streamed activity separate from answer content", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_started",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: { prompt: "hello z.ai" },
      }),
      runtimeEvent({
        id: "reasoning_1",
        name: "assistant.reasoning.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output: "The user is greeting Z.ai.",
      }),
      runtimeEvent({
        id: "reasoning_2",
        name: "assistant.reasoning.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output: " It should answer briefly.",
      }),
      runtimeEvent({
        id: "assistant_1",
        name: "assistant.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output: "Hello z.ai",
      }),
    ]);

    expect(messages.map((message) => message.role)).toEqual(["user", "activity_group", "assistant"]);
    expect(messages[1]).toMatchObject({
      role: "activity_group",
      activities: [
        {
          label: "Reasoning",
          content: "The user is greeting Z.ai. It should answer briefly.",
        },
      ],
    });
    expect(activityGroupSummary(messages[1]?.activities ?? [])).toBe("Reasoned");
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: "Hello z.ai",
    });

    const html = renderToStaticMarkup(createElement(MessageRow, { message: messages[1]! }));
    expect(html).toContain("Reasoned");
    expect(html).not.toContain("Hello z.ai");

    const assistantHtml = renderToStaticMarkup(createElement(MessageRow, { message: messages[2]! }));
    expect(assistantHtml).toContain("Hello z.ai");
    expect(assistantHtml).not.toContain("The user is greeting Z.ai.");
  });

  test("renders Insights scan prompts as compact evidence cards", () => {
    const evidenceItems = Array.from({ length: 6 }, (_, index) => ({
      evidenceSource: index % 2 === 0 ? "tool_failure" : "stuck_turn",
      evidenceKey: `evidence_${index}`,
      fingerprint: `fingerprint_${index}`,
      insight: {
        severity: index === 0 ? "blocker" : "concern",
        type: "insight",
        title: `Insight ${index}`,
        summary: `Evidence summary ${index}`,
        sourceSessionId: `session_${index}`,
        sourceTurnId: `turn_${index}`,
        createPipelineState: null,
        sourceEventSequence: index + 1,
      },
    }));
    const messages = buildChatMessages([
      runtimeEvent({
        id: "insights_turn_started",
        name: "turn.started",
        sessionId: "insights_session",
        turnId: "insights_turn",
        args: {
          prompt: "You are the built-in OpenPond Insights agent.\n\nEvidence JSON:\n{}",
          insightsRun: {
            id: "insights_run_1",
            trigger: "interval",
            status: "completed",
            evidenceSources: ["stuck_turn", "tool_failure"],
            findingCount: 6,
          },
          insightsEvidencePreview: {
            afterSequence: 10,
            latestSequence: 20,
            eventCount: 11,
            evidenceSources: ["stuck_turn", "tool_failure"],
            totalCount: evidenceItems.length,
            truncated: true,
            items: evidenceItems,
          },
        },
      }),
    ]);

    expect(messages[0]?.content).toBeUndefined();
    expect(messages[0]?.insightsRunPrompt?.items).toHaveLength(6);

    const html = renderToStaticMarkup(createElement(MessageRow, { message: messages[0]! }));
    expect(html).toContain("Insights scan");
    expect(html).toContain("6 evidence items");
    expect(html).toContain("Insight 0");
    expect(html).toContain("Insight 4");
    expect(html).not.toContain("Insight 5");
    expect(html).toContain("Show 1 more");
    expect(html).not.toContain("Evidence JSON");
  });

  test("renders OpChat quota failures as a billing action card", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_failed",
        name: "turn.failed",
        sessionId: "session_1",
        turnId: "turn_1",
        error:
          "OpenPond OpChat stream failed: 429 opchat_quota_exceeded: invalid_request_error: OpChat token allowance is exhausted for this period.",
      }),
    ]);

    expect(messages[0]?.errorKind).toBe("opchat_quota_exceeded");

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[0]!,
        accountBaseUrl: "https://qa.openpond.example/dashboard",
        billingOrganizationSlug: "example-org",
      }),
    );

    expect(html).toContain("OpenPond Chat allowance reached");
    expect(html).toContain("https://qa.openpond.example/sandboxes/example-org/billing");
    expect(html).not.toContain("OpenPond OpChat stream failed");
  });

  test("recovers Insights evidence rows from truncated prompt JSON", () => {
    const prompt = [
      "You are the built-in OpenPond Insights agent.",
      "",
      "Evidence JSON:",
      "{",
      '  "eventCount": 12,',
      '  "evidenceSources": ["tool_failure"],',
      '  "evidence": [',
      '    {"evidenceSource":"tool_failure","evidenceKey":"tool_1","fingerprint":"one","insight":{"title":"Tool failed","summary":"Command exited 1","severity":"concern","type":"tool","sourceSessionId":"session_1","sourceTurnId":"turn_1","createPipelineState":null,"sourceEventSequence":7}},',
      '    {"evidenceSource":"tool_failure","evidenceKey":"tool_2","fingerprint":"two","insight":{"title":"Tool failed again","summary":"Command exited 2","severity":"concern","type":"tool","sourceSessionId":"session_2","sourceTurnId":"turn_2","createPipelineState":null,"sourceEventSequence":8}}',
      "",
      "...truncated",
    ].join("\n");
    const messages = buildChatMessages([
      runtimeEvent({
        id: "insights_turn_started",
        name: "turn.started",
        sessionId: "insights_session",
        turnId: "insights_turn",
        args: {
          prompt,
          insightsRun: {
            id: "insights_run_1",
            trigger: "startup",
            status: "completed",
            evidenceSources: ["tool_failure"],
          },
        },
      }),
    ]);

    expect(messages[0]?.insightsRunPrompt?.eventCount).toBe(12);
    expect(messages[0]?.insightsRunPrompt?.items.map((item) => item.title)).toEqual([
      "Tool failed",
      "Tool failed again",
    ]);
  });

  test("renders image attachments as inline user message previews", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_with_image",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: {
          prompt: "Can you inspect this bug screenshot?",
          attachments: [
            {
              id: "attachment_1",
              name: "Screenshot from 2026-07-02 13.49.59.png",
              mediaType: "image/png",
              sizeBytes: 44 * 1024,
              kind: "image",
              imagePreview: {
                sessionId: "session_1",
                turnId: "turn_1",
                attachmentId: "attachment_1",
                storageName: "Screenshot from 2026-07-02 13.49.59.png",
                contentType: "image/png",
              },
            },
            {
              id: "attachment_2",
              name: "notes.txt",
              mediaType: "text/plain",
              sizeBytes: 128,
              kind: "text",
            },
          ],
        },
      }),
    ]);

    expect(messages[0]?.attachments?.[0]?.imagePreview).toEqual({
      sessionId: "session_1",
      turnId: "turn_1",
      attachmentId: "attachment_1",
      storageName: "Screenshot from 2026-07-02 13.49.59.png",
      contentType: "image/png",
    });

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[0]!,
        connection: { serverUrl: "http://127.0.0.1:17876", token: "token", platform: "test" },
      }),
    );
    expect(html).toContain("has-image-attachments");
    expect(html).toContain("user-message-image-attachment");
    expect(html).toContain("Screenshot from 2026-07-02 13.49.59.png");
    expect(html).toContain("notes.txt");
    expect(html).toContain("user-message-attachment");
  });

  test("renders OpenPond Chat markdown image output inline", () => {
    const imageUrl =
      "http://127.0.0.1:17876/v1/assets/chat-attachment-image?storageName=OpenPond%20Chat%20signed-out%20failure.png&signature=sig";
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_openpond_chat",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: {
          prompt: "Show the signed-out screenshots.",
          provider: "openpond",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
        },
      }),
      runtimeEvent({
        id: "assistant_image",
        name: "assistant.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output: `OpenPond Chat failure after sending:\n\n![OpenPond Chat signed-out failure](${imageUrl})`,
      }),
    ]);

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[1]!,
        connection: { serverUrl: "http://127.0.0.1:17876", token: "token", platform: "test" },
      }),
    );
    expect(html).toContain("OpenPond Chat failure after sending");
    expect(html).toContain("markdown-inline-image ready");
    expect(html).toContain("<img");
    expect(html).toContain('alt="OpenPond Chat signed-out failure"');
    expect(html).not.toContain("!<a");
  });

  test("renders OpenPond Chat html image output inline", () => {
    const imageUrl =
      "http://127.0.0.1:17876/v1/assets/chat-attachment-image?storageName=OpenPond%20Chat%20signed-out%20failure.png&signature=sig";
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_openpond_chat_html_image",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: {
          prompt: "Show the signed-out screenshots.",
          provider: "openpond",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
        },
      }),
      runtimeEvent({
        id: "assistant_html_image",
        name: "assistant.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output: `OpenPond Chat failure after sending:\n\n!<img src="${imageUrl}" alt="OpenPond Chat signed-out failure" />`,
      }),
    ]);

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[1]!,
        connection: { serverUrl: "http://127.0.0.1:17876", token: "token", platform: "test" },
      }),
    );
    expect(html).toContain("OpenPond Chat failure after sending");
    expect(html).toContain("markdown-inline-image ready");
    expect(html).toContain("<img");
    expect(html).toContain('alt="OpenPond Chat signed-out failure"');
    expect(html).not.toContain("!&lt;img");
  });

  test("renders web search results as source pills on the assistant message", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_web_search",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: { prompt: "Who scored in the USMNT game?" },
      }),
      runtimeEvent({
        id: "web_search_completed",
        name: "tool.completed",
        sessionId: "session_1",
        turnId: "turn_1",
        action: "web_search",
        status: "completed",
        output: "Found 2 web results.",
        data: {
          tool: "web_search",
          type: "native_model_tool",
          result: {
            result: {
              query: "USMNT July 1 2026 goals",
              provider: "exa",
              searchedAt: "2026-07-03T00:00:00.000Z",
              truncated: false,
              results: [
                {
                  id: "us-soccer",
                  title: "USMNT match report",
                  url: "https://www.ussoccer.com/stories/2026/07/usmnt-match-report",
                  snippet: "Folarin Balogun and Malik Tillman scored.",
                  sourceName: "U.S. Soccer",
                  faviconUrl: "https://www.ussoccer.com/favicon.ico",
                  publishedAt: "2026-07-01T00:00:00.000Z",
                  updatedAt: null,
                },
                {
                  id: "espn",
                  title: "United States game recap",
                  url: "https://www.espn.com/soccer/report/_/gameId/123",
                  snippet: "The match was played July 1, 2026.",
                  sourceName: "ESPN",
                  publishedAt: null,
                  updatedAt: null,
                },
              ],
            },
          },
        },
      }),
      runtimeEvent({
        id: "assistant_answer",
        name: "assistant.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output: "Goals were by Folarin Balogun and Malik Tillman. Sources: U.S. Soccer, ESPN.",
      }),
    ]);

    expect(messages.map((message) => message.role)).toEqual(["user", "activity_group", "assistant"]);
    expect(messages[2]?.sources?.map((source) => source.sourceName)).toEqual(["U.S. Soccer", "ESPN"]);

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[2]!,
        onOpenBrowserLink: () => undefined,
      }),
    );
    expect(html).toContain("assistant-sources");
    expect(html).toContain("assistant-source-pill");
    expect(html).toContain("Open source U.S. Soccer");
    expect(html).toContain("Open source ESPN");
    expect(html).toContain("assistant-source-favicon");
    expect(html).toContain('src="https://www.ussoccer.com/favicon.ico"');
    expect(html).toContain(">U.S. Soccer</span>");
    expect(html).not.toContain(">https://www.ussoccer.com");
  });

  test("renders OpenPond Chat public image file inventories inline", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_openpond_chat_image_inventory",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: {
          prompt: "testing, can you show me all the images in this directory",
          provider: "openpond",
          modelRef: { providerId: "openpond", modelId: "openpond-chat" },
        },
      }),
      runtimeEvent({
        id: "assistant_image_inventory",
        name: "assistant.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output:
          "There are 13 image files in this workspace, all under `apps/web/public/`:\n\n" +
          "**PNG files:**\n" +
          "- `apps/web/public/openpond-icon.png`\n\n" +
          "**SVG files (connected-apps):**\n" +
          "- `apps/web/public/connected-apps/github.svg`",
      }),
    ]);

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[1]!,
        onOpenFileInSidebar: () => {},
        workspaceRootPath: "/home/glu/Projects/all/openpond",
      }),
    );
    expect(html).toContain("There are 13 image files");
    expect(html).toContain("markdown-file-image-reference");
    expect(html).toContain("markdown-file-image-preview ready");
    expect(html).toContain('src="/openpond-icon.png"');
    expect(html).toContain('src="/connected-apps/github.svg"');
  });

  test("projects create pipeline turn metadata into a review message", () => {
    const now = "2026-05-16T00:00:00.000Z";
    const createPipelineRequest = {
      schemaVersion: "openpond.createPipeline.request.v1",
      id: "create_request_1",
      operation: "create",
      surface: "direct_prompt_create",
      command: "/create",
      objective: "Create a release notes agent",
      adapter: {
        kind: "hosted",
        sourceAuthority: "hosted_profile",
        teamId: "team_1",
        projectId: "profile_project_1",
        activeProfile: "default",
        sourceRef: "main",
        baseSha: null,
        workItemId: null,
        confirmationPolicy: "always_require_plan_approval",
      },
      actor: { id: "sam", kind: "user", label: "Sam" },
      scope: {
        conversationId: "session_1",
        workItemId: null,
        projectId: "profile_project_1",
        targetProject: null,
      },
      context: {
        messageIds: [],
        conversationExcerpts: [],
        attachments: [],
        apps: [],
        tools: [],
        targetRepoAssumptions: [],
      },
      targetAgent: {
        agentId: null,
        displayName: null,
        defaultActionKey: "chat",
      },
      metadata: { source: "web_composer_slash" },
      createdAt: now,
    };
    const createPipeline = {
      schemaVersion: "openpond.createPipeline.snapshot.v1",
      id: "create_pipeline_1",
      goalId: "create_request_1",
      state: "awaiting_plan_approval",
      request: createPipelineRequest,
      plan: null,
      workflowCapture: null,
      approvalIds: [],
      checkRefs: [],
      sourceRefs: [],
      localGoalId: null,
      localProfileCommit: null,
      hostedGoalId: null,
      hostedSourceCommit: null,
      hostedSourceRef: null,
      blockedReason: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };

    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: {
          prompt: "/create release notes agent",
          createPipelineRequest,
          createPipeline,
        },
      }),
      runtimeEvent({
        id: "create_pipeline_approved",
        name: "create_pipeline.updated",
        sessionId: "session_1",
        turnId: "turn_1",
        data: {
          createPipelineRequest,
          createPipeline: {
            ...createPipeline,
            state: "applying_source",
            updatedAt: now,
          },
        },
      }),
      runtimeEvent({
        id: "assistant_source_apply",
        name: "assistant.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output: "I will inspect the existing profile",
      }),
      runtimeEvent({
        id: "assistant_source_apply_more",
        name: "assistant.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output: " and create files now.",
      }),
      runtimeEvent({
        id: "source_apply_tool",
        name: "tool.started",
        sessionId: "session_1",
        turnId: "turn_1",
        action: "commandExecution",
        status: "started",
        output: "sed -n '1,200p' profiles/default/settings/profile.yaml",
      }),
      runtimeEvent({
        id: "source_apply_output",
        name: "command.output",
        sessionId: "session_1",
        turnId: "turn_1",
        output: "large provider diagnostic output",
      }),
    ]);

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.createPipelineRequest?.objective).toBe("Create a release notes agent");
    expect(messages[1]?.createPipeline?.state).toBe("applying_source");
    expect(messages[1]?.content).toBeUndefined();
    expect(messages[1]?.actionRun).toBeUndefined();
    expect(messages[1]?.createPipelineDebugActivities).toHaveLength(2);
    expect(messages[1]?.createPipelineDebugActivities?.[0]).toMatchObject({
      label: "assistant delta",
      content: "I will inspect the existing profile and create files now.",
    });
    expect(messages[1]?.createPipelineDebugActivities?.[1]).toMatchObject({
      label: "Started",
      content: "sed -n '1,200p' profiles/default/settings/profile.yaml",
      detail: "large provider diagnostic output",
      kind: "command",
    });
  });

  test("projects profile action run results into normal assistant messages", () => {
    const supportSummary =
      "Open customer support tracker: 4 open items. Needs attention first: CS-1042 Northstar Analytics.";

    const messages = buildChatMessages([
      runtimeEvent({
        id: "profile_action_user",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "openpond_profile_action_1",
        source: "chat_action",
        args: { prompt: "Which open customer support items need attention first?" },
      }),
      runtimeEvent({
        id: "profile_action_result",
        name: "workspace_action_result",
        sessionId: "session_1",
        turnId: "openpond_profile_action_1",
        source: "chat_action",
        action: "profile_run_action",
        status: "completed",
        output: supportSummary,
        data: {
          openPondProfileActionRun: true,
          action: {
            name: "help-me-keep-track-of-open-customer-support-item.chat",
            label: "Chat",
            agentName: "Open Items Assistant",
            implementation: {
              type: "openpond-profile-action",
              actionId: "help-me-keep-track-of-open-customer-support-item.chat",
              agentName: "Open Items Assistant",
            },
          },
          responseSummary: {
            status: "available",
            text: supportSummary,
          },
          artifactRefs: ["open-support-items-summary.json"],
          traceArtifactRefs: [".openpond/traces/run-chat-123.jsonl"],
        },
      }),
    ]);

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.actionRun?.actionName).toBe(
      "help-me-keep-track-of-open-customer-support-item.chat",
    );
    expect(messages[1]?.actionRun?.title).toBe("Chat");
    expect(messages[1]?.actionRun?.status).toBe("completed");
    expect(messages[1]?.actionRun?.responseText).toBe(supportSummary);
    expect(messages[1]?.actionRun?.implementationType).toBe("openpond-profile-action");
    expect(messages[1]?.actionRun?.refs.map((ref) => ref.target)).toEqual([
      "open-support-items-summary.json",
      ".openpond/traces/run-chat-123.jsonl",
    ]);

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[1]!,
        onOpenProfileSettings: () => undefined,
      }),
    );
    expect(html).toContain("Open customer support tracker: 4 open items.");
    expect(html).not.toContain("Agent:");
    expect(html).toContain("action-run-agent-link");
    expect(html).toContain("Open Items Assistant");
    expect(html).not.toContain("help-me-keep-track-of-open-customer-support-item");
    expect(html).not.toContain("action-run-card");
    expect(html).not.toContain("openpond-profile-action");
    expect(html).not.toContain(".openpond/traces/run-chat-123.jsonl");
  });

  test("renders pending profile action runs as normal assistant messages", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "profile_action_user",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "openpond_profile_action_2",
        source: "chat_action",
        args: { prompt: "Produce a keepable invoice triage summary." },
      }),
      runtimeEvent({
        id: "profile_action_started",
        name: "workspace_action",
        sessionId: "session_1",
        turnId: "openpond_profile_action_2",
        source: "chat_action",
        action: "profile_run_action",
        status: "started",
        args: {
          actionName: "triage-invoices",
        },
        data: {
          openPondProfileActionRun: true,
          action: {
            name: "triage-invoices",
            label: "Triage Invoices",
            agentName: "Finance Review Desk",
            implementation: {
              type: "openpond-profile-action",
              actionId: "triage-invoices",
              agentName: "Finance Review Desk",
            },
          },
        },
      }),
    ]);

    expect(messages[1]?.actionRun?.implementationType).toBe("openpond-profile-action");

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[1]!,
      }),
    );
    expect(html).toContain("Triage Invoices is running...");
    expect(html).not.toContain("Agent:");
    expect(html).toContain("Finance Review Desk");
    expect(html).not.toContain("action-run-card");
  });

  test("renders auto compaction as one status divider", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Continue the work" },
      }),
      runtimeEvent({
        id: "compact_started",
        name: "session.compaction.started",
        turnId: "turn_1",
        status: "started",
        data: { reason: "auto" },
      }),
      runtimeEvent({
        id: "compact_done",
        name: "session.compaction.completed",
        turnId: "turn_1",
        status: "completed",
        data: { reason: "auto" },
      }),
      runtimeEvent({
        id: "assistant_1",
        name: "assistant.delta",
        turnId: "turn_1",
        output: "Done.",
      }),
    ]);

    expect(messages.map((message) => message.role)).toEqual(["user", "status_divider", "assistant"]);
    expect(messages[1]?.content).toBe("Auto compacted context");
    expect(messages[1]?.statusTone).toBe("success");
  });

  test("projects Codex image reads as activity image previews", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Read the image" },
      }),
      runtimeEvent({
        id: "tool_1",
        appId: "app_1",
        name: "tool.started",
        turnId: "turn_1",
        action: "dynamicToolCall",
        status: "started",
        data: {
          tool: "tools.view_image",
          openpondImagePreviewPath: "assets/photo.png",
        },
      }),
    ]);

    expect(messages[1]?.role).toBe("activity_group");
    expect(messages[1]?.activities?.[0]?.label).toBe("Reading image");
    expect(messages[1]?.activities?.[0]?.content).toBe("assets/photo.png");
    expect(messages[1]?.activities?.[0]?.imagePreview).toEqual({
      path: "assets/photo.png",
      appId: "app_1",
      title: "photo.png",
    });
  });

  test("projects profile skill lifecycle as activity rows", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Use $release-notes" },
      }),
      runtimeEvent({
        id: "skill_1",
        name: "skill.loaded",
        turnId: "turn_1",
        action: "profile_skill_read",
        status: "completed",
        output: "Loaded profile skill release-notes.",
        data: { skillName: "release-notes" },
      }),
    ]);

    expect(messages[1]?.role).toBe("activity_group");
    expect(messages[1]?.activities?.[0]?.label).toBe("Loaded skill");
    expect(messages[1]?.activities?.[0]?.content).toBe("Loaded profile skill release-notes.");
  });

  test("projects OpenPond capability tools as compact activity rows", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "restart this goal" },
      }),
      runtimeEvent({
        id: "create_started",
        name: "tool.started",
        turnId: "turn_1",
        action: "openpond_create_pipeline",
        status: "started",
        args: { objective: "Create a support triage agent." },
      }),
      runtimeEvent({
        id: "create_completed",
        name: "tool.completed",
        turnId: "turn_1",
        action: "openpond_create_pipeline",
        status: "completed",
        output: JSON.stringify({ ok: true, output: "Create Pipeline plan is ready for review." }),
        data: {
          result: {
            nextStep: "Create Pipeline plan is ready for review.",
          },
        },
      }),
      runtimeEvent({
        id: "skill_started",
        name: "tool.started",
        turnId: "turn_1",
        action: "openpond_profile_skill_goal",
        status: "started",
        args: { objective: "Draft reusable release notes." },
      }),
      runtimeEvent({
        id: "skill_completed",
        name: "tool.completed",
        turnId: "turn_1",
        action: "openpond_profile_skill_goal",
        status: "completed",
        output: JSON.stringify({ ok: true, output: "Started profile skill goal: Create release notes." }),
        data: {
          result: {
            nextStep: "Started profile skill goal: Create release notes.",
          },
        },
      }),
      runtimeEvent({
        id: "goal_started",
        name: "tool.started",
        turnId: "turn_1",
        action: "openpond_goal_control",
        status: "started",
        args: { reason: "User asked to restart this goal." },
      }),
      runtimeEvent({
        id: "goal_completed",
        name: "tool.completed",
        turnId: "turn_1",
        action: "openpond_goal_control",
        status: "completed",
        output: JSON.stringify({ ok: true, output: "OpenPond goal restarted." }),
        data: {
          result: {
            nextStep: "OpenPond goal restarted.",
          },
        },
      }),
    ]);

    expect(messages[1]?.role).toBe("activity_group");
    expect(messages[1]?.activities?.map((activity) => activity.label)).toEqual([
      "Starting Create Pipeline",
      "Started Create Pipeline",
      "Starting profile skill goal",
      "Started profile skill goal",
      "Updating goal",
      "Updated goal",
    ]);
    expect(messages[1]?.activities?.map((activity) => activity.content)).toEqual([
      "Create a support triage agent.",
      "Create Pipeline plan is ready for review.",
      "Draft reusable release notes.",
      "Started profile skill goal: Create release notes.",
      "User asked to restart this goal.",
      "OpenPond goal restarted.",
    ]);
  });

  test("projects browser tools as compact redacted activity rows", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "open the browser and type the token" },
      }),
      runtimeEvent({
        id: "browser_open_started",
        name: "tool.started",
        turnId: "turn_1",
        action: "openpond_browser_open",
        status: "started",
        args: { url: "https://example.com/login?[redacted]" },
      }),
      runtimeEvent({
        id: "browser_open_completed",
        name: "tool.completed",
        turnId: "turn_1",
        action: "openpond_browser_open",
        status: "completed",
        output: JSON.stringify({ ok: true, output: "Opened browser." }),
        data: { result: { output: "Opened browser." } },
      }),
      runtimeEvent({
        id: "browser_type_started",
        name: "tool.started",
        turnId: "turn_1",
        action: "openpond_browser_type",
        status: "started",
        args: { text: "[redacted 18 chars]", snapshotId: "snap_1", targetRef: "input_1" },
      }),
      runtimeEvent({
        id: "browser_type_completed",
        name: "tool.completed",
        turnId: "turn_1",
        action: "openpond_browser_type",
        status: "completed",
        output: JSON.stringify({ ok: true, output: "Typed in browser." }),
        data: { result: { output: "Typed in browser." } },
      }),
    ]);

    expect(messages[1]?.role).toBe("activity_group");
    expect(messages[1]?.activities?.map((activity) => activity.label)).toEqual([
      "Opening browser",
      "Opened browser",
      "Typing in browser",
      "Typed in browser",
    ]);
    expect(messages[1]?.activities?.map((activity) => activity.content)).toEqual([
      "https://example.com/login?[redacted]",
      "Opened browser.",
      "Text redacted",
      "Typed in browser.",
    ]);
  });

  test("projects connected app provider tools as redacted provider activity rows", () => {
    const events = [
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "search X for recent mentions" },
      }),
      runtimeEvent({
        id: "x_search_started",
        name: "tool.started",
        turnId: "turn_1",
        action: "connected_app_search",
        status: "started",
        args: {
          provider: "x",
          operation: "x.search.posts",
          query: "openpond",
          capabilityIds: ["x.search.read"],
          connectionId: "conn_should_not_render",
          refreshToken: "token_should_not_render",
        },
      }),
      runtimeEvent({
        id: "x_search_completed",
        name: "tool.completed",
        turnId: "turn_1",
        action: "connected_app_search",
        status: "completed",
        output: "Search completed.",
        data: {
          result: {
            provider: "x",
            providerLabel: "X",
            operation: "search",
            capabilityIds: ["x.search.read"],
            result: {
              connectionId: "conn_should_not_render",
              accessToken: "token_should_not_render",
            },
          },
        },
      }),
    ];
    const messages = buildChatMessages(events);

    expect(messages[1]?.role).toBe("activity_group");
    expect(messages[1]?.activities?.map((activity) => activity.label)).toEqual([
      "X search",
      "X search",
    ]);
    expect(messages[1]?.activities?.map((activity) => activity.content)).toEqual([
      "x.search.posts / 1 capability",
      "search / 1 capability",
    ]);

    const html = renderToStaticMarkup(createElement(MessageRow, { message: messages[1]! }));
    expect(html).toContain("X search");
    expect(html).not.toContain("conn_should_not_render");
    expect(html).not.toContain("token_should_not_render");

    const providerRows = connectedAppProviderActivityRows(events);
    expect(providerRows).toEqual([
      {
        id: "x_search_started",
        label: "X search",
        content: "x.search.posts / 1 capability",
        timestamp: "2026-05-16T00:00:00.000Z",
        state: "running",
      },
      {
        id: "x_search_completed",
        label: "X search",
        content: "search / 1 capability",
        timestamp: "2026-05-16T00:00:00.000Z",
        state: "completed",
      },
    ]);
    expect(JSON.stringify(providerRows)).not.toContain("conn_should_not_render");
    expect(JSON.stringify(providerRows)).not.toContain("token_should_not_render");
  });

  test("projects Codex absolute image reads as local activity image previews", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Read the image" },
      }),
      runtimeEvent({
        id: "tool_1",
        name: "tool.completed",
        turnId: "turn_1",
        action: "dynamicToolCall",
        status: "completed",
        data: {
          tool: "tools.view_image",
          path: "/tmp/image.png",
        },
      }),
    ]);

    expect(messages[1]?.role).toBe("activity_group");
    expect(messages[1]?.activities?.[0]?.imagePreview).toEqual({
      path: "/tmp/image.png",
      appId: null,
      title: "image.png",
    });
  });

  test("merges Codex command lifecycle into one compact activity", () => {
    const rawOutput = [
      "Chunk ID: 6088d8",
      "Wall time: 0.7318 seconds",
      "Process exited with code 0",
      "Original token count: 19",
      "Output:",
      "To github.com:openpond/sandbox.git",
      "   0b0d5ad..38dc899  develop -> develop",
    ].join("\n");
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Push develop" },
      }),
      runtimeEvent({
        id: "tool_started",
        name: "tool.started",
        turnId: "turn_1",
        action: "exec_command",
        status: "started",
        data: {
          callId: "call_1",
          command: "git push origin develop",
        },
      }),
      runtimeEvent({
        id: "tool_completed",
        name: "tool.completed",
        turnId: "turn_1",
        action: "function_call_output",
        status: "completed",
        output: rawOutput,
        data: {
          callId: "call_1",
        },
      }),
      runtimeEvent({
        id: "command_output",
        name: "command.output",
        turnId: "turn_1",
        output: rawOutput,
        data: {
          callId: "call_1",
        },
      }),
    ]);

    const activities = messages[1]?.activities ?? [];
    expect(activities).toHaveLength(1);
    expect(activities[0]?.label).toBe("Ran");
    expect(activities[0]?.content).toBe("git push origin develop");
    expect(activities[0]?.detail).toBe(
      "To github.com:openpond/sandbox.git\n   0b0d5ad..38dc899  develop -> develop",
    );
    expect(activityGroupSummary(activities)).toBe("Ran a command");
  });

  test("summarizes one command by activity instead of raw command text", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Search the app" },
      }),
      commandStarted("search_1", "turn_1", "rg \"activityGroupSummary\" apps/web/src"),
    ]);

    const activities = messages[1]?.activities ?? [];
    expect(activityGroupSummary(activities)).toBe("Searched code");

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[1]!,
      }),
    );
    expect(html).toContain("Searched code");
    expect(html).not.toContain("activityGroupSummary");
  });

  test("summarizes mixed command groups with deterministic counts", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Inspect chat activity UI" },
      }),
      commandStarted("read_1", "turn_1", "sed -n '1,160p' apps/web/src/components/chat/MessageActivityGroup.tsx"),
      commandStarted("read_2", "turn_1", "cat apps/web/src/lib/chat-activities.ts"),
      commandStarted("search_1", "turn_1", "rg \"activity-summary\" apps/web/src"),
      commandStarted("list_1", "turn_1", "rg --files apps/web/src/components/chat"),
    ]);

    const activities = messages[1]?.activities ?? [];
    expect(activityGroupSummary(activities)).toBe("Read 2 files, searched code, and listed files");
  });

  test("summarizes edits and verification commands", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Patch and test" },
      }),
      commandStarted("edit_1", "turn_1", "apply_patch"),
      commandStarted("check_1", "turn_1", "bun test tests/chat-messages.test.ts"),
    ]);

    const activities = messages[1]?.activities ?? [];
    expect(activityGroupSummary(activities)).toBe("Made edits and ran checks");
  });

  test("renders Codex control prompts as activity rows", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "goal_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "<goal_context>\nKeep the sidebar work in scope.\n</goal_context>" },
      }),
      runtimeEvent({
        id: "abort_1",
        name: "turn.interrupted",
        turnId: "turn_1",
        output: "The user interrupted the previous turn.",
        data: { kind: "turn_aborted" },
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("activity_group");
    expect(messages[0]?.activities?.map((activity) => activity.label)).toEqual(["Goal context", "Turn aborted"]);
    expect(messages[0]?.activities?.[0]?.content).toBe("Keep the sidebar work in scope.");
    expect(messages[0]?.activities?.[1]?.content).toBe("The user interrupted the previous turn.");
  });
});
