import { describe, expect, test } from "vitest";
import { SessionSchema, type RuntimeEvent } from "@openpond/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageRow } from "../apps/web/src/components/chat/Messages";
import { attachmentIconKind } from "../apps/web/src/components/chat/AttachmentTypeIcon";
import {
  activityGroupSummary,
  buildChatMessages,
} from "../apps/web/src/lib/chat-messages";
import { connectedAppProviderActivityRows } from "../apps/web/src/lib/connected-app-provider-activity";
import { liveSessionsFromRuntimeEvents } from "../apps/web/src/hooks/useAppEffects";
import {
  activityToolRowLabel,
  subagentMessageNeedsCollapse,
} from "../apps/web/src/components/chat/MessageActivityGroup";
import { workTracePresentation } from "../apps/web/src/lib/chat-work-trace";
import { createImproveRunFixture } from "./helpers/create-improve-fixtures";

function runtimeEvent(input: Omit<RuntimeEvent, "timestamp">): RuntimeEvent {
  return {
    timestamp: "2026-05-16T00:00:00.000Z",
    ...input,
  };
}

function commandStarted(
  id: string,
  turnId: string,
  command: string
): RuntimeEvent {
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
  test("projects subagent receipts as parent transcript activities", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_started",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: { prompt: "start subagents" },
      }),
      runtimeEvent({
        id: "subagent_started",
        name: "subagent.started",
        sessionId: "session_1",
        turnId: "turn_1",
        status: "pending",
        output: "Started coding subagent.",
        data: {
          childSessionId: "session_child",
          run: {
            childSessionId: "session_child",
            roleId: "coding",
            status: "queued",
          },
        },
      }),
      runtimeEvent({
        id: "subagent_completed",
        name: "subagent.completed",
        sessionId: "session_1",
        turnId: "turn_1",
        status: "completed",
        output: "coding subagent completed.",
        data: {
          childSessionId: "session_child",
          run: {
            childSessionId: "session_child",
            roleId: "coding",
            status: "completed",
          },
        },
      }),
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "activity_group",
    ]);
    expect(messages[1]?.activities?.map((activity) => activity.label)).toEqual([
      "Started subagent",
      "Subagent completed",
    ]);
    expect(
      messages[1]?.activities?.map((activity) => activity.content)
    ).toEqual(["Started coding subagent.", "coding subagent completed."]);
    expect(
      messages[1]?.activities?.map((activity) => activity.openSession)
    ).toEqual([
      {
        sessionId: "session_child",
        label: "Open conversation",
        roleId: "coding",
        status: "queued",
      },
      {
        sessionId: "session_child",
        label: "Open conversation",
        roleId: "coding",
        status: "completed",
      },
    ]);
    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[1]!,
        onOpenSession: () => undefined,
      })
    );
    expect(html).toContain("activity-subagent-avatar-group");
    expect(html).toContain("Open Coding subagent (completed) conversation");
  });

  test("renders child handoffs as separate visible right-aligned cards", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_started",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: { prompt: "Diagnose the bug" },
      }),
      commandStarted("search_1", "turn_1", "rg goal apps/server/src"),
      runtimeEvent({
        id: "child_message",
        name: "subagent.message",
        sessionId: "session_1",
        turnId: "turn_1",
        status: "completed",
        data: {
          childSessionId: "session_child_review",
          roleId: "review",
          modelRef: { providerId: "openai", modelId: "gpt-5.6-sol" },
          status: "running",
          message: {
            id: "message_1",
            fromRunId: "run_review",
            kind: "status",
            priority: "interrupt",
            body: "The hidden-directory hypothesis was disproven.",
            refs: [],
            createdAt: "2026-05-16T00:00:00.000Z",
          },
          delivery: {
            status: "delivered",
            deliveredParentSessionId: "session_1",
            wakeParentReason: "parent_turn_active",
          },
        },
      }),
      commandStarted("search_2", "turn_1", "rg scanner apps/server/src"),
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "activity_group",
      "activity_group",
    ]);
    expect(messages[1]?.activities).toHaveLength(2);
    expect(
      messages[1]?.activities?.every((activity) => !activity.subagentMessage)
    ).toBe(true);
    expect(messages[2]?.activities?.[0]?.subagentMessage).toMatchObject({
      direction: "received",
      roleId: "review",
      childSessionId: "session_child_review",
    });

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[2]!,
        onOpenSession: () => undefined,
      })
    );
    expect(html).toContain("activity-child-message-group received");
    expect(html).toContain("Review subagent update · gpt-5.6-sol");
    expect(html).toContain("The hidden-directory hypothesis was disproven.");
    expect(html).not.toContain("Open child conversation");
    expect(html).not.toContain("activity-summary");
  });

  test("collapses long subagent updates behind a five-line show-more control", () => {
    const body = Array.from(
      { length: 7 },
      (_, index) => `Evidence line ${index + 1}`
    ).join("\n");
    const messages = buildChatMessages([
      runtimeEvent({
        id: "child_message_long",
        name: "subagent.message",
        sessionId: "session_1",
        turnId: "turn_1",
        status: "completed",
        data: {
          childSessionId: "session_child_research",
          roleId: "research",
          modelRef: { providerId: "openai", modelId: "gpt-5.6-sol" },
          message: {
            id: "message_long",
            fromRunId: "run_research",
            kind: "handoff",
            body,
            refs: [],
          },
          delivery: {
            status: "delivered",
            deliveredParentSessionId: "session_1",
          },
        },
      }),
    ]);

    expect(subagentMessageNeedsCollapse(body)).toBe(true);
    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[0]!,
        onOpenSession: () => undefined,
      })
    );
    expect(html).toContain('class="collapsed"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show more");
  });

  test("extracts a new child session shell from live subagent start receipts", () => {
    const childSession = SessionSchema.parse({
      id: "session_child_live",
      provider: "openai",
      modelRef: { providerId: "openai", modelId: "gpt-5.6-sol" },
      openPondCommandAccessMode: "ask",
      hiddenFromDefaultSidebar: true,
      parentSessionId: "session_parent",
      parentTurnId: "turn_parent",
      subagentRunId: "run_live",
      subagentRoleId: "research",
      title: "Research: live child",
      appId: null,
      appName: null,
      cwd: "/tmp/openpond",
      codexThreadId: null,
      createdAt: "2026-07-09T20:28:56.212Z",
      updatedAt: "2026-07-09T20:28:56.212Z",
      status: "idle",
      pinned: false,
      archived: false,
      order: 3,
    });
    const sessions = liveSessionsFromRuntimeEvents([
      runtimeEvent({
        id: "subagent_started_live",
        name: "subagent.started",
        sessionId: "session_parent",
        turnId: "turn_parent",
        status: "pending",
        data: { childSession },
      }),
    ]);

    expect(sessions).toEqual([childSession]);
  });

  test("extracts an API-created session shell from live session start receipts", () => {
    const workSession = SessionSchema.parse({
      id: "session_work_live",
      experience: "work",
      provider: "openpond",
      modelRef: null,
      openPondCommandAccessMode: "ask",
      hiddenFromDefaultSidebar: false,
      title: "Hosted diagnostic corpus review",
      appId: null,
      appName: null,
      cwd: null,
      codexThreadId: null,
      createdAt: "2026-07-30T19:37:55.382Z",
      updatedAt: "2026-07-30T19:37:55.382Z",
      status: "idle",
      pinned: false,
      archived: false,
      order: 130,
    });
    const sessions = liveSessionsFromRuntimeEvents([
      runtimeEvent({
        id: "session_started_work_live",
        name: "session.started",
        sessionId: workSession.id,
        source: "server",
        data: { session: workSession },
      }),
    ]);

    expect(sessions).toEqual([workSession]);
  });

  test("keeps subagent state visible in mixed parent activity summaries", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_started",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: { prompt: "start a research subagent" },
      }),
      runtimeEvent({
        id: "subagent_started",
        name: "subagent.started",
        sessionId: "session_1",
        turnId: "turn_1",
        status: "started",
        timestamp: "2026-05-16T00:00:00.000Z",
        output: "Research subagent started.",
        data: {
          childSessionId: "session_child",
          run: {
            childSessionId: "session_child",
            roleId: "research",
            status: "running",
          },
        },
      }),
      commandStarted(
        "read_1",
        "turn_1",
        "sed -n '1,160p' apps/server/src/runtime/turn-runner.ts"
      ),
      commandStarted(
        "search_1",
        "turn_1",
        'rg "openpond_subagent_start" apps/server/src tests'
      ),
      runtimeEvent({
        id: "subagent_completed",
        name: "subagent.completed",
        sessionId: "session_1",
        turnId: "turn_1",
        status: "completed",
        output: "Research subagent completed.",
        data: {
          childSessionId: "session_child",
          run: {
            childSessionId: "session_child",
            roleId: "research",
            status: "completed",
          },
        },
      }),
    ]);

    const activities = messages[1]?.activities ?? [];
    expect(activityGroupSummary(activities)).toBe(
      "Subagent completed, read a file, and searched code"
    );

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[1]!,
        onOpenSession: () => undefined,
      })
    );
    expect(html).toContain(
      "Searching for &quot;openpond_subagent_start&quot; in apps/server/src and tests"
    );
    expect(html).not.toContain(
      "Subagent completed, read a file, and searched code"
    );
    expect(html).toContain("activity-subagent-avatar-group");
    expect(html).toContain("Open Research subagent (completed) conversation");
  });

  test("deduplicates running subagent receipts in parent activity summaries", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_started",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: { prompt: "start a visible test subagent" },
      }),
      runtimeEvent({
        id: "subagent_started",
        name: "subagent.started",
        sessionId: "session_1",
        turnId: "turn_1",
        status: "started",
        output: "Test subagent queued.",
        data: {
          childSessionId: "session_child",
        },
      }),
      runtimeEvent({
        id: "subagent_running",
        name: "subagent.started",
        sessionId: "session_1",
        turnId: "turn_1",
        status: "started",
        output: "Test subagent running.",
        data: {
          run: {
            childSessionId: "session_child",
          },
        },
      }),
    ]);

    const activities = messages[1]?.activities ?? [];
    expect(activityGroupSummary(activities)).toBe("Subagent running");
  });

  test("keeps model reasoning out of the visible work trace and answer", () => {
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

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "activity_group",
      "assistant",
    ]);
    expect(messages[1]).toMatchObject({
      role: "activity_group",
      traceState: "settled",
    });
    expect(messages[1]?.activities).toMatchObject([
      {
        kind: "reasoning",
        content: "The user is greeting Z.ai. It should answer briefly.",
      },
    ]);
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: "Hello z.ai",
    });

    const html = renderToStaticMarkup(
      createElement(MessageRow, { message: messages[1]! })
    );
    expect(html).toContain("Thought through the request");
    expect(html).not.toContain("Working…");
    expect(html).not.toContain("The user is greeting Z.ai.");
    expect(html).not.toContain("It should answer briefly.");
    expect(html).not.toContain(">Reasoning<");
    expect(html).not.toContain("Hello z.ai");

    const assistantHtml = renderToStaticMarkup(
      createElement(MessageRow, { message: messages[2]! })
    );
    expect(assistantHtml).toContain("Hello z.ai");
    expect(assistantHtml).not.toContain("The user is greeting Z.ai.");
  });

  test("groups reasoning and actions across alternating tool runs", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_started",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: { prompt: "find chat code" },
      }),
      runtimeEvent({
        id: "reasoning_1",
        name: "assistant.reasoning.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output: "I need to find the relevant files.",
      }),
      runtimeEvent({
        id: "tool_started",
        name: "tool.started",
        sessionId: "session_1",
        turnId: "turn_1",
        action: "resource_search",
        status: "started",
        args: { scope: "workspace", query: "chat composer" },
      }),
      runtimeEvent({
        id: "tool_completed",
        name: "tool.completed",
        sessionId: "session_1",
        turnId: "turn_1",
        action: "resource_search",
        status: "completed",
        output: "Found 2 resources.",
      }),
      runtimeEvent({
        id: "reasoning_2",
        name: "assistant.reasoning.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output: "Now I can inspect the candidate.",
      }),
      runtimeEvent({
        id: "assistant_1",
        name: "assistant.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output: "I found the chat files.",
      }),
      runtimeEvent({
        id: "turn_completed",
        name: "turn.completed",
        sessionId: "session_1",
        turnId: "turn_1",
        status: "completed",
      }),
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "activity_group",
      "assistant",
    ]);
    expect(messages[1]?.traceState).toBe("completed");
    expect(messages[1]?.activities?.map((activity) => activity.label)).toEqual([
      "Reasoning",
      "Searched resources",
      "Reasoning",
    ]);
    expect(
      messages[1]?.activities?.map((activity) => activity.content)
    ).toEqual([
      "I need to find the relevant files.",
      "Found 2 resources.",
      "Now I can inspect the candidate.",
    ]);
    expect(activityGroupSummary(messages[1]?.activities ?? [])).toBe(
      "Searched code"
    );
    expect(messages[2]?.content).toBe("I found the chat files.");

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: {
          ...messages[1]!,
          traceStartedAt: "2026-07-22T15:00:00.000Z",
          traceCompletedAt: "2026-07-22T15:01:24.000Z",
        },
      })
    );
    expect(html).toContain("Worked for 1m 24s · Searched code");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("I need to find the relevant files.");
    expect(html).not.toContain("Now I can inspect the candidate.");
    expect(html).not.toContain("Found 2 resources.");
    expect(html).not.toContain("Searched resources");
    const expandedActivities = workTracePresentation(
      messages[1]?.activities ?? [],
      true
    ).visibleActivities;
    expect(expandedActivities).toMatchObject([
      {
        content: "Found 2 resources.",
      },
    ]);
    expect(
      expandedActivities.some((activity) => activity.kind === "reasoning")
    ).toBe(false);
  });

  test("settles earlier work summaries while only the active tail keeps working", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_started",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: { prompt: "inspect the renderer" },
      }),
      commandStarted("search_1", "turn_1", "rg activity-summary apps/web/src"),
      runtimeEvent({
        id: "commentary_1",
        name: "assistant.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output: "I found the summary renderer.",
      }),
      commandStarted("list_1", "turn_1", "ls apps/web/src/components/chat"),
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "activity_group",
      "assistant",
      "activity_group",
    ]);
    expect(messages[1]?.traceState).toBe("settled");
    expect(messages[3]?.traceState).toBe("running");

    const settledHtml = renderToStaticMarkup(
      createElement(MessageRow, { message: messages[1]! })
    );
    const runningHtml = renderToStaticMarkup(
      createElement(MessageRow, { message: messages[3]! })
    );
    expect(settledHtml).toContain(
      "Searched for &quot;activity-summary&quot; in apps/web/src"
    );
    expect(settledHtml).not.toContain("Working…");
    expect(settledHtml).not.toContain(" working");
    expect(settledHtml).toContain('aria-expanded="false"');
    expect(runningHtml).toContain(
      "Listing files in apps/web/src/components/chat"
    );
    expect(runningHtml).toContain(" working");
    expect(runningHtml).toContain('aria-expanded="false"');
    expect(runningHtml).not.toContain("Running command");
  });

  test("keeps completed reasoning hidden beneath a factual work summary", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_started",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: { prompt: "check draft cleanup" },
      }),
      runtimeEvent({
        id: "reasoning_1",
        name: "assistant.reasoning.delta",
        sessionId: "session_1",
        turnId: "turn_1",
        output:
          "I found the branch in `app-state.ts`.\n```ts\nconst prompt = String(nextValue);\n```\n" +
          `${"This is progress context. ".repeat(
            45
          )}\nNow I need to find \`setPrompt(\"\")\`.`,
      }),
      runtimeEvent({
        id: "turn_completed",
        name: "turn.completed",
        sessionId: "session_1",
        turnId: "turn_1",
        status: "completed",
      }),
    ]);

    const html = renderToStaticMarkup(
      createElement(MessageRow, { message: messages[1]! })
    );
    expect(html).toContain("Worked · Thought through the request");
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("I found the branch");
    expect(html).not.toContain("app-state.ts");
    expect(html).not.toContain("const prompt");
    expect(html).not.toContain("setPrompt");
    expect(messages[1]?.activities?.[0]?.content).toContain("const prompt");
    expect(messages[1]?.activities?.[0]?.content).toContain("setPrompt");
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
      })
    );

    expect(html).toContain("OpenPond Chat allowance reached");
    expect(html).toContain(
      "https://qa.openpond.example/sandboxes/example-org/billing"
    );
    expect(html).not.toContain("OpenPond OpChat stream failed");
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
              lineCount: 3,
              filePreview: {
                sessionId: "session_1",
                turnId: "turn_1",
                attachmentId: "attachment_2",
                storageName: "notes.txt",
                contentType: "text/plain",
              },
            },
            {
              id: "attachment_3",
              name: "source.zip",
              mediaType: "application/zip",
              sizeBytes: 4096,
              kind: "file",
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
        connection: {
          serverUrl: "http://127.0.0.1:17876",
          token: "token",
          platform: "test",
        },
      })
    );
    expect(html).toContain("has-image-attachments");
    expect(html).toContain("user-message-image-attachment");
    expect(html).toContain("Screenshot from 2026-07-02 13.49.59.png");
    expect(html).toContain("notes.txt");
    expect(html).toContain("source.zip");
    expect(html).toContain("user-message-attachment");
    expect(html).toContain("3 lines");
    expect(html).not.toContain("128 B");
    expect(html).not.toContain("44 KB");
    const codexHtml = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[0]!,
        onOpenAttachmentInSidebar: async () => undefined,
        userAttachmentDisplay: "compact",
      })
    );
    expect(codexHtml).toContain("Can you inspect this bug screenshot?");
    expect(codexHtml).toContain("user-message-attachments compact");
    expect(codexHtml).toContain("Screenshot from 2026-07-02 13.49.59.png");
    expect(codexHtml).toContain("notes.txt");
    expect(codexHtml).toContain("source.zip");
    expect(codexHtml).toContain("Open attached file notes.txt");
    expect(codexHtml).toContain("user-message-attachment openable");
    expect(codexHtml).toContain("3 lines");
    expect(codexHtml).not.toContain("128 B");
    expect(codexHtml).not.toContain("44 KB");
    expect(codexHtml).not.toContain("user-message-image-attachment");
    expect(codexHtml).not.toContain("has-image-attachments");
  });

  test("selects distinct icons for common attachment families", () => {
    const iconKind = (name: string, mediaType: string, kind: "image" | "text" | "file" = "file") =>
      attachmentIconKind({ name, mediaType, kind });

    expect(iconKind("screen.png", "image/png", "image")).toBe("image");
    expect(iconKind("component.tsx", "text/typescript", "text")).toBe("code");
    expect(iconKind("report.pdf", "application/pdf")).toBe("document");
    expect(iconKind("results.csv", "text/csv", "text")).toBe("spreadsheet");
    expect(iconKind("source.zip", "application/zip")).toBe("archive");
    expect(iconKind("recording.wav", "audio/wav")).toBe("audio");
    expect(iconKind("demo.mp4", "video/mp4")).toBe("video");
    expect(iconKind("brief.pptx", "application/octet-stream")).toBe("presentation");
    expect(iconKind("artifact.bin", "application/octet-stream")).toBe("file");
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
        connection: {
          serverUrl: "http://127.0.0.1:17876",
          token: "token",
          platform: "test",
        },
      })
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
        connection: {
          serverUrl: "http://127.0.0.1:17876",
          token: "token",
          platform: "test",
        },
      })
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
        output:
          "Goals were by Folarin Balogun and Malik Tillman. Sources: U.S. Soccer, ESPN.",
      }),
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "activity_group",
      "assistant",
    ]);
    expect(messages[2]?.sources?.map((source) => source.sourceName)).toEqual([
      "U.S. Soccer",
      "ESPN",
    ]);

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[2]!,
        onOpenBrowserLink: () => undefined,
      })
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
      })
    );
    expect(html).toContain("There are 13 image files");
    expect(html).toContain("markdown-file-image-reference");
    expect(html).toContain("markdown-file-image-preview ready");
    expect(html).toContain('src="./openpond-icon.png"');
    expect(html).toContain('src="./connected-apps/github.svg"');
  });

  test("projects Create/Improve turn metadata into a review message", () => {
    const now = "2026-05-16T00:00:00.000Z";
    const createImproveRun = createImproveRunFixture({
      id: "create_improve_1",
      objective: "Create a release notes agent",
      state: "awaiting_plan_approval",
      adapter: {
        kind: "hosted",
        sourceAuthority: "hosted_profile",
        teamId: "team_1",
        projectId: "profile_project_1",
        activeProfile: "default",
        sourceRef: "main",
        baseSha: null,
        confirmationPolicy: "always_require_plan_approval",
      },
      scope: {
        profileId: "default",
        conversationId: "session_1",
        originTurnId: "turn_1",
        projectId: "profile_project_1",
        targetProject: null,
      },
      target: {
        kind: "agent",
        id: "release-notes-agent",
        displayName: "Release Notes Agent",
        defaultActionKey: "release-notes-agent.chat",
      },
      metadata: { source: "web_composer_slash" },
      createdAt: now,
      updatedAt: now,
    });
    const applyingRun = createImproveRunFixture({
      ...createImproveRun,
      revision: 1,
      state: "applying_source",
      appliedActionIds: ["approve_create_improve_1"],
      updatedAt: now,
    });

    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: {
          prompt: "/create release notes agent",
          createImproveRun,
        },
      }),
      runtimeEvent({
        id: "create_improve_approved",
        name: "create_improve.updated",
        sessionId: "session_1",
        turnId: "turn_1",
        data: {
          createImproveRun: applyingRun,
        },
      }),
      runtimeEvent({
        id: "create_plan_approval_requested",
        name: "approval.requested",
        sessionId: "session_1",
        turnId: "turn_1",
        action: "create_plan",
        status: "pending",
        output: "Approve create plan",
        data: { id: "approval_create_plan" },
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

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "activity_group",
    ]);
    expect(messages[1]?.createImproveRun?.objective).toBe(
      "Create a release notes agent"
    );
    expect(messages[1]?.createImproveRun?.state).toBe("applying_source");
    expect(messages[1]?.content).toBeUndefined();
    expect(messages[1]?.actionRun).toBeUndefined();
    expect(messages[2]?.content).toBe(
      "I will inspect the existing profile and create files now."
    );
    expect(messages[3]?.activities).toHaveLength(1);
    expect(messages[3]?.activities?.[0]).toMatchObject({
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
        args: {
          prompt: "Which open customer support items need attention first?",
        },
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

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(messages[1]?.actionRun?.actionName).toBe(
      "help-me-keep-track-of-open-customer-support-item.chat"
    );
    expect(messages[1]?.actionRun?.title).toBe("Chat");
    expect(messages[1]?.actionRun?.status).toBe("completed");
    expect(messages[1]?.actionRun?.responseText).toBe(supportSummary);
    expect(messages[1]?.actionRun?.implementationType).toBe(
      "openpond-profile-action"
    );
    expect(messages[1]?.actionRun?.refs.map((ref) => ref.target)).toEqual([
      "open-support-items-summary.json",
      ".openpond/traces/run-chat-123.jsonl",
    ]);

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[1]!,
        onOpenProfileSettings: () => undefined,
      })
    );
    expect(html).toContain("Open customer support tracker: 4 open items.");
    expect(html).not.toContain("Agent:");
    expect(html).toContain("action-run-agent-link");
    expect(html).toContain("Open Items Assistant");
    expect(html).not.toContain(
      "help-me-keep-track-of-open-customer-support-item"
    );
    expect(html).not.toContain("action-run-card");
    expect(html).not.toContain("openpond-profile-action");
    expect(html).not.toContain(".openpond/traces/run-chat-123.jsonl");
  });

  test("projects workspace timing and checkpoint metadata into activity details", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "workspace_result",
        name: "workspace_action_result",
        sessionId: "session_1",
        turnId: "turn_1",
        source: "chat_action",
        action: "sandbox_edit_file",
        status: "completed",
        output:
          "Edited README.md with 1 replacement.\nCheckpoint saved: abcdef1234567890.",
        data: {
          workspaceToolCallId: "workspace_call_1",
          workspaceToolTiming: {
            startedAt: "2026-07-05T10:00:00.000Z",
            completedAt: "2026-07-05T10:00:01.250Z",
            durationMs: 1250,
          },
          workspaceExecutionTarget: {
            target: "sandbox",
            sandboxId: "sandbox_hybrid_1234567890",
            hybrid: true,
          },
          sourcePreservation: {
            attempted: true,
            ok: true,
            preserved: true,
            sandboxId: "sandbox_hybrid_1234567890",
            preservedSha: "abcdef1234567890",
          },
        },
      }),
    ]);

    expect(messages[0]?.role).toBe("activity_group");
    expect(messages[0]?.activities?.[0]).toMatchObject({
      label: "Edited sandbox file",
      meta: "1.3 s · Hybrid sandbox sandbo...7890 · checkpoint abcdef123456",
    });
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

    expect(messages[1]?.actionRun?.implementationType).toBe(
      "openpond-profile-action"
    );

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[1]!,
      })
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

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "status_divider",
      "assistant",
    ]);
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
    expect(messages[1]?.activities?.[0]?.content).toBe(
      "Loaded profile skill release-notes."
    );
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
        action: "openpond_create_improve",
        status: "started",
        args: { objective: "Create a support triage agent." },
      }),
      runtimeEvent({
        id: "create_completed",
        name: "tool.completed",
        turnId: "turn_1",
        action: "openpond_create_improve",
        status: "completed",
        output: JSON.stringify({
          ok: true,
          output: "Create Pipeline plan is ready for review.",
        }),
        data: {
          result: {
            nextStep: "Create Pipeline plan is ready for review.",
          },
        },
      }),
    ]);

    expect(messages[1]?.role).toBe("activity_group");
    expect(messages[1]?.activities?.map((activity) => activity.label)).toEqual([
      "Started Create Pipeline",
    ]);
    expect(
      messages[1]?.activities?.map((activity) => activity.content)
    ).toEqual(["Create a support triage agent."]);
    expect(messages[1]?.activities?.map((activity) => activity.detail)).toEqual(
      ["Create Pipeline plan is ready for review."]
    );
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
        args: {
          text: "[redacted 18 chars]",
          snapshotId: "snap_1",
          targetRef: "input_1",
        },
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
      "Opened browser",
      "Typed in browser",
    ]);
    expect(
      messages[1]?.activities?.map((activity) => activity.content)
    ).toEqual(["https://example.com/login?[redacted]", "Text redacted"]);
    expect(messages[1]?.activities?.map((activity) => activity.detail)).toEqual(
      ["Opened browser.", "Typed in browser."]
    );
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
    ]);
    expect(
      messages[1]?.activities?.map((activity) => activity.content)
    ).toEqual(["x.search.posts / 1 capability"]);
    expect(messages[1]?.activities?.map((activity) => activity.detail)).toEqual(
      ["search / 1 capability"]
    );

    const html = renderToStaticMarkup(
      createElement(MessageRow, { message: messages[1]! })
    );
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
    expect(JSON.stringify(providerRows)).not.toContain(
      "conn_should_not_render"
    );
    expect(JSON.stringify(providerRows)).not.toContain(
      "token_should_not_render"
    );
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
      "To github.com:openpond/sandbox.git\n   0b0d5ad..38dc899  develop -> develop"
    );
    expect(activityGroupSummary(activities)).toBe("Pushed changes");
  });

  test("keeps failed exec details collapsed without transport JSON", () => {
    const result = JSON.stringify({
      ok: false,
      action: "exec_command",
      output: "Command exited with code 1.",
      data: {
        command: "./cli promote production",
        cwd: "/repo",
        exitCode: 1,
        stdout: "Fetching origin/develop\nPromotion refused",
        stderr: "",
      },
    });
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Promote production" },
      }),
      runtimeEvent({
        id: "tool_started",
        name: "tool.started",
        turnId: "turn_1",
        action: "exec_command",
        status: "started",
        data: {
          toolCallId: "call_1",
          tool: "exec_command",
          arguments: JSON.stringify({ cmd: "./cli promote production" }),
        },
      }),
      {
        ...runtimeEvent({
          id: "tool_completed",
          name: "tool.completed",
          turnId: "turn_1",
          action: "exec_command",
          status: "failed",
          output: result,
          data: {
            toolCallId: "call_1",
            tool: "exec_command",
          },
        }),
        timestamp: "2026-05-16T00:00:01.000Z",
      },
    ]);

    const activity = messages[1]?.activities?.[0];
    expect(activity).toMatchObject({
      content: "./cli promote production",
      detail: "Fetching origin/develop\nPromotion refused",
      state: "failed",
      terminal: { exitCode: 1, durationMs: 1000 },
    });

    const html = renderToStaticMarkup(
      createElement(MessageRow, { message: messages[1]! })
    );
    expect(html).toContain("Command failed");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Ran command in 1s");
    expect(html).not.toContain("activity-command-terminal");
    expect(html).not.toContain("Fetching origin/develop");
    expect(html).not.toContain("&quot;action&quot;:&quot;exec_command&quot;");
  });

  test("unwraps sandbox command failure envelopes without inventing an exit code", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Run a sandbox command" },
      }),
      commandStarted("tool_started", "turn_1", "printf 'hello'"),
      runtimeEvent({
        id: "command_output",
        name: "command.output",
        turnId: "turn_1",
        status: "failed",
        output: JSON.stringify({
          ok: false,
          action: "work_environment",
          output: "Work sandbox entered error during startup.",
        }),
        data: { toolCallId: "tool_started" },
      }),
    ]);

    const activity = messages[1]?.activities?.[0];
    expect(activity?.detail).toBe("Work sandbox entered error during startup.");
    const html = renderToStaticMarkup(
      createElement(MessageRow, { message: messages[1]! })
    );
    expect(html).not.toContain("Work sandbox entered error during startup.");
    expect(html).not.toContain("activity-command-terminal");
    expect(html).not.toContain("&quot;action&quot;:&quot;work_environment&quot;");
  });

  test("summarizes one command by activity instead of raw command text", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Search the app" },
      }),
      commandStarted(
        "search_1",
        "turn_1",
        'rg "activityGroupSummary" apps/web/src'
      ),
    ]);

    const activities = messages[1]?.activities ?? [];
    expect(activityGroupSummary(activities)).toBe(
      'Searched for "activityGroupSummary" in apps/web/src'
    );

    const html = renderToStaticMarkup(
      createElement(MessageRow, {
        message: messages[1]!,
      })
    );
    expect(html).toContain(
      "Searching for &quot;activityGroupSummary&quot; in apps/web/src"
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Running command");
    expect(html).not.toContain("activity-command-terminal");
    expect(html).not.toContain("Searched code");
  });

  test("uses semantic command labels with duration for activity rows", () => {
    expect(
      activityToolRowLabel({
        id: "read_command",
        label: "Ran",
        content: "sed -n '1,120p' app.ts",
        timestamp: "2026-05-16T00:00:01.000Z",
        kind: "command",
        state: "completed",
        terminal: { durationMs: 1_000 },
      })
    ).toBe("Read lines 1-120 of app.ts in 1s");
    expect(
      activityToolRowLabel({
        id: "search_command",
        label: "Running",
        content: 'rg "activity-summary" apps/web/src',
        timestamp: "2026-05-16T00:00:01.000Z",
        kind: "command",
        state: "running",
      })
    ).toBe('Searching for "activity-summary" in apps/web/src');
    expect(
      activityToolRowLabel({
        id: "failed_command",
        label: "Failed",
        content: "pnpm test",
        timestamp: "2026-05-16T00:00:01.000Z",
        kind: "command",
        state: "failed",
        terminal: { durationMs: 1_000 },
      })
    ).toBe("Command failed in 1s");
  });

  test("merges workspace action results into the started activity row", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "sandbox_create_started",
        name: "workspace_action",
        action: "sandbox_create",
        status: "started",
        sessionId: "session_1",
      }),
      runtimeEvent({
        id: "sandbox_create_completed",
        name: "workspace_action_result",
        action: "sandbox_create",
        status: "completed",
        sessionId: "session_1",
        output: "Sandbox workspace attached: sandbox_123 (creating)",
      }),
    ]);

    const activities = messages[0]?.activities ?? [];
    expect(activities).toHaveLength(1);
    expect(activities[0]?.label).toBe("Started sandbox");
    expect(activities[0]?.content).toBe(
      "Sandbox workspace attached: sandbox_123 (creating)"
    );
    expect(activities[0]?.state).toBe("completed");

    const html = renderToStaticMarkup(
      createElement(MessageRow, { message: messages[0]! })
    );
    expect(html).toContain("Started sandbox");
    expect(html).not.toContain("Starting sandbox");
  });

  test("merges failed workspace action results into the started activity row", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "sandbox_stop_started",
        name: "workspace_action",
        action: "sandbox_stop",
        status: "started",
        sessionId: "session_1",
      }),
      runtimeEvent({
        id: "sandbox_stop_failed",
        name: "workspace_action_result",
        action: "sandbox_stop",
        status: "failed",
        sessionId: "session_1",
        output: "Sandbox stop failed.",
      }),
    ]);

    const activities = messages[0]?.activities ?? [];
    expect(activities).toHaveLength(1);
    expect(activities[0]?.label).toBe("Sandbox stop failed");
    expect(activities[0]?.content).toBe("Sandbox stop failed.");
    expect(activities[0]?.state).toBe("failed");
  });

  test("summarizes mixed generic workspace actions instead of hiding later actions", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "sandbox_preserve_started",
        name: "workspace_action",
        action: "sandbox_preserve_source",
        status: "started",
        sessionId: "session_1",
      }),
      runtimeEvent({
        id: "sandbox_preserve_failed",
        name: "workspace_action_result",
        action: "sandbox_preserve_source",
        status: "failed",
        sessionId: "session_1",
        output: "placement_stale",
      }),
      runtimeEvent({
        id: "sandbox_stop_started",
        name: "workspace_action",
        action: "sandbox_stop",
        status: "started",
        sessionId: "session_1",
      }),
      runtimeEvent({
        id: "sandbox_stop_completed",
        name: "workspace_action_result",
        action: "sandbox_stop",
        status: "completed",
        sessionId: "session_1",
        output: "Stopped sandbox.",
      }),
    ]);

    const activities = messages[0]?.activities ?? [];
    expect(activities).toHaveLength(2);
    expect(activityGroupSummary(activities)).toBe(
      "Preserve failed and stopped sandbox"
    );
  });

});
