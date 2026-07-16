import { describe, expect, vi, test } from "vitest";
import type { ManagedEventWebSocket } from "../apps/web/src/api/managed-event-websocket";
import { openCommunityRealtime } from "../apps/web/src/api/community-realtime";

class FakeWebSocket implements ManagedEventWebSocket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({} as Event); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
}

describe("community realtime", () => {
  test("subscribes only to the authorized per-user community channel", () => {
    let socket: FakeWebSocket | null = null;
    const onEvent = vi.fn(() => undefined);
    const handle = openCommunityRealtime({
      session: {
        httpUrl: "https://example.appsync-api.us-east-2.amazonaws.com/event",
        realtimeUrl: "wss://example.appsync-realtime-api.us-east-2.amazonaws.com/event/realtime",
        region: "us-east-2", token: "token", expiresAt: "2026-07-15T13:00:00.000Z",
        communityId: "community_1", userId: "user_1",
        channel: "/team-chat/community-users/user_1/community_1",
      },
      onEvent,
    }, (url, protocols) => {
      socket = new FakeWebSocket();
      void url; void protocols;
      return socket;
    });
    const current = socket as FakeWebSocket | null;
    expect(current).not.toBeNull();
    current!.open();
    current!.message({ type: "connection_ack", connectionTimeoutMs: 300_000 });
    const subscription = JSON.parse(current!.sent[1]!);
    expect(subscription.channel).toBe("/team-chat/community-users/user_1/community_1");
    current!.message({ type: "subscribe_success", id: subscription.id });
    current!.message({
      type: "data", id: subscription.id,
      event: JSON.stringify({
        id: 7, communityId: "community_1", channelId: "channel_1", threadId: "thread_1",
        type: "message.created", payload: {}, createdAt: "2026-07-15T12:00:00.000Z",
      }),
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    handle.close();
  });
});
