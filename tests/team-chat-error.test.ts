import { describe, expect, test } from "vitest";

import { teamChatErrorMessage } from "../apps/web/src/lib/team-chat-error";

describe("team chat error messages", () => {
  test("maps member limits to owner-directed guidance", () => {
    expect(teamChatErrorMessage(new Error("member_opchat_quota_exceeded"))).toBe(
      "You reached your workspace member OpChat limit. Ask the workspace owner to adjust it.",
    );
    expect(teamChatErrorMessage(new Error("member_spend_cap_exceeded"))).toBe(
      "You reached your workspace member spending limit. Ask the workspace owner to adjust it.",
    );
  });

  test("maps workspace credit and membership errors", () => {
    expect(teamChatErrorMessage(new Error("workspace_prepaid_credit_required"))).toBe(
      "This workspace needs more prepaid credits. Ask the workspace owner to add credits.",
    );
    expect(teamChatErrorMessage(new Error("team_chat_team_not_found"))).toBe(
      "You no longer have access to this workspace.",
    );
  });

  test("keeps unknown server errors intact", () => {
    expect(teamChatErrorMessage(new Error("unexpected_failure"))).toBe("unexpected_failure");
  });
});
