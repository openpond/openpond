import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../apps/web/src/lib/app-models";
import {
  buildChatTimelineRows,
  latestAssistantMessageId,
  shouldShowThinkingIndicator,
} from "../apps/web/src/lib/chat-timeline-rows";

describe("chat timeline rows", () => {
  test("derives stable message row ids and footer ownership before rendering", () => {
    const messages = [
      message("turn-1:user", "user", "Request one"),
      message("turn-1:assistant", "assistant", "Response one"),
      message("turn-2:user", "user", "Request two"),
      message("turn-2:assistant", "assistant", "Response two"),
    ];

    const rows = buildChatTimelineRows(messages);

    expect(rows.map((row) => [row.id, row.type])).toEqual([
      ["message:turn-1:user", "message"],
      ["message:turn-1:assistant", "message"],
      ["message:turn-2:user", "message"],
      ["message:turn-2:assistant", "message"],
    ]);
    expect(rows.map((row) => row.type === "message" && row.showFooter)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(latestAssistantMessageId(messages)).toBe("turn-2:assistant");
  });

  test("appends a stable thinking row only when the thread should show thinking", () => {
    const waitingForAssistant = [message("turn-1:user", "user", "Do the work")];
    const rows = buildChatTimelineRows(waitingForAssistant, {
      showThinkingIndicator: shouldShowThinkingIndicator(waitingForAssistant),
    });

    expect(rows.map((row) => [row.id, row.type])).toEqual([
      ["message:turn-1:user", "message"],
      ["thinking", "thinking"],
    ]);
    expect(shouldShowThinkingIndicator([message("turn-1:assistant", "assistant", "Done")])).toBe(false);
  });

  test("does not show thinking while status or activity rows are actively running", () => {
    expect(
      shouldShowThinkingIndicator([
        {
          id: "compaction",
          role: "status_divider",
          content: "Compacting conversation context",
          timestamp: "2026-07-01T10:00:00.000Z",
          statusState: "running",
        },
      ]),
    ).toBe(false);
    expect(
      shouldShowThinkingIndicator([
        {
          id: "tool-group",
          role: "activity_group",
          timestamp: "2026-07-01T10:00:00.000Z",
          activities: [
            {
              id: "tool-1",
              label: "Running",
              content: "pnpm test",
              timestamp: "2026-07-01T10:00:00.000Z",
              state: "running",
            },
          ],
        },
      ]),
    ).toBe(false);
    expect(
      shouldShowThinkingIndicator([
        {
          id: "tool-group",
          role: "activity_group",
          timestamp: "2026-07-01T10:00:00.000Z",
          activities: [
            {
              id: "tool-1",
              label: "Completed",
              content: "pnpm test",
              timestamp: "2026-07-01T10:00:00.000Z",
              state: "completed",
            },
          ],
        },
      ]),
    ).toBe(true);
  });
});

function message(id: string, role: "user" | "assistant", content: string): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: "2026-07-01T10:00:00.000Z",
    turnId: id.split(":")[0],
  };
}
