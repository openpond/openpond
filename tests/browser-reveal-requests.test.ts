import { describe, expect, test } from "bun:test";
import { browserRevealDecision } from "../apps/web/src/hooks/useBrowserRevealRequests";

describe("browser reveal requests", () => {
  test("reveals the current browser conversation", () => {
    expect(
      browserRevealDecision({
        currentConversationId: "session_1",
        requestConversationId: "session_1",
        sessionIds: ["session_1", "session_2"],
      }),
    ).toEqual({ reveal: true, sessionIdToOpen: null });
  });

  test("opens known session conversations before revealing", () => {
    expect(
      browserRevealDecision({
        currentConversationId: "session_1",
        requestConversationId: "session_2",
        sessionIds: ["session_1", "session_2"],
      }),
    ).toEqual({ reveal: true, sessionIdToOpen: "session_2" });
  });

  test("ignores reveal requests for unknown conversations", () => {
    expect(
      browserRevealDecision({
        currentConversationId: "session_1",
        requestConversationId: "draft:unknown",
        sessionIds: ["session_1", "session_2"],
      }),
    ).toEqual({ reveal: false, sessionIdToOpen: null });
  });
});
