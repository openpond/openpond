import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "@openpond/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageRow } from "../apps/web/src/components/chat/Messages";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages";

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

describe("chat message interrupted turn projection", () => {
  test("settles orphaned work when a newer turn starts", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1_started",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_1",
        args: { prompt: "inspect the renderer" },
      }),
      commandStarted("search_1", "turn_1", "rg activity-summary apps/web/src"),
      runtimeEvent({
        id: "turn_2_started",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_2",
        args: { prompt: "continue the active goal" },
      }),
      commandStarted(
        "read_1",
        "turn_2",
        "sed -n '1,200p' apps/web/src/lib/chat-messages.ts"
      ),
      runtimeEvent({
        id: "turn_3_started",
        name: "turn.started",
        sessionId: "session_1",
        turnId: "turn_3",
        args: { prompt: "finish the check" },
      }),
      commandStarted("list_1", "turn_3", "ls apps/web/src/components/chat"),
    ]);

    const activityGroups = messages.filter(
      (message) => message.role === "activity_group"
    );
    expect(activityGroups.map((message) => message.traceState)).toEqual([
      "settled",
      "settled",
      "running",
    ]);

    const html = activityGroups
      .map((message) =>
        renderToStaticMarkup(createElement(MessageRow, { message }))
      )
      .join("");
    expect(html).not.toContain("Working…");
    expect(html).toContain(
      "Searched for &quot;activity-summary&quot; in apps/web/src"
    );
    expect(html).toContain(
      "Read lines 1-200 of apps/web/src/lib/chat-messages.ts"
    );
    expect(html).toContain("Listing files in apps/web/src/components/chat");
  });

  test("keeps completed command artifacts visible when a turn is interrupted", () => {
    const messages = buildChatMessages([
      runtimeEvent({
        id: "turn_1",
        name: "turn.started",
        turnId: "turn_1",
        args: { prompt: "Render the video" },
      }),
      commandStarted("render_1", "turn_1", "ffmpeg -i input.mp4 output.mp4"),
      runtimeEvent({
        id: "render_done",
        name: "tool.completed",
        turnId: "turn_1",
        action: "exec_command",
        status: "completed",
        data: {
          toolCallId: "render_1",
          result: {
            artifacts: [
              {
                artifactRef: "/tmp/output.mp4",
                path: "/tmp/output.mp4",
                title: "output.mp4",
                contentType: "video/mp4",
                sizeBytes: 1024,
                binary: true,
              },
            ],
          },
        },
      }),
      runtimeEvent({
        id: "interrupted",
        name: "turn.interrupted",
        turnId: "turn_1",
        output: "Interrupted because the local app server stopped.",
      }),
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "activity_group",
      "status_divider",
    ]);
    expect(messages[1]?.activities?.[0]?.artifacts).toEqual([
      expect.objectContaining({
        path: "/tmp/output.mp4",
        contentType: "video/mp4",
        sizeBytes: 1024,
      }),
    ]);
    expect(messages[1]?.deliverables).toEqual([
      expect.objectContaining({
        path: "/tmp/output.mp4",
        contentType: "video/mp4",
        sizeBytes: 1024,
      }),
    ]);
    expect(messages[2]).toMatchObject({
      content: "Interrupted by app restart",
      statusKind: "interruption",
    });
    const html = renderToStaticMarkup(
      createElement(MessageRow, { message: messages[1]! })
    );
    expect(html).toContain("activity-artifact");
    expect(html).toContain("output.mp4");
    expect(html).toContain("1.0 KB");
  });
});
