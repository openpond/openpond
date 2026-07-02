import type { IncomingMessage } from "node:http";

import { describe, expect, test } from "bun:test";

import {
  hasTerminalWebSocketAuth,
  terminalWebSocketProtocolToken,
} from "../apps/server/src/runtime/terminal-sessions";
import { terminalWebSocketProtocols, terminalWebSocketUrl } from "../apps/web/src/api/api-client";

function requestWithProtocol(protocol: string): IncomingMessage {
  return {
    headers: {
      "sec-websocket-protocol": protocol,
    },
  } as IncomingMessage;
}

describe("terminal websocket auth", () => {
  test("uses subprotocol auth instead of query-string tokens", () => {
    const connection = {
      serverUrl: "http://127.0.0.1:17874/",
      token: "local terminal token",
      platform: "linux",
    };
    const protocols = terminalWebSocketProtocols(connection);

    expect(terminalWebSocketUrl(connection)).toBe("ws://127.0.0.1:17874/v1/terminal");
    expect(terminalWebSocketUrl(connection)).not.toContain("token=");
    expect(protocols[0]).toBe("openpond-terminal");
    expect(protocols.join(",")).not.toContain(connection.token);
    expect(protocols[1]).toMatch(/^openpond-token\./);
  });

  test("authenticates websocket upgrade requests from the token subprotocol", () => {
    const connection = {
      serverUrl: "http://127.0.0.1:17874",
      token: "local terminal token",
      platform: "linux",
    };
    const request = requestWithProtocol(terminalWebSocketProtocols(connection).join(", "));
    const requestUrl = new URL("http://127.0.0.1:17874/v1/terminal");

    expect(terminalWebSocketProtocolToken(request)).toBe(connection.token);
    expect(hasTerminalWebSocketAuth(request, requestUrl, connection.token)).toBe(true);
  });

  test("rejects missing or mismatched websocket auth", () => {
    const requestUrl = new URL("http://127.0.0.1:17874/v1/terminal");

    expect(hasTerminalWebSocketAuth({ headers: {} } as IncomingMessage, requestUrl, "expected-token")).toBe(false);
    expect(
      hasTerminalWebSocketAuth(
        requestWithProtocol(terminalWebSocketProtocols({
          serverUrl: "http://127.0.0.1:17874",
          token: "wrong-token",
          platform: "linux",
        }).join(", ")),
        requestUrl,
        "expected-token",
      ),
    ).toBe(false);
  });
});
