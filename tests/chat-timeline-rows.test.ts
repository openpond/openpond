import { groupActivityRuns } from "../apps/web/src/lib/chat-activity-runs";
import { describe, expect, test } from "vitest";
import type { ChatMessage } from "../apps/web/src/lib/app-models";
import {
  buildChatTimelineRows,
  chatTimelineMessages,
  latestAssistantMessageId,
  shouldShowThinkingIndicator,
} from "../apps/web/src/lib/chat-timeline-rows";

describe("chat timeline rows", () => {

  // A completed turn or late delivery must never hide peer communication.
  // Preserve every message and its position as the transcript grows.
  test("keeps late sent/received exchanges visible after completion", () => {
    const user = message("turn:user", "user", "Request");
    const final = {...message("turn:answer", "assistant", "Done"), finalAnswer: true};
    const exchanges: ChatMessage[] = Array.from({length: 1001}, (_, index) => ({
      id: `peer-${index}`, role: "task_message", content: `Original exchange ${index}`,
      timestamp: "2026-07-01T10:01:00.000Z",
    }));
    const next = message("next:user", "user", "Next question");
    const rows = buildChatTimelineRows([user, final, ...exchanges, next]);
    expect(rows.every(row => row.type === "message")).toBe(true);
    expect(chatTimelineMessages(rows)).toEqual([user, final, ...exchanges, next]);
    const partial = buildChatTimelineRows([user, final, exchanges[0]!]);
    expect(rows[2]?.id).toBe(partial[2]?.id);
    expect(rows.slice(2, -1).map(row => row.type === "message" && row.message)).toEqual(exchanges);
    const commentary = message("turn:commentary", "assistant", "A direct update");
    const split = buildChatTimelineRows([exchanges[0]!, commentary, exchanges[1]!]);
    expect(split.map(row => row.type)).toEqual(["message", "message", "message"]);
    expect(chatTimelineMessages(split)).toEqual([exchanges[0], commentary, exchanges[1]]);
  });

  // Completing or steering a turn can collapse work, but must leave both
  // directions of peer communication visible in their original positions.
  test("keeps peer messages visible through live work, completion, and steering", () => {
    const user = message("turn:user", "user", "Ask the agent");
    const command: ChatMessage = {id: "first-command", role: "activity_group", turnId: "turn", timestamp: user.timestamp,
      activities: [{id: "tool", label: "Ran", content: "followup", timestamp: user.timestamp}]};
    const sent: ChatMessage = {id: "sent", role: "task_message", timestamp: user.timestamp, content: "Calculate 2+2"};
    const received: ChatMessage = {...sent, id: "received", turnId: "turn", content: "4"};
    const after: ChatMessage = {...command, id: "after-command"};
    const answer = {...message("turn:answer", "assistant", "The result is 4"), finalAnswer: true};
    const steer: ChatMessage = {...message("turn:steer", "user", "Continue"), interactionKind: "steer"};
    const stages = [[user, command], [user, command, sent], [user, command, sent, received],
      [user, command, sent, received, after, answer], [user, command, sent, received, after, steer],
      [user, command, sent, received, after, message("next:user", "user", "Next")]];
    for (const messages of stages) {
      const rows = buildChatTimelineRows(messages);
      if (messages.at(-1) === answer || messages.at(-1) === steer) {
        const work = rows.filter(row => row.type === "work");
        expect(work).toHaveLength(2);
        expect(work[0]?.id).toBe("work:first-command");
      } else {
        expect(rows.some(row => row.type === "message" && row.message === command)).toBe(true);
      }
      for (const peer of [sent, received].filter(peer => messages.includes(peer))) {
        expect(rows.some(row => row.type === "message" && row.message === peer)).toBe(true);
        expect(groupActivityRuns(rows.flatMap(row => row.type === "message" ? [row] : []))
          .some(row => row.message === peer)).toBe(true);
      }
      expect(chatTimelineMessages(rows)).toEqual(messages);
    }
  });

  // A tool run must stop at a peer message so its details cannot swallow the receipt.
  test("combines only adjacent tool groups and preserves peer rows between them", () => {
    const tool = (id: string): ChatMessage => ({id, role: "activity_group", timestamp: "2026-07-01T10:00:00Z",
      activities: [{id: `${id}-call`, label: "Ran command", content: id, timestamp: "2026-07-01T10:00:00Z"}]});
    const peer: ChatMessage = {id: "peer", role: "task_message", timestamp: "2026-07-01T10:00:00Z", content: "Result"};
    const original = [tool("one"), peer, tool("two"), tool("three")];
    const rows = original.map(message => ({id: `message:${message.id}`, type: "message" as const, message, showFooter: false}));
    const grouped = groupActivityRuns(rows);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]?.id).toBe(rows[0]?.id);
    expect(grouped[0]?.message).toBe(original[0]);
    expect(grouped[1]?.message).toBe(peer);
    expect(grouped[2]?.message.activities?.map(activity => activity.id)).toEqual(["two-call", "three-call"]);
    expect(grouped[2]?.message.activityMessages).toEqual(original.slice(2));
    expect(original[0]?.activityMessages).toBeUndefined();
    expect(groupActivityRuns(rows.slice(0, 2))[0]?.id).toBe(grouped[0]?.id);
    const response = {id: "message:response", type: "message" as const, message: message("turn:response", "assistant", "A direct update"), showFooter: false};
    expect(groupActivityRuns([...rows, response, ...rows]).map(row => row.id)).toEqual([rows[0]?.id, rows[1]?.id, rows[2]?.id, response.id, rows[0]?.id, rows[1]?.id, rows[2]?.id]);
  });

  test("derives stable message row ids before rendering", () => {
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
