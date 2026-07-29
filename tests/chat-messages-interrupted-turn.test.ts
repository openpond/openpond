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
