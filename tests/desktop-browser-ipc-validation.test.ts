import { describe, expect, test } from "vitest";

import {
  isTrustedBrowserIpcFrameUrl,
  parseBrowserBoundsInput,
  parseBrowserConversationInput,
  parseBrowserNavigateInput,
  parseBrowserNewTabInput,
  parseBrowserOpenExternalInput,
  parseBrowserTabInput,
  parseBrowserUrlInput,
} from "../apps/desktop/src/desktop-browser-ipc-validation";

describe("desktop browser IPC validation", () => {
  test("normalizes valid browser IPC payloads", () => {
    expect(parseBrowserConversationInput({ conversationId: " conversation-1 " })).toEqual({ conversationId: "conversation-1" });
    expect(parseBrowserTabInput({ conversationId: "conversation-1", tabId: " tab-1 " })).toEqual({
      conversationId: "conversation-1",
      tabId: "tab-1",
    });
    expect(parseBrowserUrlInput({ conversationId: "conversation-1", url: " https://example.test ", explicitFile: true })).toEqual({
      conversationId: "conversation-1",
      url: "https://example.test",
      explicitFile: true,
    });
    expect(parseBrowserNewTabInput({ conversationId: "conversation-1", explicitFile: false })).toEqual({
      conversationId: "conversation-1",
      explicitFile: false,
    });
    expect(parseBrowserNavigateInput({ conversationId: "conversation-1", tabId: "tab-1", url: "https://example.test" })).toEqual({
      conversationId: "conversation-1",
      tabId: "tab-1",
      url: "https://example.test",
    });
    expect(parseBrowserBoundsInput({ conversationId: "conversation-1", bounds: { x: 1, y: 2, width: 300, height: 200 } })).toEqual({
      conversationId: "conversation-1",
      bounds: { x: 1, y: 2, width: 300, height: 200 },
    });
  });

  test("selects tab or URL input shape for open external requests", () => {
    expect(parseBrowserOpenExternalInput({ conversationId: "conversation-1", tabId: "tab-1", url: "https://ignored.test" })).toEqual({
      conversationId: "conversation-1",
      tabId: "tab-1",
    });
    expect(parseBrowserOpenExternalInput({ conversationId: "conversation-1", url: "https://example.test" })).toEqual({
      conversationId: "conversation-1",
      url: "https://example.test",
    });
  });

  test("rejects malformed browser IPC payloads", () => {
    expect(() => parseBrowserConversationInput(null)).toThrow("IPC payload must be an object.");
    expect(() => parseBrowserConversationInput({ conversationId: "" })).toThrow("conversationId is required.");
    expect(() => parseBrowserConversationInput({ conversationId: "x".repeat(201) })).toThrow("conversationId is too long.");
    expect(() => parseBrowserTabInput({ conversationId: "conversation-1", tabId: 42 })).toThrow("tabId must be a string.");
    expect(() => parseBrowserUrlInput({ conversationId: "conversation-1", url: "x".repeat(4097) })).toThrow("url is too long.");
    expect(() => parseBrowserBoundsInput({ conversationId: "conversation-1", bounds: { x: 0, y: 0, width: 0, height: 10 } })).toThrow(
      "bounds.width and bounds.height must be positive.",
    );
    expect(() =>
      parseBrowserBoundsInput({ conversationId: "conversation-1", bounds: { x: Number.NaN, y: 0, width: 10, height: 10 } }),
    ).toThrow("bounds.x must be a finite number.");
  });

  test("allows only packaged or loopback renderer frame URLs", () => {
    expect(isTrustedBrowserIpcFrameUrl("file:///opt/OpenPond/index.html")).toBe(true);
    expect(isTrustedBrowserIpcFrameUrl("app://openpond/index.html")).toBe(true);
    expect(isTrustedBrowserIpcFrameUrl("http://127.0.0.1:17876/")).toBe(true);
    expect(isTrustedBrowserIpcFrameUrl("https://localhost:17876/")).toBe(true);
    expect(isTrustedBrowserIpcFrameUrl("http://[::1]:17876/")).toBe(true);
    expect(isTrustedBrowserIpcFrameUrl("https://evil.example/")).toBe(false);
    expect(isTrustedBrowserIpcFrameUrl("about:blank")).toBe(false);
    expect(isTrustedBrowserIpcFrameUrl("data:text/html,hello")).toBe(false);
    expect(isTrustedBrowserIpcFrameUrl("not a url")).toBe(false);
  });
});
