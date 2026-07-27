import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { RuntimeEvent } from "../packages/contracts/src";
import { MessageRow } from "../apps/web/src/components/chat/Messages";
import { buildChatMessages } from "../apps/web/src/lib/chat-messages";

describe("durable normal-turn user questions", () => {
  test("projects and renders a pending question independently of Goal state", () => {
    const messages = buildChatMessages([askedEvent()]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.userQuestion).toMatchObject({
      id: "question_turn_1_call_1",
      status: "pending",
      question: "Which output contract should this Agent expose?",
    });
    const html = renderToStaticMarkup(createElement(MessageRow, {
      message: messages[0]!,
      onResolveUserQuestion: async () => undefined,
    }));
    expect(html).toContain("Which output contract should this Agent expose?");
    expect(html).toContain("Markdown");
    expect(html).toContain("JSON");
    expect(html).toContain("Dismiss question");
    expect(html).not.toContain("Goal");
  });

  test("restores the durable answer onto the same projected question", () => {
    const messages = buildChatMessages([
      askedEvent(),
      {
        id: "event_answered",
        sessionId: "session_1",
        turnId: "turn_2",
        name: "user_question.answered",
        timestamp: "2026-07-27T10:01:00.000Z",
        source: "ui_button",
        action: "ask_user",
        status: "completed",
        output: "JSON",
        data: {
          resolution: {
            questionId: "question_turn_1_call_1",
            action: "answer",
            optionId: "json",
            text: "JSON",
          },
        },
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.userQuestion).toMatchObject({
      status: "answered",
      answer: { optionId: "json", text: "JSON" },
      answeredAt: "2026-07-27T10:01:00.000Z",
    });
    const html = renderToStaticMarkup(createElement(MessageRow, {
      message: messages[0]!,
    }));
    expect(html).toContain("Answered: JSON");
    expect(html).not.toContain("Dismiss question");
  });
});

function askedEvent(): RuntimeEvent {
  return {
    id: "event_asked",
    sessionId: "session_1",
    turnId: "turn_1",
    name: "user_question.asked",
    timestamp: "2026-07-27T10:00:00.000Z",
    source: "provider",
    action: "ask_user",
    status: "pending",
    output: "Which output contract should this Agent expose?",
    data: {
      question: {
        id: "question_turn_1_call_1",
        sessionId: "session_1",
        turnId: "turn_1",
        toolCallId: "call_1",
        question: "Which output contract should this Agent expose?",
        reason: "The choice changes its public action schema.",
        options: [
          { id: "markdown", label: "Markdown", description: null },
          { id: "json", label: "JSON", description: null },
        ],
        allowFreeform: true,
        status: "pending",
        answer: null,
        createdAt: "2026-07-27T10:00:00.000Z",
        answeredAt: null,
      },
    },
  };
}
