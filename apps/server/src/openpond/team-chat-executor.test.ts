import { describe, expect, vi, test } from "vitest";

import { createTeamChatPartialPublisher } from "./team-chat-executor.js";
import type { teamChatRequestPayload } from "./team-chat-client.js";

describe("team chat AI partial publisher", () => {
  test("coalesces token deltas into bounded hosted snapshots", async () => {
    let now = 1_000;
    const requestMock = vi.fn(async (_action: Parameters<typeof teamChatRequestPayload>[0]) => ({
      sequence: 0,
    }));
    const request = requestMock as unknown as typeof teamChatRequestPayload;
    const publisher = createTeamChatPartialPublisher({
      teamId: "team_1",
      turnId: "turn_1",
      request,
      now: () => now,
    });

    await publisher.append("a");
    await publisher.append("ab");
    await publisher.append("abc");
    expect(requestMock).toHaveBeenCalledTimes(1);

    await publisher.flush();
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[1]?.[0]).toMatchObject({
      type: "ai_turn_partial",
      body: "abc",
    });

    now += 800;
    await publisher.append("abcd");
    expect(requestMock).toHaveBeenCalledTimes(3);
  });
});
