import { describe, expect, vi, test } from "vitest";

import type { ManagedEventWebSocket } from "../apps/web/src/api/managed-event-websocket";
import { openTeamChatRealtime } from "../apps/web/src/api/team-chat-realtime";

class FakeWebSocket implements ManagedEventWebSocket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }

  disconnect(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "network" } as CloseEvent);
  }
}

const session = {
  httpUrl: "https://example.appsync-api.us-east-2.amazonaws.com/event",
  realtimeUrl: "wss://example.appsync-realtime-api.us-east-2.amazonaws.com/event/realtime",
  region: "us-east-2",
  token: "opsvc_token.signature",
  expiresAt: "2026-07-09T13:00:00.000Z",
  teamId: "team_1",
  userId: "user_1",
};

describe("team chat managed realtime client", () => {
  test("uses one native socket for the user and unique thread subscriptions", () => {
    const sockets: FakeWebSocket[] = [];
    const onEvent = vi.fn(() => undefined);
    const onReady = vi.fn(() => undefined);
    const handle = openTeamChatRealtime(
      {
        session,
        threadIds: ["thread_2", "thread_1", "thread_1"],
        onEvent,
        onReady,
      },
      (url, protocols) => {
        const socket = new FakeWebSocket(url, protocols);
        sockets.push(socket);
        return socket;
      },
    );

    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    expect(socket.url).toBe(session.realtimeUrl);
    expect(socket.protocols[0]).toBe("aws-appsync-event-ws");
    expect(decodeAuthProtocol(socket.protocols[1]!)).toEqual({
      Authorization: session.token,
      host: "example.appsync-api.us-east-2.amazonaws.com",
    });

    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: "connection_init" });
    socket.message({ type: "connection_ack", connectionTimeoutMs: 300_000 });

    const subscriptions = socket.sent.slice(1).map((value) => JSON.parse(value));
    expect(subscriptions.map((value) => value.channel)).toEqual([
      "/team-chat/users/user_1/team_1",
      "/team-chat/threads/thread_2",
      "/team-chat/threads/thread_1",
    ]);
    expect(subscriptions.every((value) => value.type === "subscribe")).toBe(true);
    expect(subscriptions[0]?.authorization).toEqual({
      Authorization: session.token,
      host: "example.appsync-api.us-east-2.amazonaws.com",
    });

    for (const subscription of subscriptions) {
      socket.message({ type: "subscribe_success", id: subscription.id });
    }
    socket.message({ type: "subscribe_success", id: subscriptions[0]!.id });
    expect(onReady).toHaveBeenCalledTimes(1);

    socket.message({
      type: "data",
      id: subscriptions[1]!.id,
      event: JSON.stringify({
        id: 42,
        teamId: "team_1",
        threadId: "thread_1",
        conversationId: null,
        type: "read.updated",
        payload: { userId: "user_2", sequence: 4 },
        createdAt: "2026-07-09T12:00:00.000Z",
      }),
    });
    expect(onEvent).toHaveBeenCalledTimes(1);

    handle.close();
    expect(socket.sent.slice(-3).map((value) => JSON.parse(value).type)).toEqual([
      "unsubscribe",
      "unsubscribe",
      "unsubscribe",
    ]);
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "Client closed" }]);
  });

  test("reconnects after an unexpected close", async () => {
    const sockets: FakeWebSocket[] = [];
    const handle = openTeamChatRealtime(
      { session, threadIds: [], onEvent: () => undefined },
      (url, protocols) => {
        const socket = new FakeWebSocket(url, protocols);
        sockets.push(socket);
        return socket;
      },
      { reconnectDelayMs: () => 0 },
    );
    sockets[0]!.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sockets).toHaveLength(2);
    handle.close();
  });
});

function decodeAuthProtocol(protocol: string): unknown {
  const encoded = protocol.slice("header-".length).replaceAll("-", "+").replaceAll("_", "/");
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  return JSON.parse(atob(padded));
}
